---
description: End-to-end build workflow for the Distributed Visual Workflow (DAG) Engine — scaffolding, graph algorithms, Postgres control plane, Redis/BullMQ distribution, worker data plane, React Flow editor, fault tolerance, and testing. Pauses at every phase to delegate documentation to the tech-lead subagent.
---

# Workflow: Build the Distributed Visual Workflow (DAG) Engine

## How to run this workflow

1. **Read `PROJECT_GUIDE.md` at the repo root before Phase 0.** It defines the architecture, the data
   model, the state machine, the naming conventions, and the five hard problems. It is the source of
   truth; this file is the sequence.
2. Execute phases **in order**. Each phase is only complete when its *Acceptance check* passes.
3. **At every `Checkpoint:` bullet, stop implementing and invoke the `tech-lead` subagent** with the
   phase name, the files touched, and the exact questions in that bullet. Wait for it to write its
   files under `docs/` before starting the next phase. Never batch or skip checkpoints.
4. If an acceptance check fails, stop and report. Do not soften the check and do not skip ahead.
5. After each phase, commit: `feat(phase-NN): <phase title>`.

---

## Phase 0 — Monorepo scaffold and local infrastructure

**Goal:** a running pnpm workspace with Postgres and Redis reachable from a Node process.

**Do:**
- `pnpm init` at root; create `pnpm-workspace.yaml` covering `apps/*` and `packages/*`.
- Scaffold empty packages per `PROJECT_GUIDE.md` §3: `apps/web`, `apps/api`, `apps/worker`,
  `packages/graph-core`, `packages/contracts`, `packages/db`.
- Root `tsconfig.base.json` with `"strict": true`, `"noUncheckedIndexedAccess": true`, path aliases
  `@dag/graph-core`, `@dag/contracts`, `@dag/db`. Each package extends it.
- ESLint + Prettier at root; `typecheck`, `lint`, `test`, `dev` scripts wired with `pnpm -r`.
- `infra/docker-compose.yml` with `postgres:16` (port 5432, named volume) and `redis:7-alpine`
  (port 6379, `appendonly yes` so queue state survives a container restart).
- `.env.example` with `DATABASE_URL`, `REDIS_URL`, `API_PORT`, `ARTIFACT_DIR`, `WORKER_CONCURRENCY`.
  Add a Zod-validated `env.ts` in `apps/api` and `apps/worker` that parses `process.env` at boot.
- `.gitignore`: `node_modules`, `dist`, `.env`, `artifacts/`.

**Acceptance check:** `docker compose -f infra/docker-compose.yml up -d` (background), then a
throwaway script connects to Postgres and runs `PING` against Redis, both succeeding. `pnpm -r typecheck` is clean.

- Checkpoint: Delegate to the tech-lead subagent to document why this project uses a pnpm workspace monorepo instead of three separate repos (specifically: that `graph-core` must be imported by *both* the browser and the API so the user sees identical validation results client-side and server-side), why `graph-core` is pinned to zero runtime dependencies, why Redis is configured with `appendonly yes` for a queue workload, and why environment variables are Zod-parsed at boot rather than read ad-hoc via `process.env`. Have it write `docs/architecture/ADR-001-monorepo-and-local-infra.md` and `docs/interview/phase-00-qa.md`.

---

## Phase 1 — The wire contract (`packages/contracts`)

**Goal:** one Zod schema set that the frontend, API, and workers all import. No duplicated types.

**Do:**
- Define and export: `NodeDefSchema` (`key`, `type`, `label`, `config`, `position {x,y}`, `retryPolicy?`),
  `EdgeDefSchema` (`from`, `to`), `GraphSchema` (`{ nodes, edges }`),
  `NodeStatusSchema` and `RunStatusSchema` enums matching the state machine in `PROJECT_GUIDE.md` §5.
- `NodeTypeSchema` as a discriminated union on `type` so each task type carries its own typed config:
  `kaggle.download`, `pandas.preprocess`, `torch.train`, `model.evaluate`, `registry.deploy`.
- Graph-level refinements inside Zod: node `key`s unique, every edge endpoint resolves to a real node,
  no self-loops, no duplicate edges, `nodes.length <= MAX_NODES`.
- Export `z.infer` types only — never hand-write a parallel interface.
- Define the run-event envelope published to Redis pub/sub and streamed over SSE:
  `{ runId, nodeKey?, type, payload, ts }`.

**Acceptance check:** unit tests prove a graph with a duplicate key, a dangling edge, and a self-loop
each fail parsing with a readable path in the Zod issue.

- Checkpoint: Delegate to the tech-lead subagent to document why Zod was chosen as the single source of truth with types inferred via `z.infer` (rather than TypeScript interfaces plus a separate validator), how the discriminated union on `NodeDef.type` gives compile-time exhaustiveness in the worker's executor switch, and which structural rules are enforced here in Zod versus which are deliberately deferred to the graph algorithms in Phase 2 (and why cycle detection cannot live in a schema). Output: `docs/deep-dives/phase-01-contracts.md` and `docs/interview/phase-01-qa.md`.

---

## Phase 2 — Graph algorithms (`packages/graph-core`) ★ core CS phase

**Goal:** pure, tested, dependency-free implementations of cycle detection and topological sort.

**Do:**
- `buildAdjacency(graph)` → `{ adj: Map<string,string[]>, inDegree: Map<string,number> }`, built in a
  single O(V+E) pass.
- `detectCycle(graph): { hasCycle: boolean; path?: string[] }`
  - **Iterative** DFS with an explicit stack and tri-colour marking (WHITE / GRAY / BLACK).
  - A GRAY hit is a back edge → reconstruct and return the actual cycle path (`["a","b","c","a"]`) so
    the UI can highlight exactly those edges.
  - Must not recurse — a 10 000-node chain must not overflow the stack.
- `topologicalSort(graph): { order: string[]; levels: string[][] }`
  - Kahn's algorithm: seed with all in-degree-0 nodes, pop, append, decrement children, enqueue newly
    zeroed children.
  - If `order.length !== nodes.length`, throw `CycleError` — an independent second cycle check.
  - `levels[k]` = every node at BFS depth *k*; level width is the maximum available parallelism, used
    by the UI and the scheduler.
- `validateGraph(graph)` composing schema parse + cycle detection + orphan/unreachable-node warnings,
  returning a structured `{ errors: [], warnings: [] }` — never throwing raw strings.
- Fixture-driven tests: linear chain, diamond (`a→b, a→c, b→d, c→d`), wide fan-out, disconnected
  components, 2-node cycle, deep back edge, 10 000-node chain (perf + no stack overflow), empty graph.

**Acceptance check:** `pnpm --filter @dag/graph-core test` green on all fixtures, including the
10 000-node chain completing without a `RangeError`.

- Checkpoint: Delegate to the tech-lead subagent to document the graph algorithms in depth: why DFS tri-colour marking detects cycles correctly (what GRAY specifically means and why a BLACK hit is *not* a cycle), why the DFS was written iteratively with an explicit stack instead of recursively, why Kahn's algorithm was chosen for ordering over DFS-finish-time reversal given that we need in-degree counters at runtime anyway, the O(V+E) time and O(V) space analysis of both, and why `levels[]` is emitted as a byproduct and what it means for parallelism. Output: `docs/architecture/ADR-002-graph-algorithms.md`, `docs/deep-dives/phase-02-cycle-detection-and-kahns.md`, and `docs/interview/phase-02-qa.md` (must include a complexity question and a "trace this graph by hand" question).

---

## Phase 3 — Persistence layer (`packages/db`)

**Goal:** the Prisma schema and query helpers backing the control plane.

**Do:**
- Implement the Prisma schema exactly as in `PROJECT_GUIDE.md` §6: `Tenant`, `Workflow`,
  `WorkflowVersion`, `Run`, `NodeRun`, `RunEvent`, plus the `RunStatus` / `NodeStatus` enums.
- Enforce `@@unique([runId, nodeKey])` on `NodeRun` — the DB-level guarantee that a node cannot be
  executed twice within a run.
- Index `@@index([runId, status])` on `NodeRun` (the scheduler's hot query) and `@@index([runId, id])`
  on `RunEvent` (the audit tail).
- `WorkflowVersion` is **immutable**: editing a graph creates version N+1. Runs pin a version id.
- Write repository helpers, not raw Prisma calls scattered across the codebase. Critically:
  `tryTransitionNodeRun(id, from, to)` implemented as a conditional update
  (`WHERE id = ? AND status = ?`) that returns `false` when `count === 0` instead of throwing.
- `createRun(versionId)` seeds one `NodeRun` row per node in a single transaction, all `PENDING`.
- Run initial migration; commit the migration files.

**Acceptance check:** a test creates a run, then calls `tryTransitionNodeRun(id, 'PENDING', 'QUEUED')`
twice — first returns `true`, second returns `false`, and the row is unchanged.

- Checkpoint: Delegate to the tech-lead subagent to document the persistence design: why `WorkflowVersion` is immutable and runs pin a version id (what breaks if a user edits a graph mid-run), why `@@unique([runId, nodeKey])` exists as a backstop even though Redis already guards dispatch, why every status write is a conditional `UPDATE … WHERE status = <expected>` returning a boolean rather than a read-then-write (name the lost-update interleaving it prevents), why Prisma was chosen over raw SQL or Knex here, and why `RunEvent` is append-only. Output: `docs/architecture/ADR-003-data-model-and-state-transitions.md` and `docs/interview/phase-03-qa.md`.

---

## Phase 4 — Control plane API (`apps/api`)

**Goal:** REST endpoints that validate, version, and inspect workflows. Still no execution.

**Do:**
- Express + TypeScript app with layered structure: `routes/` → `services/` → `packages/db` repos.
  Route handlers only parse, validate, and delegate.
- Endpoints:
  - `POST /workflows` — create
  - `POST /workflows/:id/versions` — validate graph (`validateGraph` from `graph-core`), reject 422
    with the cycle path in the body if invalid, otherwise persist the version **with its cached
    `topoOrder` and `levels`** so the scheduler never recomputes at dispatch time.
  - `POST /workflows/:id/validate` — dry-run validation for the editor's live feedback
  - `GET /runs/:id` — run + all node runs + timings
  - `GET /runs/:id/events` — SSE stream (wired in Phase 9)
  - `POST /runs/:id/cancel`
- Zod middleware for body/params; a central error handler mapping `ZodError` → 400,
  `CycleError` → 422, unknown → 500 with a correlation id.
- Pino structured logging with a `runId`-carrying child logger.

**Acceptance check:** `POST` a cyclic graph → 422 whose body contains the offending cycle path;
`POST` the 5-node ML pipeline → 201 with a persisted `topoOrder` of `[extract, preprocess, train, evaluate, deploy]`.

- Checkpoint: Delegate to the tech-lead subagent to document the control plane: why validation and topological sorting happen at *version-creation* time and the result is cached on the row rather than recomputed per run (the latency and consistency argument), why a cycle returns HTTP 422 with the cycle path instead of a generic 400, why route handlers are kept free of business logic, and what specifically belongs to the control plane versus the data plane in this architecture. Output: `docs/deep-dives/phase-04-control-plane.md` and `docs/interview/phase-04-qa.md`.

---

## Phase 5 — Redis + BullMQ queue infrastructure

**Goal:** the distribution substrate — queues, atomic counters, and the pub/sub channel.

**Do:**
- A shared `redis.ts` factory: one `ioredis` connection for BullMQ (`maxRetriesPerRequest: null`, as
  BullMQ requires for blocking commands) and a separate connection for pub/sub, since a subscribed
  connection cannot issue normal commands.
- Three queues by resource profile: `queue:io` (downloads), `queue:cpu` (pandas/eval), `queue:gpu`
  (training) — so a 40-minute training job cannot starve fast IO jobs behind it.
- Job payload type (from `@dag/contracts`): `{ runId, nodeKey, nodeRunId, type, config, input, attempt }`.
- **Deterministic `jobId = \`${runId}:${nodeKey}:${attempt}\`** — BullMQ silently ignores a duplicate
  jobId while that job exists, giving queue-level deduplication for free.
- Default job options: `attempts: 3`, `backoff: { type: 'exponentialJitter', delay: 2000 }`,
  `removeOnComplete: { age: 86400 }`, `removeOnFail: false`.
- Register the custom `exponentialJitter` backoff strategy on the Worker (full jitter:
  `random() * min(cap, base * 2^attempt)`).
- Load the in-degree Lua script from `PROJECT_GUIDE.md` §7.3 via `defineCommand` so it is a single
  atomic round trip, and a `seedInDegrees(runId, graph)` helper that `HSET`s the whole map in one pipeline.
- Pub/sub helpers: `publishRunEvent(runId, event)` / `subscribeToRun(runId, cb)`.

**Acceptance check:** a test seeds in-degrees for the diamond graph, fires 2 concurrent decrements of
node `d` from two clients, and asserts **exactly one** returns `1`.

- Checkpoint: Delegate to the tech-lead subagent to document the broker layer: why Redis + BullMQ was chosen over Kafka or RabbitMQ for this workload, why the decrement-and-test must be a Lua script rather than two sequential commands (walk the exact two-worker interleaving that double-dispatches node `d` in the diamond graph without it), why `jobId` is deterministic and what BullMQ does with a duplicate, why work is split across three queues by resource profile instead of one, why exponential backoff needs jitter when several retrying workers hit Kaggle at once, and why pub/sub needs its own connection. Output: `docs/architecture/ADR-004-redis-bullmq-and-atomicity.md`, `docs/deep-dives/phase-05-lua-atomic-indegree.md`, and `docs/interview/phase-05-qa.md` (must include the race-condition interleaving question).

---

## Phase 6 — The orchestrator (dispatch + completion loop) ★ core systems phase

**Goal:** the closed loop — seed the ready set, react to completions, unlock children, finish the run.

**Do:**
- `startRun(versionId, idempotencyKey?)`:
  1. Create `Run` + all `NodeRun` rows in one transaction.
  2. Seed `run:{id}:indegree` in Redis from the cached graph.
  3. Compute the initial ready set (`inDegree === 0`) and dispatch each.
  - Idempotent by `Run.idempotencyKey` — a retried API call returns the existing run, never a second one.
- `dispatchNode(runId, nodeKey)`:
  1. `tryTransitionNodeRun(PENDING → QUEUED)`; if `false`, another actor already dispatched — return.
  2. Resolve inputs from parent outputs (Phase 7).
  3. `queue.add(type, payload, { jobId })` on the queue matching the node's resource profile.
  4. Emit a `RunEvent` and publish to pub/sub.
- `onNodeSucceeded(runId, nodeKey, output)`:
  1. Persist output, transition `RUNNING → SUCCEEDED`.
  2. For each child: run the Lua decrement; dispatch **only** when it returns `1`.
  3. If no non-terminal `NodeRun` rows remain, mark the run `SUCCEEDED`.
- `onNodeFailed(runId, nodeKey, error)`: when attempts are exhausted, BFS all descendants → `SKIPPED`,
  run → `FAILED`, publish events. (Descendant traversal reuses `graph-core` adjacency.)
- `cancelRun(runId)`: remove pending jobs from the queues, transition non-terminal nodes → `CANCELLED`;
  in-flight jobs observe a cancellation flag at their next checkpoint.
- Completion is delivered via BullMQ `QueueEvents` (`completed` / `failed`) consumed by the API
  process, so the control plane keeps ownership of all scheduling decisions.

**Acceptance check:** with **zero workers running**, calling `startRun` on the 5-node pipeline leaves
exactly one job (`extract`) in `queue:io` and four `NodeRun` rows still `PENDING`. Then hand-complete
`extract` through `onNodeSucceeded` and assert exactly one new job (`preprocess`) appears.

- Checkpoint: Delegate to the tech-lead subagent to document the orchestration loop: why the control plane — not the worker — decides what runs next (the "workers stay dumb" argument and what horizontal scaling would break if workers enqueued their own children), how the in-degree counter maps to the dependency semantics of Kahn's algorithm at runtime, why `tryTransitionNodeRun` is checked *before* enqueueing rather than after, why failure propagates to descendants as `SKIPPED` rather than `FAILED`, how `idempotencyKey` prevents duplicate runs from a retried HTTP call, and why `QueueEvents` is consumed by the API process. Output: `docs/architecture/ADR-005-control-plane-owns-scheduling.md`, `docs/deep-dives/phase-06-orchestrator.md`, and `docs/interview/phase-06-qa.md`.

---

## Phase 7 — Context passing (parent output → child input)

**Goal:** `train` receives the exact `metadata.csv` path that `preprocess` produced.

**Do:**
- Output contract: workers return JSON `≤ 64 KB`; oversized returns are rejected as a node failure with
  a clear message pointing at the artifact convention.
- Artifact convention: large data is written under `${ARTIFACT_DIR}/{runId}/{nodeKey}/…` and passed
  **by reference**: `{ "metadataPath": "…/metadata.csv", "rows": 48213, "checksum": "sha256:…" }`.
- Template resolver in the control plane, executed at dispatch time:
  `"{{ nodes.preprocess.output.metadataPath }}"` → the literal value from that `NodeRun.output`.
  Support dotted paths and whole-object interpolation; on an unresolved reference, fail the dispatch
  loudly with the offending template string — never pass `undefined` downstream.
- Persist the fully-resolved `input` on the `NodeRun` row before enqueueing, so every execution is
  reproducible and auditable after the fact.
- Tests: diamond graph where `d` interpolates from both `b` and `c`; unresolved-reference failure case.

**Acceptance check:** a two-node run where the parent returns `{"metadataPath":"x.csv"}` and the child's
persisted `input` contains the resolved literal `"x.csv"`, not the template.

- Checkpoint: Delegate to the tech-lead subagent to document the state-passing design: why outputs are split into small JSON-by-value versus large artifacts-by-reference (what happens to Postgres and Redis if a 2 GB dataset is passed inline), why templates are resolved by the control plane at dispatch time rather than by the worker at execution time (the auditability and reproducibility argument), why the resolved input is persisted on the `NodeRun` row, and why an unresolved reference is a hard failure instead of `undefined`. Output: `docs/deep-dives/phase-07-context-passing.md` and `docs/interview/phase-07-qa.md`.

---

## Phase 8 — Worker data plane (`apps/worker`) ★ execution phase

**Goal:** N independent processes that actually run the ML pipeline tasks.

**Do:**
- One BullMQ `Worker` per queue, `concurrency` from env (default: io 8, cpu 4, gpu 1).
- An **executor registry**: `Record<NodeType, (ctx: ExecutorContext) => Promise<Output>>`, with the
  discriminated union from Phase 1 giving compile-time exhaustiveness — adding a node type without an
  executor must fail typecheck.
- Executors for the reference pipeline:
  - `kaggle.download` — shells out to the Kaggle CLI; network errors → `RetryableError`; a 403/bad
    credentials → `UnrecoverableError`.
  - `pandas.preprocess` — spawns `python/preprocess.py`.
  - `torch.train` — spawns `python/train.py`; long-running, emits progress heartbeats.
  - `model.evaluate`, `registry.deploy` — same bridge pattern.
- **Python bridge** (`runPython(script, input)`): `child_process.spawn`, input JSON on stdin, stdout
  streamed to the run log, final line `::RESULT:: {json}` parsed as the output, non-zero exit → error
  with the tail of stderr attached. Enforce a per-node timeout that kills the child process group.
- **Idempotency in every executor:** compute the target artifact path from `{runId}:{nodeKey}`; if it
  already exists and its checksum matches, short-circuit and return the cached output. Always write to
  `*.tmp` and `fs.rename` atomically so a crash mid-write can never leave a half-written `metadata.csv`.
- Heartbeat: call `job.extendLock()` / `job.updateProgress()` periodically inside long tasks so a live
  training job is never falsely reclaimed as stalled.
- Graceful shutdown on `SIGTERM`: stop accepting new jobs, let in-flight jobs finish or release their lock.
- Worker publishes `RUNNING` on start and its terminal result on finish; the control plane reacts.

**Acceptance check:** run the full 5-node pipeline end to end with 2 worker processes against a small
sample dataset; all five nodes reach `SUCCEEDED` in topological order, and `metadata.csv` exists under
`artifacts/{runId}/preprocess/`.

- Checkpoint: Delegate to the tech-lead subagent to document the data plane: the executor-registry pattern and how the discriminated union enforces exhaustiveness at compile time; the Node↔Python bridge contract (why JSON over stdio with a `::RESULT::` sentinel rather than a REST call or a shared DB table, and how stderr is preserved for debugging); why the pandas preprocessing step writes to a temp file and atomically renames; exactly what makes each executor idempotent and why that is mandatory when BullMQ may re-deliver a job after a crash; and why `extendLock` heartbeats are needed for a long training node. Output: `docs/architecture/ADR-006-worker-execution-and-python-bridge.md`, `docs/deep-dives/phase-08-executors-and-idempotency.md`, and `docs/interview/phase-08-qa.md`.

---

## Phase 9 — Fault tolerance, retries, and concurrency limiting

**Goal:** the run survives transient failures, worker crashes, and resource contention.

**Do:**
- Error taxonomy in `packages/contracts`: `RetryableError` (network timeout, 429, transient FS) versus
  BullMQ's `UnrecoverableError` (bad config, missing script, Python `SyntaxError`) — the latter must
  fail immediately without burning the retry budget.
- Per-node `retryPolicy` override from `NodeDef.config` (attempts, base delay, cap), falling back to the
  queue default; persist `attempt` on each `NodeRun` transition.
- Stalled-job recovery: tune `lockDuration`, `stalledInterval`, `maxStalledCount`. On reclaim, the job
  is re-delivered with an incremented attempt and the executor's idempotency check makes the replay safe.
- **Concurrency limiting** at three levels: per-worker `concurrency`; per-run parallelism via a Redis
  semaphore (`run:{id}:slots`) so one enormous fan-out cannot monopolise the cluster; and a queue-level
  rate limit on `queue:io` to respect Kaggle's API limits.
- Dead-letter handling: after final failure, the job stays in the failed set with its full error trail;
  add `POST /runs/:id/retry-failed` that re-dispatches only failed nodes and their skipped descendants.
- **Chaos test:** start the pipeline, `SIGKILL` the worker mid-`train`, restart it, and assert the run
  still completes with the node's `attempt` incremented and **no duplicate side effects**.

**Acceptance check:** the chaos test passes, and a forced transient failure in `kaggle.download`
retries with visibly increasing, jittered delays before succeeding.

- Checkpoint: Delegate to the tech-lead subagent to document fault tolerance: the retryable-versus-unrecoverable taxonomy and why misclassifying a bad-credentials error as retryable is actively harmful; the exact math of exponential backoff with full jitter and the thundering-herd problem it prevents; how BullMQ's lock/stalled mechanism converts a `SIGKILL`ed worker into a safe re-delivery and why that is only safe *because* executors are idempotent; the three layers of concurrency limiting and which resource each protects; and what "at-least-once delivery with idempotent consumers" buys us versus attempting exactly-once. Output: `docs/architecture/ADR-007-fault-tolerance-and-retries.md`, `docs/deep-dives/phase-09-crash-recovery.md`, and `docs/interview/phase-09-qa.md`.

---

## Phase 10 — Real-time status streaming

**Goal:** the browser sees node status change within ~100 ms of it happening on a worker.

**Do:**
- Every state transition emits a `RunEvent` row **and** publishes to `run:{runId}:events`.
- `GET /runs/:id/events` as SSE: on connect, replay persisted events since a `Last-Event-ID` cursor,
  then switch to live pub/sub — so a reconnecting client never misses a transition.
- Heartbeat comments every 15 s to defeat proxy idle timeouts; clean up the Redis subscription on
  client disconnect (verify no listener leak across repeated connect/disconnect).
- Node-level log streaming: worker stdout chunks published as `log` events, buffered and flushed at
  ~200 ms intervals so a chatty training loop cannot flood the channel.

**Acceptance check:** with `curl -N` attached to the SSE endpoint, a full pipeline run streams ordered
status transitions for all five nodes; killing and reconnecting `curl` mid-run replays the missed
events exactly once.

- Checkpoint: Delegate to the tech-lead subagent to document the real-time layer: why SSE was chosen over WebSockets for this one-directional server→client stream (and when that choice would flip), why events are persisted to `RunEvent` *and* published to pub/sub rather than pub/sub alone (Redis pub/sub is fire-and-forget — name what a client loses on reconnect without the replay), how the `Last-Event-ID` cursor makes reconnection exactly-once from the client's perspective, and why worker log output is buffered before publishing. Output: `docs/deep-dives/phase-10-sse-and-event-replay.md` and `docs/interview/phase-10-qa.md`.

---

## Phase 11 — Visual graph editor (`apps/web`) ★ frontend phase

**Goal:** drag-and-drop DAG construction with instant validation and live run status.

**Do:**
- Vite + React + TS. React Flow canvas with custom node components per node type (distinct icon,
  colour, and a status ring), and typed edges with arrow markers.
- **Zustand store, sliced:** `graphSlice` (nodes, edges, selection, dirty flag) and `runSlice` (run id,
  per-node status, logs). Subscribe with narrow selectors — a status tick on one node must not re-render
  the whole canvas.
- Node palette (drag to canvas) + a config side panel rendered from the node's Zod schema, so adding a
  node type requires no bespoke form code.
- **Client-side validation using the same `@dag/graph-core`:** run `detectCycle` on every edge connect;
  if the new edge would create a cycle, reject the connection immediately and flash the returned cycle
  path in red. This is the payoff for the zero-dependency rule in Phase 0.
- Save → `POST /workflows/:id/versions`; Run → `POST /workflows/:id/runs`; then open the SSE stream and
  paint node borders live (queued/running/succeeded/failed/skipped) with an inline log drawer.
- A run history view: past runs, per-node durations, and a Gantt-style timeline derived from
  `startedAt`/`finishedAt` that visually proves independent branches ran in parallel.

**Acceptance check:** build the 5-node ML pipeline entirely in the UI, attempt to draw
`deploy → extract` and watch it be rejected as a cycle, then run it and watch all five nodes light up
in order without a page refresh.

- Checkpoint: Delegate to the tech-lead subagent to document the frontend: why Zustand with sliced stores and narrow selectors was chosen over Redux or Context for high-frequency status updates (the re-render cost of a status tick under Context); how React Flow's controlled `nodes`/`edges` model is bridged to the Zustand store and why `onNodesChange`/`onEdgesChange` must be applied through the store; how running the *same* `detectCycle` implementation in the browser gives instant feedback while the server keeps authority; and how config forms are generated from the Zod node schemas. Output: `docs/architecture/ADR-008-frontend-state-and-react-flow.md`, `docs/deep-dives/phase-11-visual-editor.md`, and `docs/interview/phase-11-qa.md`.

---

## Phase 12 — Testing, observability, and load proof

**Goal:** evidence that the concurrency and scaling claims are real, not aspirational.

**Do:**
- Unit: `graph-core` fixtures (already in Phase 2), the template resolver, the error taxonomy, and the
  Lua decrement under concurrent clients.
- Integration with Testcontainers (real Postgres + real Redis): full pipeline run; failure propagation
  to `SKIPPED`; cancellation mid-run; retry-failed.
- **Race-condition test:** the diamond graph with `b` and `c` completing simultaneously — assert `d` has
  exactly one `NodeRun`, one dispatch event, and one execution.
- **Scale test:** 200 concurrent runs of a 10-node graph across 4 worker processes; record throughput,
  p95 node latency, and queue depth. Then run the identical load with 1 worker and chart both — this is
  the horizontal-scaling proof for the README.
- Observability: Prometheus-style `/metrics` (jobs by status, queue depth, node duration histogram,
  active workers); every log line inside a run carries `runId`.

**Acceptance check:** `pnpm -r test` green including the Testcontainers suite; the scale test emits a
results table showing throughput scaling as workers are added.

- Checkpoint: Delegate to the tech-lead subagent to document the verification strategy: how the race-condition test *deterministically* forces the simultaneous-completion interleaving (rather than hoping for it), why Testcontainers with real Postgres and Redis was chosen over mocking the broker (what class of bug mocks structurally cannot catch — Lua atomicity, lock expiry, transaction isolation), which metrics actually prove the horizontal-scaling claim, and how to read the 1-worker versus 4-worker results table. Output: `docs/deep-dives/phase-12-testing-and-benchmarks.md` and `docs/interview/phase-12-qa.md`.

---

## Phase 13 — Containerisation and horizontal scaling

**Goal:** `docker compose up --scale worker=4` produces a working distributed cluster.

**Do:**
- Multi-stage Dockerfiles for `api`, `worker`, `web` (pnpm fetch layer → build → slim runtime).
  The worker image includes Python plus `pandas`/`torch` requirements.
- Compose service graph with healthchecks and `depends_on: { condition: service_healthy }`;
  a shared named volume for `ARTIFACT_DIR` mounted into every worker (workers must see each other's
  artifacts, since `preprocess` and `train` may land on different machines).
- Workers are **stateless and replica-safe** — verify `--scale worker=4` requires zero config changes
  and produces no duplicate execution.
- Migration strategy: a one-shot `migrate` service running `prisma migrate deploy` before the API starts.
- README quickstart: clone → `docker compose up` → open the editor → run the pipeline.

**Acceptance check:** on a clean machine, `docker compose up --scale worker=4 -d` followed by running
the pipeline from the UI completes successfully, and the run timeline shows work distributed across
more than one worker id.

- Checkpoint: Delegate to the tech-lead subagent to document deployment: why workers are stateless and what specifically would break horizontal scaling if a worker held run state in process memory; why artifacts require a shared volume (or object storage) rather than a per-container filesystem, and what the `preprocess`-on-worker-1 / `train`-on-worker-2 case proves; why migrations run as a separate one-shot service instead of on API boot with multiple replicas; and what would have to change to move this from Compose to Kubernetes (HPA on queue depth, PVC for artifacts). Output: `docs/architecture/ADR-009-deployment-and-scaling.md` and `docs/interview/phase-13-qa.md`.

---

## Phase 14 — Documentation consolidation and interview pack

**Goal:** the repository sells the engineering, and the author can defend every decision out loud.

**Do:**
- Root `README.md`: the problem, an architecture diagram, a GIF of the editor running the pipeline, the
  quickstart, the scaling results table from Phase 12, and a "how it works" section walking one node
  from canvas → validation → queue → worker → child unlock.
- `docs/architecture/README.md` indexing all ADRs with one-line summaries.
- A **system-design walkthrough** (`docs/interview/system-design-walkthrough.md`): the 5-minute verbal
  tour of the whole system, plus the answers to "how would you scale this to 10 000 concurrent
  workflows?" and "what breaks first under load, and what would you fix?"
- A **consolidated Q&A pack** merging every `phase-NN-qa.md`, grouped into: Graph Theory & Algorithms,
  Distributed Systems, Concurrency & Race Conditions, Databases & Transactions, Frontend State,
  and Failure Modes.
- A `KNOWN_LIMITATIONS.md` — honest gaps (no multi-tenancy isolation beyond `tenantId`, no scheduled
  triggers, no dynamic fan-out) with what each would take to close. Being able to name your own gaps
  is worth more in an interview than pretending they don't exist.

**Acceptance check:** a reader who has never seen the repo can go from clone to a successful pipeline
run using only the README, and every ADR referenced in the index exists.

- Checkpoint: Delegate to the tech-lead subagent to perform the final consolidation pass: verify every ADR from Phases 0–13 exists and still matches the shipped code (flag any decision that drifted during implementation), merge all phase Q&A files into the grouped master pack, write the 5-minute system-design walkthrough covering cycle detection → Kahn's algorithm → Redis dispatch → atomic in-degree decrement → idempotent worker execution as one continuous narrative, and produce the "what breaks first at 10 000 concurrent workflows" scaling-limits answer. Output: `docs/interview/system-design-walkthrough.md`, `docs/interview/MASTER-QA.md`, and an updated `docs/architecture/README.md`.

---

## Quick reference — phase → checkpoint deliverables

| Phase | Focus | tech-lead output |
|---|---|---|
| 0 | Monorepo + infra | ADR-001, phase-00-qa |
| 1 | Zod contracts | deep-dive, phase-01-qa |
| 2 | DFS + Kahn's ★ | ADR-002, deep-dive, phase-02-qa |
| 3 | Prisma + state machine | ADR-003, phase-03-qa |
| 4 | Control plane API | deep-dive, phase-04-qa |
| 5 | Redis/BullMQ + Lua ★ | ADR-004, deep-dive, phase-05-qa |
| 6 | Orchestrator loop ★ | ADR-005, deep-dive, phase-06-qa |
| 7 | Context passing | deep-dive, phase-07-qa |
| 8 | Workers + Python bridge ★ | ADR-006, deep-dive, phase-08-qa |
| 9 | Retries + crash recovery | ADR-007, deep-dive, phase-09-qa |
| 10 | SSE streaming | deep-dive, phase-10-qa |
| 11 | React Flow editor ★ | ADR-008, deep-dive, phase-11-qa |
| 12 | Tests + benchmarks | deep-dive, phase-12-qa |
| 13 | Docker + scaling | ADR-009, phase-13-qa |
| 14 | Consolidation | MASTER-QA, walkthrough |

★ = the phases that carry the project's technical weight. Do not rush these, and do not let the
tech-lead produce a shallow checkpoint for them.
