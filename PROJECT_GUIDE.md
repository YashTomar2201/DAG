# PROJECT GUIDE — Distributed Visual Workflow (DAG) Engine

> **Read this file first.** Every workflow phase in `.antigravity/workflows/build-dag-engine.md`
> assumes the conventions, data model, and vocabulary defined here. If a workflow step and this
> guide disagree, this guide wins — and the agent should flag the contradiction instead of guessing.

---

## 1. What we are building

A distributed, highly concurrent execution engine that lets users **visually build, validate, and run
Directed Acyclic Graph (DAG) workflows**. It is a lightweight, purpose-built alternative to Apache
Airflow / AWS Step Functions, focused on three things those tools make you configure rather than
understand:

1. **Correct execution order** derived algorithmically (topological sort), not hand-written.
2. **Horizontal scale** via a decoupled control plane / data plane split over Redis.
3. **Fault tolerance** — retries, backoff, idempotency, and crash recovery as first-class features.

### Reference use case (drives every design decision)

A user drags out this ML pipeline on the canvas:

| # | Node | Depends on | What it actually does |
|---|------|-----------|----------------------|
| 1 | `extract` | — | Pull a raw image dataset from a Kaggle environment |
| 2 | `preprocess` | 1 | Run a `pandas` script: clean file paths, normalize image data, emit `metadata.csv` |
| 3 | `train` | 2 | Kick off the training loop (custom architectures / hybrid loss functions) |
| 4 | `evaluate` | 3 | Run validation metrics against the output weights |
| 5 | `deploy` | 4 | Push the final model to a production registry |

**The guarantee:** `train` never starts until `metadata.csv` is fully written and its parent node is
strictly `SUCCEEDED`. Independent branches run in parallel. A worker crash mid-`train` does not lose
the run.

---

## 2. Tech stack (fixed — do not substitute without an ADR)

| Domain | Technology | Purpose |
|---|---|---|
| Frontend UI | React 18, TypeScript, Vite, Zustand | Component rendering + global state |
| Graph rendering | React Flow (`@xyflow/react`) | Canvas-based node/edge manipulation |
| Backend API | Node.js 20+, Express.js, TypeScript | REST routing + topological orchestration |
| Database | PostgreSQL 16, Prisma ORM | Workflows, runs, node runs, audit log |
| Message broker | Redis 7 | Task queuing, atomic counters, pub/sub |
| Job processor | BullMQ | Reliable execution, retries, backoff, stalled-job recovery |
| Validation | Zod | One schema source shared by API + web |
| Python bridge | `child_process.spawn` + JSON stdio | Runs `pandas` / training scripts |
| Testing | Vitest, Supertest, Testcontainers | Unit, integration, chaos tests |
| Packaging | pnpm workspaces, Docker Compose | Monorepo + local distributed cluster |

---

## 3. Repository layout

```
dag-engine/
├─ apps/
│  ├─ web/                  React + Vite + Zustand + React Flow (visual editor)
│  ├─ api/                  Express control plane (validation, orchestration, SSE)
│  └─ worker/               BullMQ consumers (data plane)
├─ packages/
│  ├─ graph-core/           Pure, dependency-free graph algorithms (shared web ↔ api)
│  ├─ contracts/            Zod schemas + inferred TS types (the wire contract)
│  └─ db/                   Prisma schema, migrations, generated client
├─ python/                  preprocess.py, train.py, evaluate.py (executor scripts)
├─ docs/
│  ├─ architecture/         ADR-001-*.md … written by the tech-lead subagent
│  ├─ deep-dives/           Line-by-line code explanations (tech-lead)
│  └─ interview/            Q&A packs per phase (tech-lead)
├─ infra/
│  ├─ docker-compose.yml    postgres + redis + api + worker×N + web
│  └─ Dockerfile.*
└─ .antigravity/workflows/build-dag-engine.md
```

**Rule:** `packages/graph-core` must have **zero runtime dependencies** — no Prisma, no Redis, no
Express. It is pure functions over plain objects so the browser and the server can both import it and
give the user identical validation results.

---

## 4. The three-layer architecture

### Layer 1 — Control Plane (`apps/api`)
- Receives the JSON graph payload from the frontend.
- Runs **cycle detection (DFS)** and **topological sort (Kahn's algorithm)**.
- Persists the graph and every state transition to PostgreSQL.
- Computes which nodes have in-degree `0` and dispatches them immediately.
- Listens for completion events, decrements child dependency counters, dispatches newly unlocked nodes.
- **Never executes user task logic.** It only decides *what runs next*.

### Layer 2 — Message Broker (Redis + BullMQ)
- Durable job queues (`queue:io`, `queue:cpu`, `queue:gpu`).
- Atomic in-degree counters per run (Lua-scripted, see §7).
- Pub/sub channel `run:{runId}:events` for live UI updates.
- Guarantees fair distribution and no job loss if a worker dies.

### Layer 3 — Data Plane (`apps/worker`)
- N independent processes consuming from Redis.
- Resolves a node's inputs from its parents' outputs, executes the task, writes the output back.
- Reports terminal status; the control plane reacts and unlocks children.

```
 React Flow canvas
        │  POST /workflows/:id/runs
        ▼
 ┌──────────────────┐   enqueue    ┌─────────┐   consume   ┌────────────┐
 │  Control Plane   │─────────────▶│  Redis  │◀───────────▶│  Worker ×N │
 │  (Express + PG)  │              │ BullMQ  │             │  (exec)    │
 └──────────────────┘◀─────────────└─────────┘─────────────└────────────┘
        │   completion event → decrement in-degree → enqueue unlocked children
        ▼
   PostgreSQL (Run, NodeRun, RunEvent)   ──SSE──▶  browser live status
```

---

## 5. Core vocabulary (use these exact terms in code and docs)

| Term | Meaning |
|---|---|
| **Workflow** | A named, versioned container owned by a tenant |
| **WorkflowVersion** | An immutable snapshot of a graph. Runs always reference a version, never a mutable graph |
| **NodeDef / EdgeDef** | The *design-time* graph: what the user drew |
| **Run** | One execution of a WorkflowVersion |
| **NodeRun** | One execution of one node inside a Run. The unit of work a job maps to |
| **in-degree** | Number of unfinished parents a node is waiting on |
| **ready set** | Nodes whose in-degree has reached 0 and are eligible to dispatch |
| **dispatch** | Control plane pushing a NodeRun onto a Redis queue |
| **lease** | The time-bounded lock a worker holds on a job (BullMQ `lockDuration`) |
| **artifact** | A large output (dataset, `metadata.csv`, weights) stored *by reference*, not inline |

### NodeRun state machine (the only legal transitions)

```
PENDING ──▶ QUEUED ──▶ RUNNING ──▶ SUCCEEDED
   │           │          │
   │           │          ├──▶ FAILED (attempts exhausted / unrecoverable)
   │           │          └──▶ QUEUED (retry, attempt++)
   │           └──────────────▶ CANCELLED
   └──────────────────────────▶ SKIPPED   (an ancestor FAILED)
```

`SUCCEEDED`, `FAILED`, `SKIPPED`, `CANCELLED` are terminal. Any code path that writes a status must
be a **conditional update** guarded on the expected current status (see §7).

---

## 6. Data model (Prisma — canonical shape)

```prisma
model Tenant          { id String @id @default(cuid()) name String  workflows Workflow[] }

model Workflow        { id String @id @default(cuid()) tenantId String name String
                        versions WorkflowVersion[]  createdAt DateTime @default(now()) }

model WorkflowVersion { id String @id @default(cuid()) workflowId String version Int
                        graph Json            // { nodes: NodeDef[], edges: EdgeDef[] }
                        topoOrder Json        // cached Kahn's output + parallel levels
                        createdAt DateTime @default(now())
                        @@unique([workflowId, version]) }

model Run             { id String @id @default(cuid()) workflowVersionId String
                        status RunStatus @default(PENDING)
                        idempotencyKey String? @unique
                        triggeredBy String  startedAt DateTime? finishedAt DateTime?
                        nodeRuns NodeRun[]  events RunEvent[] }

model NodeRun         { id String @id @default(cuid()) runId String
                        nodeKey String        // stable user-facing key, e.g. "preprocess"
                        status NodeStatus @default(PENDING)
                        attempt Int @default(0)
                        input Json?  output Json?  error Json?
                        workerId String?  leaseExpiresAt DateTime?
                        startedAt DateTime? finishedAt DateTime?
                        @@unique([runId, nodeKey])   // ← the anti-duplicate-execution invariant
                        @@index([runId, status]) }

model RunEvent        { id BigInt @id @default(autoincrement()) runId String
                        nodeKey String? type String payload Json
                        createdAt DateTime @default(now())
                        @@index([runId, id]) }       // append-only audit log
```

`@@unique([runId, nodeKey])` is not a nicety — it is the database-level backstop that makes
double execution impossible even if the Redis layer misbehaves.

---

## 7. The five hard problems (and their required solutions)

These are the parts that make this project a systems-engineering project rather than CRUD. The agent
must implement them **exactly as specified** unless it writes an ADR arguing otherwise.

### 7.1 Cycle detection — iterative DFS with tri-colour marking
- WHITE = unvisited, GRAY = on the current recursion stack, BLACK = fully explored.
- Hitting a GRAY node = back edge = **cycle**.
- Must be **iterative** (explicit stack), not recursive — a 10 000-node chain must not blow the JS stack.
- Must return the **actual cycle path** (`["a","b","c","a"]`) so the UI can highlight those edges in red.

### 7.2 Topological sort — Kahn's algorithm, level-grouped
- Build in-degree map → seed a queue with all `in-degree === 0` nodes → pop, append to order,
  decrement children, push newly-zeroed children.
- If `order.length !== nodes.length`, a cycle exists (this is the second, independent cycle check).
- Emit **levels/waves** (all nodes at BFS depth *k*), because level width = the maximum available
  parallelism, which the UI visualizes and the scheduler uses for concurrency planning.

### 7.3 Race conditions on dependency resolution — atomic Lua decrement
The killer bug: node `D` depends on `B` and `C`. Both finish at the same millisecond on two different
workers. Both read `remaining = 1`, both write `0`, both dispatch `D`. **`D` runs twice.**

Required fix — a single round-trip Lua script so the decrement-and-test is atomic:

```lua
-- KEYS[1] = run:{runId}:indegree   (hash: nodeKey -> remaining parents)
-- KEYS[2] = run:{runId}:dispatched (set of already-dispatched nodeKeys)
-- ARGV[1] = childKey
local remaining = redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
if remaining > 0 then return 0 end
if redis.call('SADD', KEYS[2], ARGV[1]) == 0 then return 0 end  -- someone already dispatched
return 1                                                        -- caller owns the dispatch
```

Defence in depth — all four layers required:
1. Lua atomicity (above).
2. `SADD` dispatch guard — only the first caller gets `1`.
3. BullMQ deterministic `jobId = "{runId}:{nodeKey}:{attempt}"` — the queue rejects duplicates.
4. Conditional SQL: `UPDATE "NodeRun" SET status='QUEUED' WHERE id=$1 AND status='PENDING'` —
   if `rowCount === 0`, another actor won; abort silently.

### 7.4 Context passing — outputs by value, artifacts by reference
- A worker returns a **small JSON object** (`≤ 64 KB`, enforced) into `NodeRun.output`.
- Large data (`metadata.csv`, dataset dirs, `.pt` weights) is written to the shared artifact volume and
  referenced by URI: `{ "metadataPath": "artifacts/{runId}/preprocess/metadata.csv", "rows": 48213 }`.
- Child inputs are declared with templates resolved **at dispatch time** by the control plane:
  `{ "csv": "{{ nodes.preprocess.output.metadataPath }}" }`.
- Unresolvable reference = dispatch-time failure with a clear error, never a silent `undefined`.

### 7.5 Retries, backoff, idempotency
- BullMQ: `attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }`, plus **jitter** via a custom
  backoff strategy so N retrying workers don't stampede Kaggle simultaneously.
- Error taxonomy: `RetryableError` (network timeout, 429, transient FS) vs BullMQ's
  `UnrecoverableError` (bad config, missing script, Python `SyntaxError`) — the latter fails instantly
  without burning retries.
- **Idempotency contract for every executor:** write to `*.tmp` then atomically rename; before doing
  work, check whether the expected artifact already exists for `{runId}:{nodeKey}` and short-circuit.
  A retry after a partial write must never leave a half-written `metadata.csv`.
- Crash recovery: BullMQ `stalledInterval` + `maxStalledCount` re-queue jobs whose lease expired —
  this is what saves the run when a worker is `SIGKILL`ed mid-training.
- Failure propagation: on terminal node failure, BFS all descendants → `SKIPPED`, run → `FAILED`.

---

## 8. Conventions the agent must follow

- **TypeScript strict mode everywhere.** No `any` in `graph-core` or `contracts`.
- **Zod-first:** define the schema in `packages/contracts`, infer the TS type from it
  (`z.infer<typeof X>`). Never hand-write a type that duplicates a schema.
- **No business logic in Express route handlers** — routes parse/validate and delegate to a service.
- **Every status write is a conditional update** guarded on the expected prior state.
- **Structured logging only:** `logger.info({ runId, nodeKey, attempt, event }, 'message')`. Every log
  line inside a run must carry `runId`. No bare `console.log` outside scripts.
- **Env vars** via a single validated `env.ts` per app (Zod-parsed at boot, crash on missing).
- Commit style: `feat(scope): …`, `fix(scope): …`, one commit per completed phase.

---

## 9. The tech-lead subagent protocol

A custom subagent named **`tech-lead`** exists in this workspace. Its sole job:
**explain the code, document architectural decisions, and generate interview Q&A.**

**The main agent must pause at every `Checkpoint:` bullet and invoke `tech-lead` before starting the
next phase.** Do not batch checkpoints. Do not skip one because the phase "was simple."

When invoking, pass the subagent: (a) the phase number and name, (b) the list of files created or
changed in that phase, (c) the specific questions listed in the checkpoint bullet.

The tech-lead writes three artifact types:

| Type | Path | Contents |
|---|---|---|
| ADR | `docs/architecture/ADR-00N-<slug>.md` | Context → Decision → Alternatives rejected → Consequences |
| Deep dive | `docs/deep-dives/phase-NN-<topic>.md` | Walkthrough of the actual code, why each library call was chosen |
| Interview Q&A | `docs/interview/phase-NN-qa.md` | 8–12 Q&A pairs: theory, "why not X", and a failure-mode question |

**ADR template**

```markdown
# ADR-00N: <Title>
- Status: Accepted | Superseded by ADR-00M
- Date: YYYY-MM-DD
- Phase: <workflow phase>

## Context
What forced a decision here? What constraint or failure mode?

## Decision
What we chose, concretely, with the exact API/library/pattern.

## Alternatives considered
| Option | Why rejected |

## Consequences
What this buys us. What it costs us. What breaks if load increases 100×.

## Interview framing
The 60-second verbal answer to "why did you build it that way?"
```

**Quality bar for interview Q&A:** every pack must include at least one question of each kind —
(1) an algorithm/complexity question, (2) a "why this library over the obvious alternative"
question, (3) a failure/race-condition question with the concrete interleaving that breaks a naive
implementation.

---

## 10. Definition of Done (per phase)

A phase is not complete until **all** of these hold:

1. `pnpm -r typecheck` passes with zero errors.
2. `pnpm -r lint` passes.
3. New logic has tests; `pnpm -r test` passes.
4. The phase's stated **acceptance check** has been executed and its output pasted into the agent's summary.
5. The `tech-lead` checkpoint has been invoked and its output files exist on disk.
6. Work is committed with a conventional-commit message naming the phase.

## 11. Guardrails

- **Never** run `prisma migrate reset` or `docker compose down -v` without asking — both destroy data.
- **Never** commit `.env`, Kaggle credentials, or registry tokens. `.env.example` only.
- Long-running commands (`docker compose up`, `pnpm dev`, workers) run in the background; do not block on them.
- If a phase's acceptance check fails, **stop and report the failure** — do not proceed to the next
  phase or weaken the check to make it pass.
- If a design decision in this guide turns out to be wrong during implementation, write an ADR
  proposing the change and surface it to the user; do not silently diverge.
