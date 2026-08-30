# DAG Engine — System Architecture

## Overview

The DAG Engine is a distributed, visual workflow execution system. Users build directed acyclic graph (DAG) pipelines in a drag-and-drop editor; the system validates, schedules, and executes them reliably at scale.

---

## Repository Layout (Monorepo)

```
dag-engine/
├─ apps/
│  ├─ web/       React 18 + Vite + React Flow + Zustand — the visual editor
│  ├─ api/       Express control plane — orchestration, validation, REST API
│  └─ worker/    BullMQ consumers — data plane, executes actual task logic
├─ packages/
│  ├─ graph-core/  Pure graph algorithms (ZERO runtime deps) — shared by web + api
│  ├─ contracts/   Zod schemas — single source of truth for all wire formats
│  └─ db/          Prisma ORM + repository helpers
├─ infra/          docker-compose.yml (Postgres + Redis)
├─ python/         ML executor scripts (preprocess.py, train.py, evaluate.py)
└─ docs/           ADRs, deep-dives, interview Q&A
```

---

## Three-Layer Architecture

```
React Flow Canvas
      │  POST /workflows/:id/runs
      ▼
┌──────────────────┐   enqueue   ┌─────────┐   consume   ┌────────────┐
│  Control Plane   │────────────▶│  Redis  │◀───────────▶│  Worker ×N │
│  (Express + PG)  │             │ BullMQ  │             │  (exec)    │
└──────────────────┘◀────────────└─────────┘─────────────└────────────┘
       │  completion event → decrement in-degree → enqueue unlocked children
       ▼
  PostgreSQL (Run, NodeRun, RunEvent)  ──SSE──▶  browser live status
```

### Layer 1 — Control Plane (`apps/api`)
- Receives graph JSON from the frontend
- Runs cycle detection (DFS) and topological sort (Kahn's)
- Persists graph versions as immutable snapshots
- Dispatches ready nodes to Redis; reacts to completions; unlocks children
- **Never executes user task logic**

### Layer 2 — Message Broker (Redis + BullMQ)
- Durable job queues: `queue:io`, `queue:cpu`, `queue:gpu`
- Atomic in-degree counters (Lua scripts) to prevent double-dispatch
- Pub/sub channel `run:{runId}:events` for live browser updates

### Layer 3 — Data Plane (`apps/worker`)
- N independent worker processes consuming from Redis
- Executes tasks (Python scripts via child_process.spawn)
- Reports terminal status; control plane reacts and unlocks children

---

## Key Design Decisions (Phase 0)

### Why a pnpm workspace monorepo?
`graph-core` must be imported by **both** `apps/web` (browser, bundled by Vite) and `apps/api` (Node.js). A workspace `workspace:*` dependency resolves directly to the TypeScript source — no publish step, no version drift.

### Why `graph-core` has zero runtime dependencies
Any runtime dep in `graph-core` would be pulled into the browser bundle. A Node.js-only package (like `ioredis`) would cause Vite to fail. Zero deps = unconditional importability in any JS environment.

### Why Redis uses `appendonly yes`
Default RDB snapshots lose all writes between snapshot intervals. For a job queue, this means lost `NodeRun` jobs on Redis restart — runs stall silently. AOF persists every write to disk; Redis replays it on restart. No job loss.

### Why env vars are Zod-parsed at boot
`process.env` is `string | undefined`. Ad-hoc reads cause silent failures deep in connection setup. Zod parsing at boot crashes loudly with a structured error listing exactly which variables are missing.

---

## Wire Contracts (`packages/contracts`) — Phase 1

All wire formats are Zod schemas; types are inferred with `z.infer<>`. Nothing is hand-typed.

| Schema | What it describes |
|--------|-------------------|
| `NodeDefSchema` | Discriminated union on `type` — each node type has its own typed `config` |
| `EdgeDefSchema` | A directed edge between two node keys (`from`, `to`) |
| `GraphSchema` | `{ nodes, edges }` with 4 structural refinements via `.superRefine()` |
| `NodeStatusSchema` | 7-value enum: PENDING→QUEUED→RUNNING→SUCCEEDED/FAILED/SKIPPED/CANCELLED |
| `RunStatusSchema` | 5-value enum for the overall run |
| `JobPayloadSchema` | BullMQ queue message: runId, nodeKey, nodeRunId, type, config, input, attempt |
| `RunEventSchema` | SSE + pub/sub envelope: runId, nodeKey?, type, payload, ts |
| `ErrorTaxonomySchema` | retryable vs. unrecoverable error classification |

**Structural Rules Enforced in `GraphSchema`:**
- ✅ Node keys unique within the graph
- ✅ Every edge endpoint refers to an existing node (no dangling edges)
- ✅ No self-loops (from ≠ to)
- ✅ No duplicate edges
- ✅ Node count ≤ 200
- ❌ Cycle detection — deferred to Phase 2 (`detectCycle`); requires graph traversal, not schema validation

---

## Graph Algorithms (`packages/graph-core`) — Phase 2

This package has **zero runtime dependencies** and exports pure functions for graph traversal. It operates purely on the `Graph` contract.

| Algorithm | Function | Purpose |
|-----------|----------|---------|
| **Adjacency Builder** | `buildAdjacencyMap(graph)` | Single-pass helper that returns `adj: Map<node, children[]>` and `inDegree: Map<node, count>`. |
| **Cycle Detection** | `detectCycle(graph)` | Iterative 3-state (WHITE/GRAY/BLACK) DFS. Returns `{ hasCycle: boolean, path?: string[] }`. |
| **Topological Sort** | `topologicalSort(graph)` | Kahn's algorithm. Returns `{ order, tiers }`. Evaluates nodes with 0 in-degree, grouping them into concurrent tiers. |

**Key Properties:**
- `detectCycle` uses an explicit stack (`[nodeKey, childIndex][]`) to prevent call stack overflows on extremely deep linear graphs.
- `topologicalSort` groups nodes into `tiers` — arrays of nodes that have no interdependencies and can be safely dispatched to BullMQ simultaneously.


## Persistence Layer (`packages/db`) — Phase 3

All database access is routed through repository helpers in `packages/db/src/repositories.ts`. Apps **never** call Prisma directly.

### The 6 Models

| Model | What it represents |
|-------|--------------------|
| `Tenant` | Top-level namespace — isolates workflows per customer/team |
| `Workflow` | A named, mutable container. Stores the workflow name; graph is always in a version. |
| `WorkflowVersion` | Immutable snapshot of a graph (`{ nodes, edges }`) plus the pre-computed `topoOrder`. Runs pin a version id. |
| `Run` | One execution of a `WorkflowVersion`. Carries status, optional `idempotencyKey`, and timing. |
| `NodeRun` | One execution of one node inside a run — the atomic unit a BullMQ job maps to. |
| `RunEvent` | Append-only audit log. Every state transition is written here. Also the SSE replay source. |

### NodeRun State Machine

```
PENDING ──▶ QUEUED ──▶ RUNNING ──▶ SUCCEEDED
   │           │          │
   │           │          ├──▶ FAILED (attempts exhausted / unrecoverable)
   │           │          └──▶ QUEUED  (retry, attempt++)
   │           └──────────────▶ CANCELLED
   └──────────────────────────▶ SKIPPED (an ancestor FAILED)
```

Terminal states: `SUCCEEDED`, `FAILED`, `SKIPPED`, `CANCELLED`. Once a NodeRun reaches a terminal state it must never transition again.

### Critical DB Constraints

**`@@unique([runId, nodeKey])` on `NodeRun`**
Even if the Redis dispatch guard (Lua script) misbehaves, Postgres will reject a second `INSERT` for the same `(runId, nodeKey)` pair. This is the last line of defence against double-execution.

**`@@index([runId, status])` on `NodeRun`**
The hot orchestrator query: "how many non-terminal NodeRuns remain in run X?" This index makes that `COUNT` efficient.

**`@@index([runId, id])` on `RunEvent`**
The SSE tail query: `WHERE runId = ? AND id > cursor ORDER BY id ASC`. The BigInt autoincrement `id` is the monotonic cursor used by reconnecting SSE clients.

### The Conditional-Update Pattern

Every status write goes through `tryTransitionNodeRun` or `tryTransitionRun`:

```sql
UPDATE "NodeRun" SET status = $to [, ...extra]
WHERE id = $id AND status = $from
```

`updateMany` returns the number of updated rows. If `count === 0`, another actor already transitioned the row — the caller silently aborts. This prevents the lost-update race where two workers both read `RUNNING` and both attempt to write `SUCCEEDED`.

---

## Control Plane API (`apps/api`) — Phase 4

The API is the **only process that makes scheduling decisions**. It never executes user task logic — that belongs to the worker. Its sole jobs are: validate graphs, persist state, and decide what runs next.

### Layered Structure

```
Request
  │
  ▼
routes/         ← parse body, call service, return response (no logic here)
  │
  ▼
services/       ← all business logic (validate, topo-sort, DB reads/writes)
  │
  ▼
@dag/db         ← repository helpers (tryTransitionNodeRun, appendRunEvent, …)
  │
  ▼
PostgreSQL
```

**Rule:** Route handlers contain zero business logic. They parse the validated body and call exactly one service function.

### Endpoints

| Method | Path | What it does |
|--------|------|--------------|
| `POST` | `/workflows` | Create workflow + first version. Validates graph, caches `topoOrder`. |
| `POST` | `/workflows/:id/versions` | Append immutable version. Returns **422 + cyclePath** on cycle. |
| `POST` | `/workflows/:id/validate` | Dry-run validation, no persistence. Always returns 200; `valid` field indicates result. |
| `GET`  | `/runs/:id` | Run + all NodeRuns + timings for the Gantt view. |
| `GET`  | `/runs/:id/events` | SSE stream. Phase 4: replays persisted events. Phase 10: adds live pub/sub. |
| `POST` | `/runs/:id/cancel` | Cancels all non-terminal NodeRuns. Phase 6 adds BullMQ queue draining. |
| `GET`  | `/health` | Docker healthcheck probe. |

### Key Design Points

**Why topoOrder is cached at version-creation time, not at run-start time:**
Running Kahn's algorithm takes O(V+E). Under load with 1 000 concurrent runs all starting at once, doing it 1 000 times per second wastes CPU and adds latency. The version row stores `{ order, tiers }` so the scheduler reads a pre-computed array at dispatch time — O(1) lookup, no graph traversal.

**Why `POST /workflows/:id/validate` always returns HTTP 200:**
The browser editor calls this endpoint on every edge connection to give instant cycle feedback. If the endpoint returned 4xx on an invalid graph, the browser would need special-case error handling for both network errors and validation errors. Returning 200 with `{ valid: false, cyclePath }` means the client code is uniform: always read the `valid` field.

**Why app factory (`createApp()`) is separate from server startup (`index.ts`):**
Tests call `createApp()` and pass the result to Supertest — no real TCP port is bound, no DB connection is opened. If `listen()` were called at module-load time, importing the app in tests would start a server.

### Middleware Stack

```
express.json({ limit: '1mb' })   ← body parsing
  ↓
validateBody(ZodSchema)          ← rejects malformed requests before they reach the service
  ↓
route handler → service()        ← throws typed errors on failures
  ↓
errorHandler(err, req, res, next) ← maps errors to HTTP codes
    ZodError       → 400
    CycleError     → 422 + cyclePath
    NotFoundError  → 404
    ValidationError→ 400
    ConflictError  → 409
    unknown        → 500 + correlationId (logged, not leaked)
```

---

## Phase Status

| Phase | Status | Summary |
|-------|--------|--------|
| 0 — Monorepo scaffold | ✅ Complete | pnpm workspace, tsconfig, ESLint, Docker, Zod env |
| 1 — Wire contracts | ✅ Complete | Zod schemas for all wire formats, 18 tests passing |
| 2 — Graph algorithms | ✅ Complete | Iterative DFS cycle detection, Kahn's topological sort, 0 runtime deps |
| 3 — Persistence layer | ✅ Complete | Prisma schema, repository helpers, conditional-update pattern, 8 acceptance tests |
| 4 — Control plane API | ✅ Complete | Express layered API, Zod middleware, cycle→422, topoOrder cached, 10 tests |
| 5 — Redis + BullMQ | ✅ Complete | Queues, Lua atomicity, PubSub |
| 6 — Orchestrator | ✅ Complete | Dispatch loop, event processing, idempotent runs |
| 7 — Context passing | ✅ Complete | Template resolver, 64 KB output guard, 11 tests |
| 8 — Worker data plane | ✅ Complete | Executor registry, Python bridge, heartbeats, idempotency, 5 tests |
| 9 — Fault tolerance | ✅ Complete | RetryableError, jitter backoff, Redis semaphore, retry-failed route, 12 tests |
| 10 — SSE streaming | ✅ Complete | Replay+pub/sub, heartbeat, log buffering, 12 tests |
| 11 — Visual editor | ✅ Complete | React Flow UI, Zustand sliced stores, Cycle detection in browser, Config Panel |
| 12 — Testing | ✅ Complete | Testcontainers integration suite, deterministic race test, `/metrics`, scale test |
| 13 — Containerisation | ✅ Complete | Multi-stage Dockerfiles, migrate one-shot service, shared artifact volume, replica-safe workers |
| 14 — Docs consolidation | ✅ Complete | KNOWN_LIMITATIONS.md, system_design_walkthrough.md, architecture.md updated |

---

## Phase 12 — Testing, Observability, and Load Proof

Phase 12 has two jobs: prove the concurrency/scaling claims made in Phases 5–9 are real (not just "the unit tests pass"), and give the running system a way to be observed from the outside. Everything in this phase deliberately runs against **real** infrastructure — no mocked Redis, no mocked Postgres — because the mechanisms under test (Lua atomicity, Postgres row locking, BullMQ lock/stall recovery) are exactly the things a mock cannot faithfully reproduce.

### Testcontainers integration suite (`apps/api/src/integration/`)

A second Vitest project, `vitest.integration.config.ts`, separate from the fast mocked suite:

```
apps/api/src/integration/
├─ global-setup.ts        Boots postgres:16 + redis:7-alpine via Testcontainers,
│                          pushes the Prisma schema, spawns 2 shared worker
│                          processes, hands connection strings to every test file.
├─ test-env.ts             bootstrapTestEnv() / teardownTestEnv() — the env-then-
│                          dynamic-import dance every test file uses.
├─ worker-process.ts       spawnWorkerProcess() / waitForWorkerReady() — spawns
│                          apps/worker as a real, separate OS process.
├─ fixtures.ts             hermeticPipelineGraph(), diamondGraph(), DB seed/cleanup helpers.
├─ full-pipeline.integration.test.ts
├─ failure-propagation.integration.test.ts
├─ cancellation.integration.test.ts
├─ retry-failed.integration.test.ts
└─ race-condition.integration.test.ts
```

**Why a `globalSetup` + JSON handoff file, not just `process.env` in a `beforeAll`:** `@dag/db`'s `prisma` and `@dag/queue`'s `connection` are module-level singletons, constructed from `process.env.DATABASE_URL`/`REDIS_URL` the moment the module is first imported. Testcontainers only knows the mapped port *after* the container starts, and a static `import` at the top of a test file is hoisted and evaluated before any `beforeAll` runs — by the time `beforeAll` could set `process.env`, `@dag/db` has already been imported with the wrong (or no) URL. The fix: `global-setup.ts` starts the containers once, writes `{ databaseUrl, redisUrl, artifactDir }` to a JSON file, and every test file's `bootstrapTestEnv()` reads that file, sets `process.env`, and only *then* does a **dynamic** `import('@dag/db')` / `import('@dag/queue')`. Vitest's default `test.isolate: true` gives each test file a fresh module registry, so this is safe to repeat per file.

**Why the worker processes are shared across every test file, spawned once in `global-setup.ts`, instead of one per file:** the first version of this suite spawned worker processes per file. On this project's dev machine that meant 5+ separate `tsx`-plus-`python3` process trees forked over one `vitest run` — slow enough to occasionally blow past a test's wait budget, and once observed to crash the whole run with a native Windows access violation. Spawning exactly two worker processes once, and leaving them running for the life of the suite, removed the flakiness and is closer to the real deployment shape (a long-lived worker fleet, not one worker per run).

**Why `pool: 'forks'`:** Vitest's default `'threads'` pool runs each test file in a worker *thread*, tearing down and recreating a V8 isolate in the same OS process between files. Every integration test file opens real ioredis/BullMQ/Prisma connections; a native callback firing after its isolate had already been torn down was the direct cause of the access-violation crash above. `pool: 'forks'` gives each file a genuinely separate OS process instead, which eliminated the crash entirely across repeated runs.

**What each file proves:**
- `full-pipeline` — the 5-node reference-shaped pipeline runs to `SUCCEEDED` through real Postgres, real Redis, a real spawned worker process, and real `python3` child processes (`apps/worker/python/*.py`); asserts topological ordering via `startedAt`/`finishedAt` and proves Phase 7 template resolution end to end (`deploy`'s persisted input is the literal `weightsPath`, never the `{{ ... }}` string).
- `failure-propagation` — forces a real `UnrecoverableError` (accuracy below `minAccuracy`) and asserts the failure BFS's SKIPPED descendants and terminal `Run.status`.
- `cancellation` — cancels mid-run and asserts no node reachable only through the cancelled branch ever reaches `SUCCEEDED`, and every `NodeRun` lands in a terminal state.
- `retry-failed` — fails a run, "fixes" the underlying config, calls `retryFailedNodesService`, and asserts full recovery to `SUCCEEDED`. **Writing this test surfaced a real bug** — see decisions_log.md.
- `race-condition` — the required diamond-graph race test; see below.

**`hermeticPipelineGraph()` substitutes `kaggle.download` with `pandas.preprocess` for the entry node** — the real `kaggleDownload` executor shells out to the actual Kaggle CLI, which needs network access and credentials neither available nor desirable in a hermetic test. Every other node type (`pandas.preprocess`, `torch.train`, `model.evaluate`, `registry.deploy`) runs its real executor against the real fixture scripts with zero external dependencies, so the substitution only removes the one node whose implementation is inherently non-hermetic; everything else — dispatch, all three queues, template resolution, idempotent writes — is exercised unmodified.

### The deterministic race-condition test

The checkpoint's own question — *how does this test deterministically force the interleaving instead of hoping for it* — has a concrete answer: `race-condition.integration.test.ts` calls `onNodeSucceeded(runId, 'b', ...)` and `onNodeSucceeded(runId, 'c', ...)` **together**, inside one `Promise.all([...])`. Both calls begin executing synchronously and each hits its first `await` (a real Postgres query) before either can finish — from that point the Node.js event loop is genuinely juggling two in-flight async call stacks that both intend to decrement `d`'s Redis in-degree counter. That is the exact two-worker interleaving PROJECT_GUIDE.md §7.3 describes, reproduced on purpose every single run, not waited for. The test then asserts, against real Postgres and real Redis: exactly one `NodeRun` row for `d`, exactly one `NODE_QUEUED` audit event, exactly one BullMQ job under `d`'s deterministic id, and a consistent Redis in-degree/dispatched-set state.

Because this suite now shares two always-on worker processes, `a`/`b`/`c` are seeded directly into Postgres/Redis rather than dispatched through `startRun` — a real dispatch would put a real job on a real queue the shared workers are always polling, and they would race to execute `b`/`c` themselves before the test's own `Promise.all` gets a chance to run, defeating the deterministic setup. Only `d` — the thing actually under test — goes through the real `dispatchNode` → `queue.add()` path.

### `/metrics` — Prometheus-style observability (`apps/api/src/metrics.ts`)

Four metric families, all served from `GET /metrics` (wired in `app.ts`):

| Metric | Kind | Source |
|---|---|---|
| `dag_node_runs_by_status{status}` | Gauge | `prisma.nodeRun.groupBy` — recomputed every scrape |
| `dag_runs_by_status{status}` | Gauge | `prisma.run.groupBy` — recomputed every scrape |
| `dag_queue_depth{queue,state}` | Gauge | `Queue#getWaitingCount()` / `getActiveCount()` per queue |
| `dag_active_workers{queue}` | Gauge | `Queue#getWorkers().length` per queue |
| `dag_node_duration_seconds{nodeType,outcome}` | Histogram | Observed directly in `onNodeSucceeded`/`onNodeFailed` |

The job-status and queue-depth gauges are **recomputed from live sources on every scrape** rather than maintained as counters incremented at each transition site — a `groupBy COUNT` against the `@@index([runId, status])`-backed table costs a few milliseconds and can never drift from Postgres's actual state, whereas a counter incremented at five different call sites (dispatch, success, failure, skip, cancel) silently goes stale the moment one of those sites is refactored and an increment is forgotten. The duration histogram is the one metric that *must* be observed at transition time — a scrape-time query has no way to reconstruct a time series of past durations, only the current state.

### Scale test (`apps/api/scripts/scale-test.ts`)

A standalone benchmark script (`pnpm --filter @dag/api scale-test`), not a `pnpm test` suite member — it runs the acceptance check's literal load (200 concurrent runs of a 10-node graph) against 1 worker process, then again against 4, holding per-worker `CPU_CONCURRENCY` constant so worker *count* is the only variable. The graph is a deliberately wide fan-out/fan-in shape (`root` → 8 parallel `branch*` nodes → `sink`) rather than a chain, so that up to `runs × 8` nodes become ready near-simultaneously — that's what actually stresses queue depth and worker concurrency, which a 10-node chain (only ever ~`runs` nodes ready at once) would not. It records throughput (nodes/s), p50/p95/p99 node latency, and max/avg `queue:cpu` depth, and writes a Markdown results table to [`benchmarks/phase-12-scale-test.md`](../benchmarks/phase-12-scale-test.md) for the Phase 14 README.

**Actual results from this machine** (12 logical cores, Windows, local `docker compose` Postgres/Redis):

| Workers | Nodes completed | Wall clock | Throughput | p95 | Max queue depth |
|---|---|---|---|---|---|
| 1 | 2000/2000 | 182.0s | 11.0 nodes/s | 908ms | 1604 |
| 4 | 2000/2000 | 162.1s | 12.3 nodes/s | 4097ms | 1542 |

**The honest reading of this table is not "clean horizontal scaling" — and that's the more valuable result.** Throughput improved only marginally (1.12x) with 4x the worker processes, and p95 latency got *worse* (908ms → 4097ms), not better. Both queue-depth samples (1604 vs 1542) confirm the same picture: workers weren't waiting on Redis or Postgres, and 4 workers weren't starved for jobs. What changed is that `CPU_CONCURRENCY=8` per worker × 4 workers = 32 concurrent slots all trying to spawn real `python3` child processes at once, on a 12-core machine — well past the point where more concurrent process spawns make things faster. Each additional worker was competing with the others for the same limited CPU cores rather than finding idle capacity, so jobs sat in "active but context-switching" limbo longer, inflating the tail latency (p95/p99) even as the raw completion rate ticked up slightly. See decisions_log.md and interview_qa.md for the full "what does this actually prove" discussion — this is precisely the kind of result a real load test is supposed to surface, and pretending it showed clean 4x scaling would be less useful (and less true) than reporting what it actually showed: *this* dev machine's CPU-bound process-spawn cost is the first real bottleneck, not the dispatch/queue architecture, which behaved identically in both passes (same queue depth pattern, same behavior, just more contention for the same 12 cores). A production deployment with 4 workers on 4 *separate* machines — the actual point of horizontal scaling — would not share this constraint.

Running the benchmark also surfaced two process-management bugs worth documenting on their own (see decisions_log.md): `startRun`'s stale return value, and — separately — that `proc.kill()` on a `shell: true`-spawned Windows process leaves the real worker orphaned, still holding a Postgres connection, which caused every earlier benchmark attempt to fail with `too many clients already` before the process-tree-kill and per-process connection-pool-sizing fixes landed.

### Real bugs Phase 12 found (proof mocks couldn't have caught them)

Writing tests against real infrastructure surfaced two genuine defects that every earlier phase's mocked/skipped tests had missed:

1. **`startRun` returned a stale `run` object.** `orchestrator.service.ts` fetched `run` from `createRun` (status `PENDING`), successfully transitioned the row to `RUNNING` in Postgres, but returned the original in-memory object — still showing `status: 'PENDING'` — because nothing patched it after the transition. `POST /runs`'s response, and every caller, saw the wrong status. Phase 6's own acceptance test (`orchestrator.test.ts`) asserts exactly this (`expect(run.status).toBe('RUNNING')`) but is `describe.skipIf`-guarded behind a real `DATABASE_URL`/`REDIS_URL`, so it had never actually run in this environment before the Testcontainers suite did. Fixed by patching `run.status`/`run.startedAt` in place after the transition succeeds.
2. **`retry-failed` never re-dispatched.** `retryFailedNodesService` reset `FAILED` rows to `PENDING` and `SKIPPED` descendants to `PENDING`, but nothing ever called `dispatchNode` for the retried node — nothing else was going to "unlock" it, because a node only reaches `FAILED` after its own dependencies were already satisfied (there's no future in-degree decrement coming). The route returned success and the run sat there forever. Fixed by calling `dispatchNode` for each reset `FAILED` node once the run is back in `RUNNING`; the reset `SKIPPED` descendants still recover through the normal Lua-decrement path, since `onNodeFailed`'s BFS never touched their Redis in-degree counters in the first place.

Both bugs are the concrete answer to "why Testcontainers over mocking the broker" — a mocked `@dag/db`/`@dag/queue` would have returned whatever the test told it to return, and both bugs are specifically about what the *real* code does with its own return values and its own dispatch responsibilities, not about what Redis or Postgres do.

---

## Message Broker (`packages/queue`) — Phase 5

The message broker layer manages queueing and synchronization using Redis and BullMQ. It serves as the durable distribution substrate between the control plane and data plane.

Package surface (see `packages/queue/src/index.ts`):
- `redis.ts` — shared ioredis factory exporting two connections
- `queues.ts` — three queues, `JobPayload` type, `queueForType()` switch, `createJobId()`
- `lua.ts` — atomic in-degree Lua script + `decrementInDegree` / `seedInDegrees`
- `pubsub.ts` — `publishRunEvent()` and `subscribeToRun()`

### Connection Separation (BullMQ vs pub/sub)

`packages/queue/src/redis.ts` exports **two distinct ioredis connections** to the same Redis server:

| Connection | Used by | Required option | Why |
|------------|---------|-----------------|-----|
| `connection` | BullMQ producers/consumers, Lua scripts | `maxRetriesPerRequest: null` | BullMQ issues blocking commands (`BRPOPLPUSH`-family); ioredis would otherwise abort after a transient blip and orphan the worker. |
| per-call subscriber | `subscribeToRun()` (one per call) | none | Once a connection calls `SUBSCRIBE`, it is locked into subscriber mode and can no longer issue `GET` / `SET` / `HINCRBY` / Lua. |

The earlier version of `pubsub.ts` used a shared global `pubsub` connection exported from `redis.ts`. That was wrong: a single subscriber connection accumulates channels across calls and serializes every callback through one stream. One slow JSON parser on one channel back-presses every other subscriber. The current implementation (`packages/queue/src/pubsub.ts:36–73`) creates a **dedicated subscriber connection per call** and returns a cleanup function that unsubscribes and `quit()`s it. Subscriber connections are cheap on Redis — the cost of one TCP socket per SSE browser tab is negligible.

`publishRunEvent()` does **not** need its own connection. Publishing does not put a connection into subscriber mode, so it reuses the shared `connection`.

### Three-Queue Split (By Resource Profile)

`packages/queue/src/queues.ts:33–53` declares three BullMQ queues:

| Queue | Node types | Worker concurrency | Why split |
|-------|------------|--------------------|-----------|
| `queue:io` | `kaggle.download`, `registry.deploy` | High (10+) | Network I/O — bound by bandwidth, not compute. |
| `queue:cpu` | `pandas.preprocess`, `model.evaluate` | Matches core count | CPU-bound; pinning prevents over-subscription. |
| `queue:gpu` | `torch.train` | Strictly 1 per worker | A single GPU box can only run one CUDA job at a time; a second concurrent job triggers CUDA OOM. |

`queueForType()` (`packages/queue/src/queues.ts:58–72`) is the single switch the orchestrator uses to route a `NodeType` to its queue.

### The Lua Decrement Script

`packages/queue/src/lua.ts:13–18` registers an atomic Lua script via `connection.defineCommand`:

```lua
local remaining = redis.call('HINCRBY', KEYS[1], ARGV[1], -1)
if remaining > 0 then return 0 end
if redis.call('SADD', KEYS[2], ARGV[1]) == 0 then return 0 end
return 1
```

Three steps, all under a single Redis dispatch:
1. `HINCRBY` decrements the in-degree for the child node.
2. If `remaining > 0`, the child is still waiting on other parents — return `0` (don't dispatch).
3. If `remaining == 0`, attempt to claim dispatch by `SADD`ing the child into `run:{runId}:dispatched`. If `SADD` returns `0`, another worker already claimed it — return `0`. If `1`, return `1` (you're the owner, dispatch).

Redis pauses all other commands during Lua execution — no other worker can observe a partial state. This is the *only* correct way to express "decrement and test" in Redis.

### The Four-Layer Defence Against Double-Dispatch

Each layer was added to catch a specific failure mode of the layer above it:

1. **Lua atomicity** (`packages/queue/src/lua.ts:13–18`) — catches the interleaving where two workers both read `remaining=1` and both think they're the last parent. Without this, both compute `1 - 1 = 0` and both dispatch the child.
2. **SADD dispatch guard** (`packages/queue/src/lua.ts:16`) — catches the case where a third caller (stale retry, restarted orchestrator) calls `decrementInDegree` *after* the count has already hit 0. `HINCRBY` would now go negative; `SADD` returns `0` because the node is already in the dispatched set.
3. **Deterministic `jobId` deduplication** (`packages/queue/src/queues.ts:79–81`) — `createJobId(runId, nodeKey, attempt)` produces `${runId}:${nodeKey}:${attempt}`. If the API retries dispatch (network blip, restart mid-`enqueue`), BullMQ's internal `SET NX` sees the id exists and silently drops the duplicate instead of creating a second job.
4. **`@@unique([runId, nodeKey])` on `NodeRun`** (`packages/db/prisma/schema.prisma`) — catches everything above failing simultaneously. Postgres rejects the second `INSERT` with a unique constraint violation; the application catches it and aborts.

The acceptance test `packages/queue/src/lua.test.ts:80–106` fires three concurrent `decrementInDegree` callers and asserts **exactly one** returns `true`. This is the proof of layer 1+2; layers 3 and 4 are covered by integration tests in the orchestrator and repository suites.

### Backoff + Jitter

`packages/queue/src/queues.ts:19–27` sets:

```ts
const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponentialJitter', delay: 2000 },
  removeOnComplete: { age: 86400 },
  removeOnFail: false,
};
```

`exponentialJitter` is a custom backoff strategy that adds randomness on top of exponential growth (2s → 4s → 8s base, +random jitter). When Kaggle rate-limits us and 50 IO jobs fail in the same second, plain exponential backoff would have all 50 retry at t+2s — instant thundering herd, instant second rate-limit. Jitter spreads those retries across a window so Kaggle can recover.

### `seedInDegrees` — Single-Round-Trip Graph Bootstrap

`packages/queue/src/lua.ts:66–94` initialises the in-degree hash for an entire run in a **single ioredis pipeline**. Without the pipeline, seeding a 200-node graph would be 200 sequential `HSET` round-trips. The pipeline also sets a 7-day `EXPIRE` on both `run:{runId}:indegree` and `run:{runId}:dispatched` so abandoned runs self-clean instead of leaking hash entries forever.

---

## Orchestrator (`apps/api`) — Phase 6

The orchestrator sits entirely within the API (Control Plane). Its primary role is to drive the state machine forward based on worker completion events, enforcing the Directed Acyclic Graph order. 

**Workers Stay Dumb:** A core architectural tenet is that workers only execute a single task and return a result. They do not know about the graph, they do not resolve dependencies, and they do not enqueue their own children. If workers did enqueue children, horizontal scaling would be hindered by requiring workers to have DB access, parsing logic, and orchestration privileges. Keeping workers dumb allows them to scale linearly.

### Core Loop Functions
1. `startRun`: Seeds the `Run` and `NodeRun` rows, seeds the Redis Lua state, and computes the initial ready-set (nodes with in-degree 0) for immediate dispatch.
2. `dispatchNode`: The gatekeeper before jobs hit BullMQ.
    - It enforces `tryTransitionNodeRun(PENDING -> QUEUED)`. If this fails, another orchestrator instance already handled the dispatch, preventing duplication.
    - It resolves Context Templates (Phase 7) into literals before enqueuing.
    - It attaches the deterministic `jobId` and pushes to the correct resource queue.
3. `onNodeSucceeded`: Evaluates downstream dependents. Decrements children using the atomic Lua script. Only dispatches those children if the Lua script returns 1.
4. `onNodeFailed`: Transitions the failed node, and importantly, traverses all downstream descendants via BFS and marks them as `SKIPPED`. If a node fails, its children cannot possibly run, propagating failure down the branch without failing unrelated parallel branches.

### BullMQ QueueEvents
Instead of the worker explicitly hitting an API endpoint (e.g., `POST /nodes/complete`), the orchestrator consumes BullMQ `QueueEvents` (`completed`, `failed`). This decouples the worker entirely. As long as BullMQ registers the job as finished, the control plane picks it up immediately.

---

## Context Passing (`apps/api/src/context-resolver.ts`) — Phase 7

### The Template Syntax

Node input configs use `{{ nodes.<parentKey>.output.<dotted.path> }}` for referencing parent outputs:

```json
{
  "csvPath": "{{ nodes.extract.output.metadataPath }}",
  "label":   "run={{ nodes.b.output.version }}-{{ nodes.c.output.checksum }}"
}
```

Templates are resolved by `resolveNodeInputs()` at **dispatch time** — not by the worker, not at run-start time.

### Whole-Value vs. Embedded Replacement

- **Whole-value template** (`"{{ nodes.a.output.stats }}"` is the entire string value): the resolved value replaces the string with its native type. If `stats` is an object `{mean: 0.5}`, the config field becomes that object — not `"[object Object]"`.
- **Embedded template** (`"prefix-{{ nodes.a.output.version }}-suffix"`): string coercion. The resolved value is converted to a string and spliced into the surrounding text.

### Output Size Contract

Workers must return `≤ 64 KB` JSON (`MAX_OUTPUT_BYTES`). The `assertOutputSize()` guard is called in `onNodeSucceeded` before any DB write. If a worker returns a 2 GB model tensor as inline JSON, the run fails immediately with a clear error pointing at the artifact convention:

```
Write large data to the artifact volume (ARTIFACT_DIR/{runId}/{nodeKey}/...)
and return a reference: { "path": "...", "rows": 123, "checksum": "sha256:..." }
```

### Persistence of Resolved Inputs

The fully-resolved input object is written to `NodeRun.input` **before** the job is pushed to BullMQ. This means:
- Every execution is auditable — you can replay exactly what a worker received.
- Post-mortem debugging doesn't require re-running the template resolver; the literal values are in Postgres.
- The worker payload always contains literals, never templates — workers have zero dependency on the resolver.

---

## Worker Data Plane (`apps/worker`) — Phase 8

### Executor Registry (`executor-types.ts`)

The registry type is `Record<NodeType, ExecutorFn>`. Because it's not `Partial<Record<...>>`, TypeScript requires an entry for **every** `NodeType`. If `"data.augment"` is added to `NODE_TYPES` in contracts without a matching executor, the compile step fails with:
```
Property '"data.augment"' is missing in type '...' but required in type 'Record<NodeType, ExecutorFn>'
```
This makes silent "executor not found at runtime" crashes impossible.

### Python Bridge (`python-bridge.ts`)

**Contract:**
- Node.js serialises the input context as a single JSON line and writes it to the child's stdin.
- The Python script reads one line from stdin (`json.loads(sys.stdin.readline())`).
- Any `print()` to stdout is streamed line-by-line to the run log.
- The **last** `::RESULT::` line is parsed as the executor output (JSON).
- Non-zero exit + stderr → the bridge propagates the last 20 stderr lines in the error message.
- SyntaxError / ModuleNotFoundError / missing file → `UnrecoverableError` (BullMQ skips retries).
- A per-node timeout (`setTimeout` + `process.kill(-pid, 'SIGKILL')`) kills the entire process group, preventing orphan GPU processes when a training job times out.

### Idempotency Pattern

Every executor computes a deterministic artifact path from `{runId}/{nodeKey}` and checks for an existing `result.json` before doing any work. This means a re-delivered job (after a worker crash) is a no-op — it reads the cached result and returns immediately. Without idempotency, a SIGKILL during `torch.train` would restart training from scratch on the next worker, wasting hours of GPU time.

**Atomic Write:** all scripts write to `{path}.tmp` then `fs.renameSync()`. A crash between write and rename leaves only the `.tmp` file; the real `result.json` is never partial.

### Heartbeats (`startHeartbeat`)

BullMQ's `lockDuration` defaults to 30 seconds. A `torch.train` job taking 2+ hours would exceed this threshold, causing BullMQ to classify it as "stalled" and re-deliver it to another worker — triggering a second training run in parallel. `startHeartbeat()` calls `job.extendLock()` every 15 seconds, continuously pushing the expiry deadline forward as long as the job is alive.

---

## Fault Tolerance (`apps/worker`) — Phase 9

### Error Taxonomy (`errors.ts`)

Two classes divide all worker failures:
- **`RetryableError`**: transient problems (network timeout, 429, FS lock contention). BullMQ retries with exponential-jitter backoff.
- **`UnrecoverableError`** (BullMQ built-in): permanent failures (bad credentials, SyntaxError, missing script). BullMQ skips all remaining retries immediately.

### Exponential-Jitter Backoff (`backoff.ts`)

Formula: `delay = floor(random(0, min(CAP, BASE * 2^attempt)))`

With `BASE=2000ms`, `CAP=30000ms`:
| attempt | window ceiling | example delay |
|---------|----------------|----------------|
| 0 | 2 000 ms | 873 ms |
| 1 | 4 000 ms | 3 142 ms |
| 3 | 16 000 ms | 11 204 ms |
| 5+ | 30 000 ms | 22 891 ms |

Every retrying job picks an **independent random point** in the window, desynchronising simultaneous retries and preventing the thundering-herd effect.

### Three-Layer Concurrency Limiting

| Layer | Mechanism | Resource Protected |
|-------|-----------|--------------------|
| Per-worker concurrency | `Worker({ concurrency: N })` | CPU/GPU on one machine |
| Per-run semaphore (`semaphore.ts`) | Redis SET, atomic Lua | Total cluster inflight per run |
| Queue rate limit (`queue:io`) | BullMQ `limiter` option | Kaggle/external API rate limits |

### `POST /runs/:id/retry-failed`

Resets FAILED nodes to PENDING (with incremented `attempt`), resets SKIPPED descendants to PENDING, then transitions the Run back to RUNNING. The orchestrator's existing `QueueEvents` listener picks up the reset nodes and re-dispatches them through the normal flow. SUCCEEDED nodes are untouched.

---

## Real-Time Streaming (`apps/api/src/services/sse.service.ts`) — Phase 10

### Why SSE, Not WebSockets

SSE (`text/event-stream`) is a one-directional HTTP push protocol. It uses a plain HTTP/1.1 chunked-transfer connection, works through every reverse proxy that handles streaming responses, and is natively supported by `EventSource` in every browser — which also provides automatic reconnection with `Last-Event-ID`. No upgrade handshake, no custom framing, no ping/pong. WebSockets would be the correct choice if the client needed to push data back (e.g. live terminal input), but for a read-only run status stream, SSE is strictly simpler.

### Dual-Write: Postgres Persist + Redis Pub/Sub

Every state transition writes to both `RunEvent` (Postgres, append-only) and `run:{runId}:events` (Redis pub/sub). Redis pub/sub is fire-and-forget — a message published while a subscriber is disconnected is permanently lost. Without Postgres persistence, a client that lost connectivity for 5 seconds would reconnect and miss every `NODE_SUCCEEDED`, `NODE_FAILED`, and `RUN_SUCCEEDED` event published during that window. It would see the run as stuck forever. The Postgres replay on reconnect delivers exactly the missed events, ordered by insertion id, and then the live pub/sub subscription covers all future events.

### `Last-Event-ID` Cursor — Exactly-Once Reconnection

The browser's `EventSource` automatically sends `Last-Event-ID: {id}` in the reconnect request, where `{id}` is the `id` field of the last SSE frame it received. The server calls `getRunEventsService(runId, lastEventId)` which queries `WHERE id > lastEventId ORDER BY id ASC`. This delivers exactly the events the client missed — not events it already saw (no duplicates), not events published before its last `id` (no gaps beyond the cursor). The guarantee is from the client's perspective: a client that reconnected at event 42 will receive events 43, 44, 45 … exactly once.

### Log Buffering (200 ms)

A `torch.train` script logging every batch can emit 100+ lines per second. Without buffering, each line becomes an individual SSE frame: `res.write(...)` → kernel `send()` → TCP segment → browser DOM update. At 100 frames/s the server's NIC is spending more time on HTTP framing than on compute, and the browser's event loop is overwhelmed. Buffering at 200 ms collapses all lines in each interval into a single `NODE_LOG_BATCH` frame, reducing the frame rate to ≤5/s while keeping perceived latency under 200 ms — imperceptible when watching a log pane.

### Cleanup and Listener Leak Prevention

Every SSE connection spawns a dedicated Redis subscriber connection (per `subscribeToRun` design). The `cleanup()` function, triggered by `res.on('close')`, calls `unsubscribe()` which removes the event listener and calls `sub.quit()`. A `closed` boolean flag (set-once pattern) makes `cleanup()` idempotent — Express may fire both `close` and `error` on the same disconnection. Without the flag, the second call would attempt to quit an already-closed connection, throwing an unhandled error.

---

## Phase 11 — Visual Graph Editor (`apps/web`)

### React Flow + Zustand Sliced Stores

The frontend uses React Flow for canvas rendering and Zustand for state management. We specifically use a **sliced store architecture** with `graphSlice` and `runSlice`.
- `graphSlice` manages the canvas (nodes, edges, node configs, selection). This state is extremely stable during execution.
- `runSlice` manages live execution state (active run, node statuses, logs). This state updates 5-10 times a second during a run.

By subscribing components using **narrow selectors** (`useRunStore(s => s.nodeStatuses[id])`), a status update to a specific node only re-renders that exact node component and the log drawer. If this state were held in React Context, every SSE event would trigger a re-render of the entire node tree and all side panels, crippling performance for large graphs.

### Zero-Dependency Cycle Detection on the Client

Because `@dag/graph-core` was designed with a strict zero-dependency rule, the exact same cycle detection logic (`detectCycle(graph)`) used by the API is imported and run natively in the browser on `onConnect`. When a user attempts to connect an edge that forms a cycle, it is rejected instantly and the path is highlighted in red. The server remains the ultimate authority, but the client provides immediate UX feedback without making an API roundtrip.

### Dynamic Configuration Forms

Instead of writing bespoke React forms for each new Node type, the right-side `ConfigPanel` derives its form structure from metadata defined alongside the schemas (in Phase 11, mocked in the frontend for simplicity, but strictly aligned with the `@dag/contracts` schemas). When a node is selected, its required fields map to generic input elements, and state is pushed to `graphSlice` on blur. This means adding a new executor type (e.g. `snowflake.query`) only requires updating backend schemas and executor logic — the UI automatically supports configuring it.

---

## Phase 14 — Documentation Consolidation

Phase 14 produces three top-level documentation deliverables. No code changes are required — this
phase validates and consolidates what Phases 0–13 built.

### Deliverables

| File | Purpose |
|------|---------| 
| `KNOWN_LIMITATIONS.md` (repo root) | Honest audit of 10 gaps: multi-tenancy auth, scheduled triggers, dynamic fan-out, object storage, conditional branching, real ML executors, multi-machine scale proof, lint backlog, uncommitted migrations, unprotected `/metrics`. Each entry names the gap, explains what breaks without it, and sketches the fix. |
| `knowledge_base/system_design_walkthrough.md` | The 5-minute verbal narrative covering the full request lifecycle (canvas → edge validation → graph version → startRun → dispatch → Lua decrement → worker execution → SSE update → browser paint), the two standard follow-up questions (10k workflows, what breaks first), and a quick-reference table of every phase's core decision and one-sentence rationale. |
| `knowledge_base/architecture.md` (this file) | Phase Status table updated; Phase 14 section added. |

### Why `KNOWN_LIMITATIONS.md` Belongs at the Repo Root

Limitation files that live inside `docs/` or `knowledge_base/` get skipped by reviewers scanning
the repo. Placing it at the root alongside `README.md` makes the engineering candidacy claim
credible: someone who can name exactly what their system doesn't do, and sketch what it would take
to close each gap, demonstrates deeper ownership than someone who presents only what works.

### ADR Cross-Reference

The following ADRs were written in the course of building the system and are summarised throughout
this file in the relevant Phase sections:

| ADR | Phase | Topic |
|-----|-------|-------|
| ADR-001 | 0 | Monorepo structure and zero-dep `graph-core` |
| ADR-002 | 2 | Iterative DFS cycle detection + Kahn's topological sort |
| ADR-003 | 3 | Immutable `WorkflowVersion`, conditional update, append-only `RunEvent` |
| ADR-004 | 5 | Redis + BullMQ choice, Lua atomic in-degree, three-queue split |
| ADR-005 | 6 | Control plane owns scheduling (workers stay dumb) |
| ADR-006 | 8 | Worker executor registry, Node↔Python bridge, idempotency |
| ADR-007 | 9 | Retryable vs. unrecoverable error taxonomy, jitter backoff, semaphore |
| ADR-008 | 11 | Zustand sliced stores, React Flow controlled model, client-side cycle detection |
| ADR-009 | 13 | Multi-stage Dockerfiles, `tsx` in production, `migrate` one-shot service |

The full rationale for every decision above is in `knowledge_base/decisions_log.md`.
Interview Q&A for every phase is in `knowledge_base/interview_qa.md`.
The 5-minute walkthrough and scaling answers are in `knowledge_base/system_design_walkthrough.md`.
Honest system gaps are in `KNOWN_LIMITATIONS.md` at the repo root.
