# DAG Engine — Decisions Log

## Phase 0 — Monorepo Scaffold and Local Infrastructure

### Decision: pnpm Workspace Monorepo

**Why:** `graph-core` (graph algorithms) must run identically in the browser and on the API server. A monorepo with `workspace:*` dependencies resolves directly to TypeScript source — no publish step, no version drift. Alternatives (Nx, Turborepo) add unnecessary complexity at this stage.

**Trade-off:** All packages share one `node_modules` hoisting pool — dep version conflicts require resolution. Acceptable cost.

---

### Decision: `graph-core` — Zero Runtime Dependencies

**Why:** `graph-core` is imported by Vite (browser bundle). Any runtime dep risks breaking the browser build or inflating bundle size. Pure functions over plain objects are universally importable (Node.js, browser, Deno, edge workers).

**Enforcement:** No `dependencies` key in `package.json` — only `devDependencies`.

---

### Decision: Redis with `appendonly yes`

**Why:** Default RDB snapshots lose all writes between intervals. For BullMQ job queues, this means pending `NodeRun` jobs are silently lost on Redis restart — runs stall forever. AOF logs every write to disk; Redis replays on restart. Zero job loss.

**Trade-off:** Slightly higher write latency, larger disk footprint.

---

### Decision: Zod-validated `env.ts` per app

**Why:** `process.env` is `string | undefined`. Ad-hoc reads create silent failures (undefined passed to PrismaClient, Redis constructor), bad developer experience, and no validation of format. Zod parsing at module load time crashes the process immediately with a clear, structured error.

**Pattern:** `z.object({...}).safeParse(process.env)` → exit(1) on failure.

---

### Decision: TypeScript strict mode + `noUncheckedIndexedAccess`

**Why:** `strictNullChecks` catches null/undefined bugs. `noUncheckedIndexedAccess` catches array index-out-of-bounds at compile time — critical for graph traversal code where popping from queues or reading adjacency maps with an out-of-range index must be handled explicitly.

---

### Decision: Separate tsconfig for `apps/web`

**Why:** Vite uses `"module": "ESNext"` and `"moduleResolution": "Bundler"` — incompatible with the `"module": "CommonJS"` used by API and Worker. The web tsconfig extends the base but overrides module settings and adds `"noEmit": true` (Vite emits, not tsc).

---

### Decision: Docker Compose for local infrastructure

**Why:** Pins exact versions (`postgres:16`, `redis:7-alpine`), eliminates local-install version skew, provides health checks for `depends_on` readiness, and is reproducible on any machine.

---

## Phase 1 — Wire Contracts (`packages/contracts`)

### Decision: Zod as the Single Source of Truth — Types via `z.infer<>`

**Why:** Defining a TypeScript interface AND a separate validator (e.g., a class-validator decorator or a hand-written guard) creates two places that can drift. If you add a field to the interface and forget the validator, invalid data silently passes at runtime. Zod schemas ARE the type — `z.infer<typeof NodeDefSchema>` produces the TypeScript type directly. One change in one place. No drift.

**Trade-off:** Zod's TypeScript error messages for complex schemas (especially discriminated unions) can be verbose. Acceptable cost given the correctness guarantee.

---

### Decision: Discriminated Union on `NodeDef.type` for per-type Config

**Why:** A naive approach would be `config: z.record(z.unknown())` — completely untyped. With a discriminated union, TypeScript narrows the type when you switch on `node.type`. In the worker's executor registry, this means adding a new node type without a corresponding executor causes a TypeScript compile error (not a runtime surprise). The discriminant field `type` is a string literal in each union branch, which Zod's `z.discriminatedUnion()` uses for O(1) lookup (not linear scan through all branches).

---

### Decision: Cycle Detection Deferred to Phase 2 (Not in Zod)

**Why:** Zod's `.superRefine()` callback runs once per object and has access to the object's fields. Cycle detection requires a depth-first traversal of the entire graph — DFS with a stack, visiting nodes by following edges. Zod has no mechanism for this kind of stateful, multi-pass traversal. It also runs synchronously per field, not across the graph as a whole. Cycle detection belongs in `graph-core` as a pure function: `detectCycle(graph): { hasCycle: boolean; path? }`.

---

### Decision: Structural Graph Rules in `GraphSchema.superRefine()`

**Why:** Rules like "no duplicate node keys" and "no dangling edges" ARE structural and can be checked in a single pass over the parsed data — they require no traversal. Putting them in Zod means they are checked on every `GraphSchema.parse()` call, including the browser's live validation as the user draws edges. The error messages include the exact path (`['edges', 2, 'to']`), enabling the UI to highlight the offending edge precisely.

---

## Phase 2 — Graph Algorithms (`packages/graph-core`)

### Decision: Iterative DFS over Recursive DFS for Cycle Detection

**Why:** A recursive Depth-First Search (DFS) adds a new frame to the V8 JavaScript call stack for every node in the current path. If a user builds a linear pipeline of 15,000 nodes, a recursive DFS will throw `RangeError: Maximum call stack size exceeded`. By using an explicit array as a stack (`const stack = [[startNode, 0]]`), we move the memory usage from the constrained call stack to the heap, which can handle millions of items. Even though we currently cap nodes at 200, building safe, iterative algorithms is a robust library design choice.

### Decision: 3-Color DFS instead of Kahn's for Cycle Detection

**Why:** Kahn's algorithm *can* detect cycles (if the final sorted list length < total nodes), but it cannot easily identify the **exact path** of the cycle. To provide the user with actionable feedback ("Cycle detected: A → B → C → A"), we need the current traversal path. The 3-color DFS (WHITE=unvisited, GRAY=on-stack, BLACK=done) immediately flags a cycle when it encounters a GRAY node, and the cycle path is simply the trail of parent pointers back to the first GRAY node.

### Decision: Kahn's Algorithm for Topological Sort & Concurrency Tiers

**Why:** While DFS can also produce a topological sort (by recording nodes as they turn BLACK and reversing the list), Kahn's algorithm relies on in-degrees. It naturally processes nodes tier-by-tier: all nodes with in-degree 0 are processed, then their outgoing edges are removed, creating a new set of in-degree 0 nodes. This tiering exactly maps to our execution concurrency model — all nodes in a tier can be dispatched to the Redis queue simultaneously. DFS produces a flat list and makes it harder to determine parallel execution boundaries.

---

## Phase 3 — Persistence Layer (`packages/db`)

### Decision: WorkflowVersion is Immutable

**Why:** A `WorkflowVersion` is a point-in-time snapshot of the graph. When a `Run` is created it pins `workflowVersionId`. If users could mutate the graph in place, a run that is 3 nodes deep could suddenly have different edges — the scheduler would try to dispatch a node that no longer exists in the graph, or skip a node that was added. Immutability guarantees that the graph the scheduler reads at dispatch time is byte-for-byte identical to the graph the user saw when they clicked "Run". Adding/editing nodes creates version N+1; the old run is unaffected.

**Trade-off:** Storage grows with every save. Acceptable — workflow graphs are small JSON objects.

---

### Decision: `@@unique([runId, nodeKey])` at the DB Level

**Why:** Redis's Lua script is the primary dispatch guard (atomic decrement + SADD). But Redis is an external process — it can restart, the Lua script could have a bug, or a network partition could cause two API instances to race. The DB constraint is the last line of defence. Postgres will reject the second `INSERT` with a unique violation, preventing a second `NodeRun` row from ever existing for the same `(runId, nodeKey)` pair, making double-execution structurally impossible at the storage layer regardless of what the broker does.

**Trade-off:** A unique constraint adds a small overhead to every `NodeRun` insert. With 200 nodes per run this is negligible.

---

### Decision: Conditional UPDATE (`WHERE status = from`) — Never Read-Then-Write

**Why:** A read-then-write (read status → check it's RUNNING → write SUCCEEDED) has a window between the read and the write where another actor can also read `RUNNING`. Both see `RUNNING`, both write `SUCCEEDED`, both then trigger downstream effects (dispatching children, closing the run). This is the classic lost-update race condition. The fix: collapse read + write into a single atomic SQL statement. `UPDATE NodeRun SET status='SUCCEEDED' WHERE id=$id AND status='RUNNING'` — Postgres takes a row-level lock for the duration of the write. Only one caller gets `count=1`; the other gets `count=0` and aborts.

**Pattern used:** `tryTransitionNodeRun(id, from, to, extra?)` → returns `boolean`. Every single status write in the codebase goes through this function.

---

### Decision: Prisma over Raw SQL / Knex

**Why:**
1. **Type safety:** Schema → generated client → TypeScript types. No string-typed queries.
2. **Migration management:** `prisma migrate dev` generates SQL migration files and applies them. The history is committed to the repo and can be replayed on any environment.
3. **`updateMany` row count:** Prisma's `updateMany` returns `{ count: number }`, which is exactly what the conditional-update pattern needs to detect "did anyone else win?"
4. **Monorepo-friendly:** The generated client path (`output = "../src/generated/client"`) can be set per package, so `@dag/db` owns its client and other packages never import from the generated path directly.

**Trade-off:** Prisma's query engine binary adds ~10 MB to the Docker image. Acceptable.

---

### Decision: `RunEvent` is Append-Only

**Why:** `RunEvent` serves two roles simultaneously: (1) an audit trail for post-mortem debugging and (2) the replay source for SSE reconnects. If events could be mutated or deleted, both guarantees break. A reconnecting browser client asks for events `WHERE id > lastSeenId` — if an event was deleted, the client would miss it and show a gap in the node status timeline. The `BigInt @default(autoincrement())` id provides a monotonically increasing cursor that clients can safely use across reconnects.

**Pattern:** Only `appendRunEvent()` is exposed — no update or delete helpers exist in the repository layer.

---

## Phase 4 — Control Plane API (`apps/api`)

### Decision: Separate `createApp()` Factory from `src/index.ts` Server Startup

**Why:** If `app.listen()` were called at the module level in `app.ts`, then `import { app } from './app'` in a test file would bind a real TCP port and attempt to connect to PostgreSQL. By exporting `createApp()` as a factory and calling `listen()` only in `index.ts`, test files call `createApp()` and pass the result directly to Supertest — zero ports opened, zero network connections. This is the standard Express testing pattern.

**Trade-off:** Slightly more indirection (two files instead of one). Entirely worth the test ergonomics.

---

### Decision: Route Handlers Have Zero Business Logic

**Why:** Express route handlers that contain business logic are hard to test (you must make HTTP calls), hard to reuse (you cannot call the logic without Express), and hard to read (HTTP boilerplate is mixed with domain logic). By delegating immediately to a service function (`createWorkflowService(req.body)`), the handler becomes trivial. The service function can be unit-tested directly without any HTTP machinery.

**Rule enforced:** If a route handler needs more than one `await`, something is wrong — that logic belongs in the service.

---

### Decision: `POST /workflows/:id/validate` Always Returns HTTP 200

**Why:** This endpoint is called by the browser editor on every edge draw operation to provide instant feedback. If it returned 422 on a cyclic graph, the client would need two code paths: one for HTTP errors (network, 5xx) and one for validation results (4xx). By always returning 200 with `{ valid: boolean, ...details }`, the client has a single response shape to handle regardless of outcome. HTTP error codes are reserved for truly exceptional conditions (server crash, auth failure) — "this graph has a cycle" is a normal, expected response.

---

### Decision: Central Error Handler with Typed Error Classes

**Why:** Without a central handler, every route would need its own try/catch with repeated `if (err instanceof ZodError) res.status(400)...` logic. More critically, a bug where an untyped `new Error()` reaches the client would leak a stack trace. The central handler guarantees:
1. Every error type maps to exactly one HTTP status (defined once, not repeated per route).
2. Unknown errors get a `correlationId` in the response (for log lookup) but no stack trace in the body.
3. Adding a new error type means adding one `if` block in one file — the rest of the codebase is unchanged.

---

### Decision: `validateBody()` Middleware Replaces `req.body` with Parsed Data

**Why:** After `validateBody(Schema)` runs, `req.body` contains the Zod-parsed, type-coerced value. The route handler receives fully typed data without needing to call `.parse()` itself. This means the handler never sees raw `unknown` from Express — it only ever processes data that has already been validated. Any validation failure is handled before the handler is called, forwarded to the error handler via `next(zodError)`.

---

## Phase 5 — Message Broker (`packages/queue`)

### Decision: Redis + BullMQ vs Kafka or RabbitMQ

**Why:** Redis provides more than just queues — it provides distributed atomic counters (via Lua) and a fast pub/sub mechanism. For a DAG engine, we strictly require a globally atomic operation for in-degree tracking to prevent double dispatch, which Redis Lua scripts can do in one round trip. Kafka is designed for high-throughput streaming (append-only log), not for point-to-point job scheduling with complex backoff and retry policies. RabbitMQ supports retries, but lacks the shared atomic hash map that we need for dependency resolution. BullMQ over Redis gives us retries, deduplication (`jobId`), pub/sub, and custom Lua script capabilities in one dependency.

### Decision: Resource-Specific Queues (`queue:io`, `queue:cpu`, `queue:gpu`)

**Why:** If we used a single global queue, a 40-minute GPU training job would block a simple 2-second dataset download job. By partitioning queues by resource profile, workers can scale and process tasks independently. For instance, an IO worker can process 10 concurrent network tasks while a GPU worker processes exactly 1 task at a time, ensuring fair distribution and no head-of-line blocking.

### Decision: Exponential Backoff with Jitter

**Why:** If an external API (like Kaggle) goes down or rate-limits requests, 50 running IO tasks might fail simultaneously. With standard exponential backoff, all 50 workers will retry exactly 2 seconds later, then 4 seconds later, generating a "thundering herd" that guarantees they will get rate-limited again. Adding random jitter (e.g., `random() * backoff_time`) spreads the retries over a time window, allowing the external service to recover.

### Decision: Separate Pub/Sub Redis Connection

**Why:** In Redis, when a connection enters `SUBSCRIBE` mode, it is locked into that mode. It can no longer issue standard commands like `SET`, `GET`, or `HINCRBY`. Therefore, the architecture provisions one `ioredis` connection strictly for BullMQ and regular operations, and a completely separate connection reserved exclusively for `subscribeToRun` event listeners.

### Decision: Deterministic `jobId` for Deduplication

**Why:** The `jobId` is constructed as `${runId}:${nodeKey}:${attempt}`. If a network partition causes the control plane to retry a dispatch, BullMQ natively checks the `jobId`. If a job with this ID already exists (in any state: waiting, active, or delayed), the duplicate is silently ignored. This gives us at-least-once delivery from the API and exactly-once processing in the queue.

---

### Decision: Per-Call Subscriber Connection in `subscribeToRun` (Not a Shared Global)

**Why:** The first version of `pubsub.ts` reused the global `pubsub` connection exported from `redis.ts`. That works for *one* subscriber but breaks at N. Three concrete failures:

1. **Channel accumulation.** A subscriber connection accumulates subscriptions across every `subscribeToRun` call it serves. If browser tab 1 subscribes to `run:42:events` and never disconnects (page reload, lost socket), tab 2 calling `subscribeToRun('run:99', ...)` will *also* receive run 42's events because both channels are on the same connection. The shared `pubsub` connection becomes a leak.
2. **Cross-stream message bleed.** A subscriber connection receives every message from every subscribed channel on a single stream. The `onMessage` handler must filter by channel name. If the filter has a bug, events for run 99 surface in tab 1's UI.
3. **Back-pressure coupling.** A slow JSON.parse on one channel stalls delivery for every other channel on the same connection. One misbehaving SSE client freezes every connected client.

The fix (`packages/queue/src/pubsub.ts:36–73`): each `subscribeToRun` call constructs its own `Redis` instance, subscribes to exactly one channel, registers one `message` listener, and returns a cleanup function that unsubscribes + `quit()`s the connection. The cleanup is idempotent (`closed` flag) so caller-side `try/finally` is safe to call multiple times. Per-call connections are cheap — Redis is single-threaded and the per-tab overhead is one TCP socket, not one thread.

`publishRunEvent()` deliberately does **not** open its own connection — publishing does not enter subscriber mode, so it reuses the shared `connection`.

**Trade-off:** More TCP sockets in `TIME_WAIT` on the API box. Acceptable — Redis is on a private network, not over the public internet, and the connection count is bounded by the number of connected SSE clients (typically dozens, not thousands).

---

### Decision: Pipeline-Based `seedInDegrees` (Single Round-Trip for N Nodes)

**Why:** `seedInDegrees` (`packages/queue/src/lua.ts:66–94`) initialises the in-degree hash for every node in a run. Without a pipeline, a 200-node graph would require 200 sequential `HSET` round-trips — at 1 ms RTT that's 200 ms of dead time before the orchestrator can dispatch anything. Using `connection.pipeline()` batches every `HSET` and the two `EXPIRE` calls into one TCP write, which Redis executes serially and replies to in a single batch. Total cost: 1 RTT regardless of graph size.

The pipeline also opportunistically sets `EXPIRE run:{runId}:indegree 604800` and `EXPIRE run:{runId}:dispatched 604800` (7 days) — see the next entry.

**Trade-off:** Pipelined commands are not atomic in the Redis sense (other commands from other clients can interleave between them). For `seedInDegrees` that's fine: nothing else touches the run's in-degree hash until the run is fully seeded. For the decrement path we use Lua instead, because Lua *is* atomic.

---

### Decision: 7-Day TTL on `run:{runId}:indegree` and `run:{runId}:dispatched`

**Why:** Each run creates two Redis hash/set keys that live as long as the run. Without a TTL, a run that crashes mid-execution and is never resumed will leak its keys forever — Redis memory grows monotonically with abandoned runs. A 7-day `EXPIRE` (`packages/queue/src/lua.ts:90–91`) covers two cases:

1. **Recovery window.** If the orchestrator restarts within 7 days, the in-degree and dispatched state is still there — it can re-evaluate `NodeRun.status` rows against `dispatched` and resume without re-seeding.
2. **Housekeeping.** After 7 days with no activity, the keys auto-delete. Redis stays bounded regardless of how many abandoned runs exist.

**Trade-off:** A user who resumes a run after 8 days of downtime loses the in-degree state and must re-seed (the orchestrator reads `NodeRun.status` and rebuilds from scratch). Acceptable — 7 days is far longer than any plausible restart window.

---

**Why:** The first version of `pubsub.ts` defined a local `RunEventPayload` interface that duplicated the `RunEvent` schema from `packages/contracts/src/events.ts`. Two definitions of the same wire format means they will drift — a new `nodeKey?` field added to the contract would not appear in the subscriber's type, causing a silent SSE event-shape mismatch. The fix (`packages/queue/src/pubsub.ts:3,17,49`) imports `RunEvent` directly from `@dag/contracts` and parses inbound messages with `JSON.parse(...) as RunEvent`. Validation of the wire bytes is the SSE/control-plane's job; the queue layer just forwards typed envelopes.

---

## Phase 6 — Orchestrator Loop (`apps/api`)

### Decision: Control Plane Owns Scheduling (Dumb Workers)

**Why:** We could have designed the system so that when a worker finishes `preprocess`, it looks up the graph, sees that `train` is next, and enqueues the `train` job itself. We didn't do this. Instead, workers strictly execute tasks and report completion to the queue. The API (control plane) listens to these completions and decides what runs next. 
If workers enqueued their own children, every worker would need:
1. Full access to the Postgres DB to read the graph.
2. Full knowledge of the orchestration state machine (Lua decrements).
3. The ability to push to any other queue.
By keeping workers "dumb", they can be scaled horizontally infinitely without requiring DB access. The control plane remains the single authoritative source of truth for the DAG's progression.

### Decision: In-Degree Lua Counter as the Runtime Implementation of Kahn's Algorithm

**Why:** Kahn's topological sort is great for static validation, but during runtime, nodes complete asynchronously and dynamically. The orchestrator maps Kahn's in-degree logic to Redis. When a run starts, every node's incoming edges are counted and stored in the Redis hash. When a node succeeds, it triggers an atomic Lua decrement on its children. When a child's counter hits `0`, it means all its dependencies are satisfied, and it is dispatched. This ensures strict topological ordering at runtime across distributed workers.

### Decision: `tryTransitionNodeRun` Checked *Before* Enqueueing

**Why:** The `dispatchNode` function first attempts to update the Postgres `NodeRun` row from `PENDING` to `QUEUED`. If the update fails (returns `false`), the function immediately aborts. If we queued the job first and *then* updated the DB, a concurrent orchestrator process might also queue the job, leading to a double-enqueue. The conditional SQL update acts as a distributed lock — only the actor that successfully changes the DB state is allowed to push to BullMQ.

### Decision: Failures Propagate as `SKIPPED` Rather Than `FAILED`

**Why:** When node A fails, its children (B and C) cannot execute because their inputs will never be produced. If we marked B and C as `FAILED`, it implies they were attempted and errored out, which is untrue and ruins retry metrics. Instead, the orchestrator traverses descendants via BFS and marks them as `SKIPPED`. This clearly differentiates between nodes that genuinely failed and nodes that were preempted by an ancestor's failure.

### Decision: Idempotency Key in `startRun`

**Why:** Network failures happen. A client might hit `POST /runs`, the control plane might successfully start the run and enqueue jobs, but the HTTP response drops. The client will retry. If `startRun` weren't idempotent, the second request would create a duplicate run. By providing an `idempotencyKey` that maps to a `UNIQUE` constraint in Postgres, the API safely returns the existing run on a retry, preventing duplicate orchestration loops.

### Decision: API Process Consumes `QueueEvents`

**Why:** BullMQ provides a `QueueEvents` stream (`completed`, `failed`). Instead of requiring workers to make HTTP callbacks to the API (e.g., `POST /internal/node/complete`), the orchestrator directly consumes the Redis event stream. This reduces moving parts, removes the need for internal API authentication for workers, and keeps the completion-handling logic fully reactive.

---

## Phase 7 — Context Passing (`apps/api/src/context-resolver.ts`)

### Decision: Worker Outputs Bounded to 64 KB; Large Data Travels by Reference

**Why:** If a worker returns a 2 GB trained model or a 500 MB dataset as inline JSON in `NodeRun.output`, several things break simultaneously:
1. **Postgres row bloat.** Every `SELECT * FROM NodeRun WHERE runId=...` would transfer gigabytes per query. The `GET /runs/:id` endpoint would become unusable.
2. **Redis pub/sub saturation.** The `NODE_SUCCEEDED` event is published to `run:{runId}:events` via Redis pub/sub. Redis messages have a practical size limit of a few MB. A 2 GB message would never deliver.
3. **Memory pressure.** The orchestrator holds the full output in memory while dispatching children. With concurrent runs, this leads to OOM crashes.

The fix: workers write large data to a shared artifact volume and return a reference object: `{ "path": "artifacts/{runId}/{nodeKey}/model.pt", "rows": 48213, "checksum": "sha256:..." }`. These references are typically < 1 KB. The 64 KB limit is enforced by `assertOutputSize()` before any DB write.

### Decision: Template Resolution at Dispatch Time (Not at Run-Start Time or Worker Time)

**Why:** There are three possible resolution points:
1. **Run-start time.** Templates could be resolved once when `startRun` is called and stored on the `WorkflowVersion`. But parent outputs don't exist yet — `preprocess` hasn't run, so `{{ nodes.preprocess.output.metadataPath }}` has nothing to resolve against.
2. **Worker execution time.** The worker could receive the raw templates and call back to the API to resolve them at execution time. This couples the worker to the control plane's internal state, violates the "workers stay dumb" principle, and introduces a network round-trip inside the worker's hot path.
3. **Dispatch time (chosen).** When `dispatchNode` is called for `train`, the parent `preprocess` has already been marked `SUCCEEDED` (that's what triggered the dispatch). Its output is available in Postgres. Resolution is immediate, in-process, and requires no extra network calls.

Dispatch time is the only window where: (a) the parent's output exists, and (b) we haven't yet committed to running the child.

### Decision: Unresolved Template = Hard Failure (Not `undefined`)

**Why:** If `{{ nodes.preprocess.output.metadataPath }}` resolves to `undefined` and we pass it to the worker as `undefined` (or worse, omit it entirely), the worker will crash with a confusing `TypeError: cannot read property of undefined` pointing at its own code. The actual bug is the misspelled template in the workflow definition — a problem in the control plane, not in the worker. By throwing `UnresolvedTemplateError` at dispatch time with the offending template string in the message, the failure is attributed correctly and the user sees an actionable error instead of a cryptic worker crash.

### Decision: Resolved Input Persisted on `NodeRun.input` Before Enqueueing

**Why:** Reproducibility and auditability. A worker may be retried weeks after the original run. If we only stored the template (e.g. `{{ nodes.preprocess.output.metadataPath }}`), a later audit or replay would need to re-run the resolver — which assumes the parent's output is still in Postgres and hasn't been purged. By persisting the literal resolved value (e.g. `"artifacts/run-123/preprocess/metadata.csv"`) on `NodeRun.input` before the job is pushed, every past execution is self-contained: a forensic engineer can look at any NodeRun row and see exactly what the worker received.

---

## Phase 8 — Worker Data Plane (`apps/worker`)

### Decision: `Record<NodeType, ExecutorFn>` Not `Partial<Record<...>>`

**Why:** Using `Partial` would make every executor optional, meaning a missing `"torch.train"` executor compiles fine and only crashes at runtime when the first GPU job is dequeued. `Record<NodeType, ExecutorFn>` (non-partial) forces all keys to be present at compile time. Adding a new `NodeType` in `packages/contracts` without a corresponding executor becomes a compile error, not a runtime crash. This is the TypeScript exhaustiveness pattern: the discriminated union on `NodeType` propagates its exhaustiveness check all the way to the executor registry.

### Decision: JSON over stdio for the Node↔Python Bridge (Not REST or Shared DB)

**Why:** There are three candidate IPC mechanisms:

1. **REST callback.** The Python script would call `POST /internal/result` to return its output. This requires the script to know the API URL, carry an auth token, handle retries if the API is temporarily unavailable, and introduces a network dependency into every executor. It also means the worker can't run in an air-gapped environment.

2. **Shared database table.** The script writes a row to a Postgres table. This couples every Python script to the Prisma schema and requires a DB connection (and driver) inside each script. Schema migrations would need to be coordinated with the Python layer.

3. **JSON over stdio (chosen).** The script reads from stdin and writes to stdout. Zero network dependency, zero auth tokens, zero DB connections. The protocol is testable with `echo '{"msg":"hello"}' | python3 preprocess.py`. The `::RESULT::` sentinel is unambiguous — no collisions with log output. Stderr is fully preserved for debugging without any extra plumbing.

### Decision: Write to `*.tmp` then `fs.renameSync` (Atomic Write)

**Why:** A crash (SIGKILL, OOM, power loss) mid-write leaves a partial file. If `result.json` is 50% written and the worker restarts, the idempotency check sees `result.json` exists and returns the corrupted half-file as the "cached" result. The downstream node receives malformed JSON.

`fs.renameSync` on the same filesystem is atomic at the OS level: the inode swap is a single system call. The `.tmp` file may be left behind on a crash, but the target file only ever contains complete data. On restart, the executor sees `result.json` does not exist (only the orphaned `.tmp` does) and re-runs cleanly.

### Decision: Heartbeats via `job.extendLock()` for Long-Running Tasks

**Why:** BullMQ uses a Redis lock with a TTL (`lockDuration`) to detect stalled workers. If a worker grabs a job and then crashes (SIGKILL), no one releases the lock — BullMQ waits for the TTL to expire before re-delivering. This is by design. But for long-running jobs (`torch.train` taking 2 hours), the lock TTL (60 s) expires while the job is still running normally, causing BullMQ to falsely re-deliver it to a second worker. Two workers now train in parallel on the same data — duplicating GPU cost and potentially creating corrupted state if both write to the same weights file. `startHeartbeat()` calls `job.extendLock()` every 15 s (well within the 60 s TTL), keeping the lock alive for exactly as long as the job is genuinely running.

---

## Phase 9 — Fault Tolerance (`apps/worker`, `packages/queue`)

### Decision: Two Error Classes — `RetryableError` vs `UnrecoverableError`

**Why:** The retry budget is finite and expensive. Retrying a Kaggle `403 Unauthorized` (bad API key) three times with exponential backoff takes ~14 seconds, burns API quota on three doomed requests, and still ends in failure. Worse, if the user has set `attempts: 10`, it retries ten times. The fix is not to retry at all. BullMQ's `UnrecoverableError` is a special subclass that signals the queue to move the job directly to the failed set, skipping all remaining attempts. Classifying each error as retryable or unrecoverable at the throw site — rather than at the caller — keeps the policy close to the knowledge of what went wrong.

### Decision: Full Jitter Over Exponential Backoff (Thundering Herd Prevention)

**Why:** Standard exponential backoff (wait 2 s, 4 s, 8 s …) is deterministic. If Kaggle's rate-limit window resets at exactly T+0, all 50 retrying jobs wake up at T+2 and hammer the API simultaneously, triggering another rate-limit. They all wait 4 s and try again. This thundering herd repeats until the cap. Full jitter (`random(0, min(cap, base * 2^attempt))`) desynchronises the retries. The expected wait is half of the deterministic case, but the key property is that each job's wake-up time is independent. The load spreads across the window and the external service has room to recover between individual requests.

### Decision: Per-Run Redis Semaphore (`semaphore.ts`)

**Why:** A single graph with 200 parallel nodes would enqueue all 200 jobs instantly. With 10 workers at concurrency 8 (80 slots), that's 80 simultaneous Kaggle downloads, S3 reads, and GPU jobs from a single user's run. This would starve all other runs in the cluster. The semaphore uses a Redis SET (atomic via Lua) as a counter: before dispatching a node, the orchestrator calls `acquireConcurrencySlot()`. If the run already holds `maxSlots` (default: 10), dispatch is deferred. The slot is released in the worker's completion handler, allowing the next queued node to proceed.

### Decision: `retry-failed` Resets Attempt Counter on FAILED Nodes

**Why:** When a node fails on attempt 3 (the final attempt), its `NodeRun.attempt` is 3. If we reset it to PENDING without incrementing, the deterministic `jobId` `${runId}:${nodeKey}:3` already exists in BullMQ's failed set. Enqueuing with the same ID would either be deduplicated (silently no-op) or collide. By incrementing `attempt` to 4 before re-dispatching, the new `jobId` is `${runId}:${nodeKey}:4` — guaranteed unique. The existing failed job record at attempt 3 remains in BullMQ's failed set as a permanent audit trail.

---

## Phase 10 — SSE Streaming (`apps/api/src/services/sse.service.ts`)

### Decision: SSE Over WebSockets

**Why:** The run status stream is strictly server→client. WebSockets are a full-duplex protocol; using them here adds an HTTP upgrade handshake, custom message framing, explicit ping/pong, and a larger surface area in the proxy config. SSE uses plain HTTP/1.1 chunked transfer, passes through nginx/ALB/CloudFront with a single `proxy_read_timeout` setting, and uses the browser's native `EventSource` API — which handles reconnection automatically, including sending `Last-Event-ID`. When would we flip to WebSockets? If the client needed to push data back — live terminal input, collaborative graph editing, graph position sync — the bidirectionality of WebSockets would become necessary.

### Decision: Write Events to BOTH Postgres and Redis Pub/Sub

**Why:** Redis pub/sub is fire-and-forget. A message published to `run:{runId}:events` while a subscriber is disconnected is permanently discarded. Without Postgres persistence, a client reconnecting after a 5-second network blip would re-subscribe to pub/sub but all events from the disconnect window are gone. The client has no way to know whether `RUN_SUCCEEDED` fired during the gap — it would display the run as permanently in-progress. Persisting every event to `RunEvent` and replaying on reconnect (using `Last-Event-ID` as the cursor) gives the client a complete, ordered, gapless view of history, regardless of how many times it disconnects.

### Decision: Dedicated Redis Subscriber Connection Per SSE Client

**Why:** A Redis connection that has called `SUBSCRIBE` enters subscriber mode — it can no longer issue regular commands. If we shared one Redis connection across all SSE clients, issuing `PUBLISH` (required by the orchestrator) on that connection would fail. Worse, sharing one subscriber connection across 100 clients means all 100 receive every message and must filter by channel in userland — messages for run A are delivered to the handler for run B and silently discarded. By spawning a dedicated `new Redis(REDIS_URL)` per `subscribeToRun()` call, each client has a clean, isolated subscriber with no interference from other clients or the main connection.

### Decision: 200 ms Log Buffer for `NODE_LOG` Events

**Why:** Without buffering, a chatty training loop emitting 200 lines/s creates 200 SSE frames/s. Each frame is a `res.write()` call, a TCP segment, and a browser DOM event. Node.js's event loop spends more time on I/O plumbing than on actual request handling. The browser's `EventSource` callback fires 200 times per second, each time updating the log pane — causing 200 DOM mutations/s on a single element, which overwhelms the browser's layout engine. Buffering at 200 ms collapses these into ≤5 `NODE_LOG_BATCH` frames per second, reducing both server write overhead and browser layout cost by 40×, while keeping apparent log latency below human perception threshold (~200 ms).

---

## Phase 11 — Visual Graph Editor (`apps/web`)

### Decision: Zustand over React Context for Live State

**Why:** SSE events arrive continuously during a run. If `runSlice` state (node statuses, logs) were placed in React Context, every tick would trigger a top-down re-render of all components consuming that context. In a 50-node graph, this means 50+ unnecessary DOM reconciliations per second. Zustand supports **selector granularity**, meaning `useRunStore(s => s.nodeStatuses[id])` specifically subscribes to that exact node's status. When a tick updates node "train", only the "train" `CustomNode` component re-renders. The rest of the canvas remains completely untouched.

### Decision: Bridging React Flow to Zustand via the Store

**Why:** React Flow's `onNodesChange` and `onEdgesChange` provide diffs for user interactions (drags, selections, edge creation). Instead of applying these diffs to local component state, we route them through `useGraphStore.getState().onNodesChange`. This enforces Zustand as the single source of truth for the entire graph topology, allowing us to accurately serialize `toGraph()` at any time for the API, and keeping validation and save logic perfectly decoupled from React Flow's render cycle.

### Decision: Client-Side Cycle Detection using `@dag/graph-core`

**Why:** Instead of rewriting cycle detection in the frontend or calling an API endpoint on every edge drop, we directly import `detectCycle` from `@dag/graph-core`. Because we strictly adhered to the zero-dependency rule in Phase 2, this package compiles natively for the browser. This allows the UI to reject cycles instantly during `onConnect` operations, flashing a red highlight on the cycle path, providing zero-latency UX feedback while the backend maintains the same logic for ultimate validation.

### Decision: Schema-Driven Dynamic Configuration Forms

**Why:** Hardcoding React form templates for `Kaggle Node`, `Train Node`, etc., scales poorly as the platform adds executors. By building a generic `ConfigPanel` that loops over a predefined list of schema fields (derived directly from the node's Zod schema in a production setup), adding a new executor type to the UI becomes a purely declarative change. The form automatically renders text inputs, numbers, or dropdowns based on the schema's field type.

---

## Phase 12 — Testing, Observability, and Load Proof

### Decision: Testcontainers, Not Mocking, for the Integration Suite

**Why:** The fast unit suite (Phases 0–11) mocks `@dag/db`/`@dag/queue` at the module boundary — correct for testing business logic in isolation, but structurally incapable of catching bugs that live in the boundary itself: whether a Postgres conditional `UPDATE` actually serializes two concurrent writers, whether the Lua script is actually atomic under load, whether BullMQ's lock/stall machinery actually re-delivers a job. A mock returns whatever the test tells it to return; it cannot disagree with the test the way real infrastructure can. Testcontainers gives every test run a real, disposable `postgres:16` + `redis:7-alpine` — the same images `infra/docker-compose.yml` uses — so a passing test is evidence about the real system, not about the mock's fidelity to the tester's mental model.

**Trade-off:** An integration test run costs real wall-clock time (tens of seconds to boot two containers, push the schema, spawn worker processes) versus milliseconds for the mocked suite. This is why it's a separate `pnpm test:integration` command and `vitest.integration.config.ts`, not folded into the default `pnpm test`.

### Decision: `globalSetup` + JSON Handoff File, Not `process.env` in `beforeAll`

**Why:** `@dag/db`'s `prisma` and `@dag/queue`'s `connection`/`ioQueue`/`cpuQueue`/`gpuQueue` are module-level singletons constructed at import time from `process.env.DATABASE_URL`/`REDIS_URL`. Testcontainers only knows the mapped port after the container starts — but a static `import` at the top of a test file is hoisted and evaluates before `beforeAll` ever runs, so by the time `beforeAll` could set `process.env`, the wrong (or absent) URL has already been baked into the singleton. Two alternatives were considered and rejected:
1. **Vitest's `provide`/`inject` context API** — the officially "correct" mechanism, but its exact signature has shifted across Vitest minor versions, and getting it wrong fails silently in ways that are hard to diagnose from a Testcontainers boot log.
2. **One Testcontainers instance per test file** — simplest to reason about, but multiplies the ~10s container-boot cost by five files for zero isolation benefit (nothing in this suite needs isolation stronger than a unique `runId`, which `cuid()` already guarantees).

The chosen fix: `global-setup.ts` starts the containers once, writes `{ databaseUrl, redisUrl, artifactDir }` to a JSON file in the OS temp directory, and every test file's `bootstrapTestEnv()` reads that file synchronously, sets `process.env`, and only *then* performs a **dynamic** `import('@dag/db')` / `import('@dag/queue')`. Dynamic imports are not hoisted — they run exactly where they're written, after the env is set. Vitest's default `test.isolate: true` gives each test file a fresh module registry, so this pattern is safe to repeat per file without cross-file leakage.

### Decision: Two Shared Worker Processes, Spawned Once in `global-setup.ts`

**Why:** The first version of this suite spawned worker process(es) per test file (matching Phase 8's "2 worker processes" framing literally, once per file). On this project's Windows dev machine that meant 5+ separate `tsx`-plus-`python3` process trees forked over the lifetime of one `vitest run` — slow enough to occasionally blow past a test's own wait budget, and on at least one run, severe enough to crash the entire suite with a native access violation (Windows exit code `3221225477` / `0xC0000005`). Spawning exactly two worker processes once, in `global-setup.ts`, and leaving them running for every test file removed the flakiness in repeated testing and is arguably *more* representative of production: a real deployment has a standing fleet of workers serving many runs, not one worker spun up and torn down per run.

**Consequence this forced elsewhere:** the race-condition test can no longer dispatch `a`/`b`/`c` through the real `startRun`/`dispatchNode` path, because the now-always-on shared workers would race to execute them before the test's own deterministic `Promise.all` gets a turn. See the next entry.

### Decision: `pool: 'forks'` for the Integration Vitest Config

**Why:** Vitest's default `'threads'` pool runs each test file inside a worker *thread*, tearing down and re-creating a V8 isolate within the same OS process between files. Every integration test file opens real `ioredis`/BullMQ/Prisma connections; a native callback firing after its owning isolate had already been destroyed is the leading suspect for the access-violation crash described above (it appeared specifically at file-transition boundaries, never mid-file). `pool: 'forks'` gives each file a genuinely separate OS process instead of a thread inside a shared one — the standard fix for exactly this class of native-module-plus-worker-threads instability. Four consecutive clean runs followed this change; zero followed the switch to `singleFork` alone (still one process for everything) or `threads` (the original config).

**Trade-off:** Forking an OS process per file is slower to start than spinning up a thread. Acceptable here — the containers themselves already dominate the suite's wall-clock cost.

### Decision: Race-Condition Test Seeds `b`/`c` Directly, Not via `startRun`

**Why:** With two shared worker processes always polling the queues (see above), any *real* `dispatchNode` call puts a real BullMQ job where those workers will race to grab and execute it — including the two nodes (`b`, `c`) whose *simultaneous completion* is the entire point of the test. If the shared workers execute them first, the test's own `Promise.all([onNodeSucceeded('b'), onNodeSucceeded('c')])` either double-processes an already-terminal node (silently no-ops, per the conditional-update guard) or races something that already happened, defeating the deterministic setup. The fix: seed `a`, `b`, `c`'s `NodeRun` rows and the Redis in-degree hash directly via Postgres/Redis writes — no BullMQ job is ever created for them, so nothing else can touch them before the test's own forced interleaving does. Only `d` — the actual subject of the assertion — goes through the real `dispatchNode` → `queue.add()` path, so the thing being proven (`d` dispatches exactly once) is still fully real, only the unrelated setup steps are hand-rolled.

### Decision: `/metrics` Gauges Are Recomputed Per Scrape, the Duration Histogram Is Observed at Transition Time

**Why:** Two different kinds of metric need two different collection strategies. "How many NodeRuns are currently RUNNING" is a *snapshot* of current DB state — it can be answered correctly at any moment by asking Postgres directly (`groupBy` on `status`), and doing so guarantees the number is always exactly right, immune to any call site anywhere in the codebase forgetting to increment/decrement a counter. "What was the p95 node execution duration" is a *time series* — the DB doesn't retain a history of past durations anywhere, only the latest `startedAt`/`finishedAt` on each row, so there is no scrape-time query that could reconstruct it after the fact. That number can only be captured by observing it at the moment it's known, inside `onNodeSucceeded`/`onNodeFailed`, into a `prom-client` `Histogram`. Using the wrong strategy for either would either (a) require invasive counter-increment code at five call sites for the gauges, with real drift risk, or (b) be structurally impossible for the histogram.

### Decision: The Scale Test Is a Standalone Script, Not a `pnpm test` Suite Member

**Why:** `pnpm -r test` (and even `pnpm test:integration`) are meant to run on every change and fail fast — they need to be fast and deterministic. A load test that fires 200 concurrent runs of a 10-node graph across real worker processes takes on the order of a minute or more by design (that's what makes it a *load* test), and its purpose is to produce a **result** (a throughput/latency/queue-depth table for the README), not a pass/fail signal. Making it a `test` file would either slow down every CI run for no correctness benefit, or get skip-guarded into irrelevance the way `orchestrator.test.ts`'s real-infra tests were before Testcontainers existed. `scripts/scale-test.ts` is deliberately a benchmark, run by a human (or a scheduled job) when evidence is wanted, following the same convention as `scripts/check-infra.ts`.

### Decision: The Scale-Test Graph Is a Fan-Out/Fan-In Shape, Not a Chain

**Why:** The acceptance check needs to stress queue depth and worker concurrency, and a straight 10-node chain cannot do that: at any instant, at most `RUNS` nodes (one per run) can possibly be ready to dispatch, since every node in a chain has exactly one predecessor. A `root → 8 parallel branches → sink` shape means, the moment every run's `root` completes, up to `RUNS × 8` nodes become ready near-simultaneously — with 200 runs, up to 1,600 nodes racing for `queue:cpu` slots at once. That burst, and how differently 1 worker versus 4 workers absorb it, is precisely the horizontal-scaling signal the benchmark exists to produce; a chain would only ever show a mild, hard-to-interpret difference.

### Decision: Prisma's `connection_limit` Is Bounded Per Process, Sized Differently for Workers vs. the Control Plane

**Why:** Running the scale test's 4-worker pass hit real Postgres exhaustion (`FATAL: sorry, too many clients already`) — not a simulated failure, an actual limit. Each worker *process* constructs its own `PrismaClient`, and Prisma's default pool size (`num_cpus * 2 + 1`) is sized as if that client owned the whole connection budget; it doesn't know four other processes made the same assumption. `packages/db/src/client.ts` now appends `connection_limit`/`pool_timeout` to the connection string it actually uses (`DB_POOL_SIZE` env var, default 5). The default is deliberately small — worker processes mostly issue one conditional `UPDATE` at a time (`tryTransitionNodeRun`), not wide parallel fan-out — but the scale test's control-plane process (the script driving all 200 concurrent runs' `startRun`/`onNodeSucceeded` calls through one `PrismaClient`) needs far more concurrency than that, so it explicitly overrides `DB_POOL_SIZE=30` for itself while pinning `DB_POOL_SIZE=5` in the env it hands to spawned workers — an explicit override was necessary because `spawnWorkerProcess` otherwise inherits the parent's `process.env`, which would have handed workers the control-plane's oversized pool too.

**Trade-off:** A fixed default requires a human to reason about the arithmetic (`N processes × connection_limit < Postgres max_connections`) rather than something that self-tunes. Acceptable for a project of this scope; a production deployment at real scale would put PgBouncer or Prisma Accelerate in front of Postgres instead of hand-sizing per-process pools (the Prisma CLI's own error output points at exactly this).

### Decision: Kill the Whole Process Tree on Windows, Not Just the Immediate Child

**Why:** Every worker process in this suite is spawned with `shell: true` (the resolved `tsx` binary is a `.CMD` shim on Windows, which can only be executed through a shell). On Windows, the `ChildProcess` object returned by `spawn()` in that case refers to the **shell** (`cmd.exe`), not the `node.exe` process the shim eventually execs. Calling `proc.kill('SIGTERM')` signals only that shell — which may have already exited by the time the real worker is up and running — leaving the actual worker process **orphaned**: still alive, still holding its Postgres connection pool and Redis connections, invisible to anything tracking the original `ChildProcess` handle. This was a real, repeatable bug: every "stopped" worker from every prior test/benchmark run in this session was, in fact, still running, and by the fourth or fifth accumulated run, Postgres's `max_connections` was exhausted before a new pass even started — the exact failure this section's connection-pool fix was originally written to explain, until process-tree leakage turned out to be compounding it. Fixed with `taskkill /PID <pid> /T /F` on `win32` (`/T` recurses through Windows' own recorded parent-PID chain, which persists even after an intermediate shell has exited) and the POSIX equivalent, a negative-PID `process.kill(-pid, 'SIGKILL')` targeting the whole process group — the same technique `python-bridge.ts` already uses to kill a timed-out Python child's descendants.

### Known gap: `pnpm -r lint` has pre-existing failures outside Phase 12's scope

Running `pnpm -r lint` across the whole repository while closing out Phase 12 surfaced ~30 pre-existing errors in `apps/api` and `apps/worker` — mostly `@typescript-eslint/no-explicit-any` in code written in Phases 4–10 (`orchestrator.service.ts`, `sse.service.ts`, `worker.ts`, several test files) and a handful of unused imports/variables. None of them are in files this phase created; `pnpm -r lint` had apparently never actually been run clean before. Phase 12's own new files (`apps/api/src/integration/*`, `metrics.ts`, `scripts/scale-test.ts`) and the frontend's Phase 11 lint errors (14, all trivial — unused imports/vars, a few `any`s) were fixed as part of this phase's own cleanup, since they were small and low-risk to touch. The ~30 remaining errors in `apps/api`/`apps/worker` were **not** fixed: correcting them means touching orchestrator/SSE/worker logic written and reviewed in earlier phases, which is real surface area outside Phase 12's stated scope (testing, observability, load proof) and carries real risk of introducing a behavioral regression in code this phase didn't otherwise need to change. Silently fixing them in passing would also hide that they existed at all. Recorded here, honestly, as a backlog item for whichever phase picks it up — most likely worth a dedicated pass before or during Phase 14's consolidation, alongside the "no committed Prisma migrations" gap already on record.

### Decision: `startRun`/`retryFailedNodesService` Bugs Found by Testing, Fixed in Place

**Why:** See architecture.md's Phase 12 section for the full description of both bugs. Both were fixed directly in `orchestrator.service.ts`/`run.service.ts` rather than worked around in the test. The workflow's own guardrail is explicit here — "if an acceptance check fails, stop and report; do not soften the check" — and softening would have meant either relaxing the test's assertions (masking a real bug from every future reader) or leaving the bug undocumented. Both are exactly the kind of defect a mocked test cannot surface: a mock of `tryTransitionRun` would have returned whatever the test told it to, never exposing that the *caller* ignored its own return value.

---

## Phase 13 — Containerisation and Horizontal Scaling

### Decision: Run Production Containers via `tsx`, Not a `tsc`-Compiled `dist/`

**Why:** `packages/contracts`, `graph-core`, `db`, and `queue` are pure TypeScript source — each package's `package.json` points `"main"` straight at `./src/index.ts` (see ADR-001's zero-publish-step rationale in architecture.md's Phase 0 section). That's a deliberate Phase 0 decision: `workspace:*` resolves directly to source, so a change to `graph-core` is instantly visible to every consumer with no build step and no version drift. The cost of that convenience only shows up at the very end of the pipeline, in production: a `tsc`-compiled `apps/api/dist/index.js` still contains `require('@dag/db')`, and Node's CommonJS resolution follows that straight to `packages/db/package.json`'s `"main": "./src/index.ts"` — a `.ts` file plain `node` cannot execute. Three options existed:

1. **Give every package a real build step** (its own `tsc` compiling to `dist/`, `"main"` repointed there) — the textbook-correct fix, but it reopens the exact trade-off Phase 0 deliberately closed (a publish/build step between packages), touches five packages this phase didn't otherwise need to change, and risks subtly breaking the "instant visibility of a change" property the whole monorepo is built around.
2. **Bundle each app with esbuild/ncc into one self-contained JS file** — solves the resolution problem without a build step per package, but introduces a new build tool and a new class of bug (bundler-specific resolution quirks) for a project whose whole point is depth in the parts that matter (graph algorithms, distributed dispatch), not packaging cleverness.
3. **Run via `tsx` in production, exactly as dev already does** (chosen) — `tsx` is already how every `pnpm dev` script runs, and how every Phase 12 integration test and the scale-test benchmark spawned real worker processes. Docker just runs the identical command. No new code path gets introduced at the one moment (production) that matters most for correctness.

**Trade-off:** Every container pays a small on-the-fly transpilation cost at startup (milliseconds, not seconds, in practice) instead of shipping pre-compiled JS, and `tsx` itself has to ship in the runtime image rather than being a discardable build-time-only tool. Acceptable for a project at this scale; a team optimizing cold-start latency at real production scale would eventually want option 1.

### Decision: `tsx` Moved from `devDependencies` to `dependencies` in `apps/api`/`apps/worker`

**Why:** Consequence of the decision above. The Dockerfile's runtime stage runs `pnpm prune --prod` to strip devDependencies out of the already-installed `node_modules` (see the `pnpm prune --prod` decision below) — if `tsx` stayed a devDependency, prune would remove the very binary the container's `CMD` needs to run, and the container would fail to start. Moving it to `dependencies` is a direct, honest reflection of reality: `tsx` is not a dev-only tool in this project, it's the production runtime interpreter.

### Decision: `pnpm fetch` → full install → `pnpm prune --prod` (Not a Second Install)

**Why:** The standard advice for a slim pnpm-in-Docker image is "install once with devDependencies (needed for codegen/build steps), then produce a second, prod-only install for the runtime image." The naive way to do that second install is to run `pnpm install --offline --prod` again in a fresh stage — but that requires the pnpm content-addressable store to still be present and correctly populated in that stage, adding another `pnpm fetch`-equivalent layer to keep in sync. `pnpm prune --prod` instead takes the tree that's *already installed* (from the one `pnpm install` in the `build` stage) and removes devDependency packages from it **in place** — a lighter, single-source-of-truth operation: there is only ever one `pnpm install` in the whole build, and pruning is a deterministic function of it, not a second independent resolution that could in principle disagree with the first.

### Decision: `apk add python3` in the Worker Image, Deliberately Not `pip install pandas torch`

**Why:** PROJECT_GUIDE.md's reference use case describes `torch.train` as running "custom architectures / hybrid loss functions" — but the actual fixture scripts (`apps/worker/python/*.py`, documented in Phase 12) are pure-stdlib stand-ins that exist to exercise the real Node↔Python bridge, idempotency, and heartbeat machinery under test and load, and deliberately never import `pandas` or `torch` (see the Phase 12 "why the fixtures avoid heavy ML dependencies" note). Installing real PyTorch wheels (typically several hundred MB to multiple GB, especially with CUDA support) into this image would be pure image bloat for code that never imports them — directly working against this phase's own "slim runtime" goal for zero functional benefit. The Dockerfile's header comment names the exact line (`RUN pip3 install -r requirements.txt`) a deployment with real ML scripts would add, so the gap is a documented, deliberate scope boundary, not an oversight.

### Decision: `packageManager` Field Pinned, Base Image Bumped to `node:22-alpine`

**Why:** Two related build failures, both worth recording because neither was where the error message pointed first.

1. `corepack enable` with no version pin downloads whatever pnpm currently ships as "latest" — which requires Node.js ≥22.13 and refuses to run under Node 20 at all (`this version of pnpm requires at least Node.js v22.13`). Adding `packageManager: "pnpm@11.6.0"` to the root `package.json` (matching the version already used locally and in every other phase of this project) and calling `corepack prepare pnpm@11.6.0 --activate` explicitly in each Dockerfile's base stage pins the exact version — but only once `package.json` is actually present in the build context at that point, which required also adding it to the `fetch` stage's `COPY` (it was previously copied only in the later `build` stage, after the fetch step had already run).
2. Pinning to 11.6.0 did **not** fix the underlying problem: pnpm 11.6.0 itself — the same version installed locally on this project's own dev machine, under local Node 22.14 — imports `node:sqlite`, a Node.js builtin only available from Node 22.5 onward. This was never a "corepack grabbed the wrong version" bug; pnpm 11.x genuinely requires Node 22, full stop, and the local dev environment had simply never surfaced this because it already runs Node 22. The real fix was bumping every Dockerfile's base image from `node:20-alpine` to `node:22-alpine` — which PROJECT_GUIDE.md's tech-stack table ("Node.js 20+") already permits, since "+" means 20 or newer, not exactly 20.

The lesson generalizes: a Docker build is the first time a project's *actual* toolchain requirements get checked against a truly clean, minimal environment — no locally-installed Node version quietly satisfying an unstated requirement. This is the same category of value Testcontainers provided in Phase 12 (real infrastructure surfaces real bugs mocks/assumptions can't), just applied to the build environment instead of the runtime one.

### Decision: `migrate` Service Builds from the `build` Target, Not `runtime`

**Why:** `prisma migrate deploy` needs the Prisma CLI, which is a devDependency of `packages/db` — exactly the kind of package `pnpm prune --prod` (used to produce the slim `runtime` target) deliberately removes. Rather than add the Prisma CLI back into the runtime image (permanently paying its weight in every API/worker container, forever, for a command that only ever runs once at cluster startup), the `migrate` compose service targets Dockerfile.api's `build` stage directly — the one stage that still has every devDependency installed. This keeps the *actual* runtime images (`api`, `worker`) as slim as `pnpm prune --prod` can make them, while the migration runner — which exists for seconds per deployment, not for the cluster's lifetime — pays the (irrelevant, one-time) cost of a fuller image.

### Decision: `service_completed_successfully` Gates API/Worker Startup on the Migration, Not a Fixed Sleep

**Why:** The naive alternative — start API/worker after a fixed delay, or after Postgres merely reports `healthy` — races against the schema itself. `pg_isready` (Postgres's own healthcheck) only proves the database process is accepting connections; it says nothing about whether `NodeRun`, `RunEvent`, and every other table `@dag/db`'s repository helpers assume exist have actually been created yet. Docker Compose's `depends_on: { migrate: { condition: service_completed_successfully } }` makes "the schema is migrated" an explicit precondition the orchestrator enforces structurally — API and worker containers simply do not start their entrypoint process until the `migrate` container has exited with code 0. No fixed sleep to tune, no race to get unlucky with on a slower machine.

### Decision: Workers Take Zero Compose-Level Per-Replica Configuration

**Why:** This is the direct verification of PROJECT_GUIDE §4's "workers are stateless and replica-safe" claim, not just an assertion of it. The `worker` service definition has no `container_name` (which would collide across replicas — Compose would refuse to start a second one), no per-instance environment override, and no manual `WORKER_ID` assignment. `docker compose up --scale worker=4` creates four containers from the *identical* service definition; each one's `WORKER_ID` falls back to `worker-${process.pid}` (`apps/worker/src/worker.ts`) — a real process ID, unique per container by construction, needing no coordination between replicas. If workers held any in-process run state (a queue-position counter, a cache of "which nodes I've already seen"), this configuration would immediately break — two replicas would produce colliding or duplicate `workerId`s or worse, duplicate work. That it doesn't need to break is the whole point of the "control plane owns scheduling, workers stay dumb" decision from Phase 6: the workers have nothing distinguishing them from one another except their own process identity, so scaling them is adding interchangeable capacity, not provisioning N different things.

### Decision: One Shared Named Volume for `ARTIFACT_DIR`, Mounted Only Into Workers

**Why:** PROJECT_GUIDE §4's "preprocess on worker 1, train on worker 2" scenario only works if every worker container sees every other worker's output files at the identical path — with N independent container filesystems and no shared volume, `train`'s worker would look for `preprocess`'s `metadata.csv` at a path that simply doesn't exist in its own container, a guaranteed failure the moment two dependent nodes in the same run land on different worker replicas (which `docker compose up --scale worker=4` makes likely for anything beyond a trivial single-node graph). A Docker named volume (`artifact_data`) mounted at the same container path (`/data/artifacts`) in every worker replica gives every worker process an identical view of the shared filesystem, functionally equivalent to a real deployment's shared network filesystem or object store. The `api` service does **not** mount this volume: the control plane never reads or writes artifact files directly — `NodeRun.output` only ever holds the small JSON reference object (a path string, a checksum, a row count — see Phase 7's 64 KB output contract), never the artifact's actual bytes — so mounting the volume into `api` would add a dependency with no corresponding code path that uses it.

---

## Phase 14 — Documentation Consolidation

### Decision: `KNOWN_LIMITATIONS.md` Lives at the Repo Root, Not Inside `knowledge_base/`

**Why:** A limitations file buried in a subdirectory is invisible to anyone doing a quick repository
scan. Placing it at the root, next to `README.md`, makes a deliberate statement: the authors have
thought about what the system *doesn't* do and are not hiding it. In a hiring or code-review
context, the ability to enumerate your own gaps precisely — and sketch what closing each one
requires — is a stronger signal of ownership than a system that appears flawless because no one
wrote down the edge cases.

**Trade-off:** It adds one more file to the root, which is already fairly populated. Acceptable —
`README.md`, `PROJECT_GUIDE.md`, and `KNOWN_LIMITATIONS.md` are all entry points for different
reader types (quickstart, architecture, honest audit) and benefit from equal prominence.

---

### Decision: 10 Limitations Listed — What Was Included and What Was Deliberately Omitted

**Included:**
- Multi-tenancy auth gap — because it's a security boundary, not just a feature gap. An
  interviewer asking "how would you productionise this?" will ask about auth first.
- Shared volume vs. object storage — because it's the first thing that *silently breaks* in a
  real Kubernetes deployment, with no error message, just a missing file.
- Uncommitted Prisma migrations — because it's a correctness gap: `migrate deploy` in a fresh
  environment would fail without committed migration files.
- Lint backlog — because not recording it would be dishonest; it was already noted in
  decisions_log Phase 12.

**Omitted:**
- "No UI authentication" — deliberately redundant with the multi-tenancy auth gap entry; listing
  both would read as padding.
- "No pagination on `GET /runs/:id/events`" — genuinely minor; the `Last-Event-ID` cursor already
  gives incremental delivery and the endpoint is SSE, not a paginated REST resource.
- "No distributed tracing (OpenTelemetry)" — a real gap in a production system, but orthogonal to
  the architectural claims this project makes. Listing it would imply it was planned and dropped,
  which it wasn't; it was always out of scope.

---

### Decision: System Design Walkthrough Format — Narrative, Not Bullet Points

**Why:** An interviewer asking "walk me through your system" is not asking for a list of
components. They want to hear you *think* — how one decision leads to the next, how the pieces
connect, what trade-offs you made and why. A bullet-point answer ("1. User draws graph. 2. API
validates. 3. Worker runs.") is easy to produce and easy to forget. A narrative that follows a
single request from the browser click to the SSE frame the browser receives is:
- Harder to fake without genuine understanding
- Self-organising (each sentence sets up the next)
- Interview-proven: it lets the interviewer interrupt naturally at any technical junction ("wait,
  why a Lua script there?") and receive a complete answer without disrupting the flow

The walkthrough in `system_design_walkthrough.md` is written to be spoken, not read. It is
structured as six numbered steps that map exactly to the architecture diagram on the whiteboard,
so the interviewer can follow along visually.

---

### Decision: Phase 14 Adds No Code — Only Documents What Was Built

**Why:** The build-dag-engine workflow is explicit: "do not soften the check and do not skip
ahead." Phase 14's acceptance check is "a reader who has never seen the repo can go from clone
to a successful pipeline run using only the README, and every ADR referenced in the index exists."
Both are already true from Phase 13. Adding new code features in a documentation phase would
either be Phase 15 scope creep (introducing new risk right before the final deliverable) or
cosmetic changes dressed up as features. The honest deliverable is exactly what the workflow
specifies: consolidation, not extension.

---

## B1.1 — Conditional Edges (`apps/api`)

### Decision: Structured `{ left, op, right }` condition, not an expression string

**Why:** an expression string (`"accuracy > 0.9 && !dryRun"`) means shipping an
evaluator: a parser, an AST, and `eval`-adjacent execution over user input on
the control plane. A fixed `{ left, op, right }` triple with an 8-value `op`
enum covers every branch case this project needs, renders as three inputs in
the B1.2 UI, and has zero injection surface. `left` is resolved with the
existing Phase-7 `walkAndResolve`, so `{{ nodes.eval.output.accuracy }}` works
exactly as it does in node config.

**Trade-off:** no compound conditions (`A && B`) on a single edge. Model those
as two edges in series, or a small router node. Acceptable.

### Decision: Join semantics — "any active parent"

A child with multiple incoming edges runs if **at least one** edge was active
(unconditional, or its condition passed). It is `SKIPPED` only when **every**
incoming edge was inactive.

**Why not "all parents":** the common shape is an if/else that re-joins — 
`A→B (if x)`, `A→C (if !x)`, `B→D`, `C→D`. With "all parents", D would need both
B and C, but exactly one of them is always skipped, so D could never run.
"Any active parent" makes the diamond work: whichever branch ran feeds D.

**Implementation:** a Redis set `run:{runId}:activeParents:{childKey}` holds the
parent keys whose edge in was active. `markParentActive` is called **before**
`decrementInDegree`, so when the decrement that zeroes a child's in-degree
lands, the set already reflects every parent that finished. The in-degree hash
still decrements for **every** parent regardless of the edge's activity — a
skipped branch can never leave a downstream node stuck at in-degree > 0. A
child that reaches in-degree 0 with an empty `activeParents` set is `SKIPPED`,
and that skip recurses through the same propagation with `parentActive = false`.

### Decision: an unresolvable condition fails the run, loudly

If `left` references an output that isn't ready (`UnresolvedTemplateError`) or
`op` is applied to incompatible values (`ConditionTypeError`), the run is
aborted: every pending node → `SKIPPED`, run → `FAILED`, with the condition and
the reason in the event. Silently evaluating a broken condition to `false`
would make a skipped branch look like the user's routing choice rather than
their bug.

---

## B1.2 — Condition Builder in the Editor (`apps/web`)

### Decision: coerce the `right` input on serialise, not on every keystroke

The inspector's "right" field is a plain text `<input>`. It stores the raw
string in the graph store as you type and only converts to number / boolean /
array in `toGraph()` (via `coerceRightValue`). Coercing on each `onChange`
would mangle partial input — typing `0.` would collapse to `0`, `tru` is not
yet `true`. This mirrors how `sanitizeConfig` already defers numeric coercion
for node config fields, so the two code paths behave the same way.

### Decision: a blank `left` means "no condition", silently

`serializeCondition` returns `null` when `left` is empty after trim, so
`toGraph()` omits the `condition` entirely rather than sending
`{ left: "", ... }` to be rejected by the API (`left` is `.min(1)`).
`validateGraphForSave` still surfaces a *partially* filled condition (left set,
right blank or vice-versa) as a readable pre-flight error. The net effect: you
can click "Add condition", change your mind, clear the field, and save without
an error — the edge just goes back to unconditional.

### Decision: run-time edge colour is derived in the view, from node statuses

B1.2 shows a resolved edge as green (taken) or grey (skipped) during a run.
Rather than add an edge-level event or store, `App.tsx` derives it in
`displayEdges` from `runSlice.nodeStatuses` that already stream in: target
`SKIPPED` → grey; source `SUCCEEDED` and target dispatched → green. The engine
never emits per-edge state, and it doesn't need to — the child's status already
encodes which branch won. Keeps the SSE contract unchanged.

### Decision: node config panel and edge inspector are mutually exclusive

`selectNode` and `selectEdge` each clear the other's selection in the store, and
`ConfigPanel` renders `<EdgeInspector />` in place of the node form. One
inspector panel, one selected thing — no stacked panels, no ambiguity about
what "Delete" or "Save Changes" acts on.

---

## B2 — Scheduled & Webhook-Triggered Runs (`apps/api`, `packages/queue`)

### Decision: BullMQ Job Schedulers, not a `setInterval` loop

Each enabled `Schedule` row has a matching BullMQ Job Scheduler on the
`scheduler` queue, keyed by the schedule id. BullMQ stores the cron state in
Redis, so it survives an API restart, and it produces exactly one delayed job
per tick even if several API replicas are connected — none of which a
hand-rolled `setInterval` in one process gets right (lost on restart,
duplicated per replica, drifts). The API process runs a `Worker` on that queue
whose only job is a DB lookup + `startRun`. The DB row is the user-facing
mirror and bookkeeping (`lastRunId`, `nextFireAt`); the Job Scheduler is the
authority for *when*. `reconcileSchedules()` on boot re-asserts a Job Scheduler
for every enabled row, healing the one divergence that matters (Redis flushed,
Postgres intact).

### Decision: a schedule pins the workflow, not a version

The roadmap sketch had `workflowVersionId`. We pin `workflowId` and resolve the
latest version at fire time instead: "run this workflow every night" should
track your edits, which is how Airflow/Prefect schedules behave. The cost —
a bad save silently changes what the nightly run executes — is the same cost
you already accept for `POST /runs` from the editor, and version history plus
the run's pinned `workflowVersionId` make it auditable after the fact.

### Decision: idempotency key = planned fire time, derived without trusting BullMQ internals

`fireSchedule` builds `schedule:<id>:<plannedISO>`. The planned time comes from
`plannedFireMillis(jobId)`: BullMQ names scheduler jobs `<schedulerId>:<millis>`,
so the trailing number is the tick time — but if that can't be parsed (format
changed, sanity-bound blown) it falls back to the current minute boundary.
For the `* * * * *` case the planned times *are* minute boundaries, so the
fallback is exact; for a stalled-job re-delivery after an API crash the ~30s
lock window lands in the same minute the vast majority of the time. The unique
`Run.idempotencyKey` constraint plus `createRun`'s "return the existing run"
is the actual guarantee — this just derives a stable key for it.

### Decision: webhook idempotency key embeds `sha256(rawBody)`, prefixed by trigger id

The roadmap says `idempotencyKey = sha256(rawBody)`. We prefix it
(`webhook:<triggerId>:<hash>`) so two different triggers receiving the same
JSON body (`{}` is common) don't collide on the global-unique key. The
consequence — re-POSTing the exact same body is a no-op that returns the first
run — is the intended "reject replays for free" behaviour. A caller that wants
to fire twice with the same semantic payload adds a nonce field.

### Decision: raw body captured per-route, before `express.json`

The webhook verifies an HMAC over the exact request bytes, so it can't run
after `express.json` has parsed and discarded them. `app.post('/triggers/:token',
express.raw({ type: () => true }))` is registered before the global
`express.json`; `express.raw` calls `next()`, the request falls through to the
trigger router, and `express.json` skips it (body already read). Only that one
method+path is affected — `PATCH /triggers/:id` etc. still get normal JSON
parsing.

### Decision: an unknown token and a disabled trigger return the same 404

`handleWebhookService` throws `NotFoundError` for both. A distinct "disabled"
response would tell an attacker probing tokens which ones are real. Signature
failures are 401 (you found a real token but can't sign for it); everything
else about a token's existence is opaque.

---

## B3.1 — Run-Tree Schema & Read Paths (`packages/db`, `apps/api`)

### Decision: fan-out children are separate `Run` rows, not a new table

A `flow.map` element runs the same subgraph as any other run — it has NodeRuns,
events, a status, timing. Reusing `Run` (plus `parentRunId` / `fanOutIndex`)
means every existing read path, the SSE stream, the Gantt chart, retry, and
cancel already work on a child with zero changes. The alternative — a
`FanOutTask` table — would duplicate all of that. The cost is one nullable
self-FK and remembering that "a run" now sometimes means "a child run".

### Decision: `children` is a count summary on `GET /runs/:id`, computed per request

The run detail response carries `children: { total, succeeded, failed, ... }`
from a `groupBy`, not an array of child rows. A 1000-element fan-out must not
turn one run fetch into a 1000-row join. The array is a separate, paginated
endpoint (`GET /runs/:id/children`) that the B3.5 drill-in view calls on demand.
An ordinary run gets an all-zero summary, so the response shape only grows by
one key — no consumer breaks.

### Decision: children order by `fanOutIndex`, not completion time

`listChildRuns` sorts `[{ fanOutIndex: 'asc' }, { id: 'asc' }]`. The reduce step
(B3.3) needs the children's outputs in source-array order regardless of which
finished first, and the UI list is far more readable indexed 0..N than by a
jittery completion order. Cursor pagination is on `id` (unique), which is stable
under that sort.

---

## B3.2 — Dynamic Fan-Out: Spawn & Summary Join (`apps/api`, `packages/queue`)

### Decision: subgraph nodes live only in child runs; the parent run excludes them

`startRun` computes the union of every `flow.map` node's `subgraph` and drops
those keys from the parent run's NodeRuns *and* from its in-degree seeding
(edges touching a subgraph key are ignored). Otherwise a subgraph node would
sit `PENDING` in the parent forever and `allNodeRunsTerminal(parent)` could
never be true. The parent run therefore only tracks the "control" nodes
(the splitter, the `flow.map`, the downstream join); the per-element work
happens entirely in child runs.

**Authoring contract:** the parent graph is `… → map → downstream`. Subgraph
nodes are connected only among themselves and reference the map node's
per-element output as `{{ nodes.<mapKey>.output.item }}`. Wiring a subgraph node
into the parent's edge flow is unsupported (a follow-up can validate it at
version-creation time).

### Decision: the per-element input is a pre-SUCCEEDED seed NodeRun, not a new resolver feature

`createFanOutChildRun` seeds the child with a **SUCCEEDED** NodeRun for the
`flow.map` key whose `output` is `{ item, index, count }`. The existing Phase-7
context resolver then resolves `{{ nodes.<mapKey>.output.item }}` in the
subgraph's config with zero changes — the resolver already walks the run's own
NodeRun map. No `{{ fanout.* }}` special form, no schema column for the element.

### Decision: the executor reports only a count; the orchestrator re-resolves the array

`flow.map`'s executor returns `{ count }`, never the array. A 1000-element
array would blow the 64 KB `assertOutputSize` cap. `spawnFanOut` re-resolves
`overSource` itself via `resolveNodeInputs` — deterministic, because parent
outputs are immutable once `SUCCEEDED`.

### Decision: idempotency key `${parentRunId}:${mapKey}:${i}`; join claim in Redis

Spawn is replay-safe: `createFanOutChildRun` returns `{ created: false }` for an
existing key, so a crash mid-spawn that re-delivers the `flow.map` completion
can't double-create children. The **join** is the real race — N children
finishing at once all observe "no siblings left". `claimFanOutJoin` (`SADD`
returns 1 once) picks the single winner that decrements the downstream node's
in-degree. The count itself needs no lock: each child commits its terminal
status before it queries, so the *last* committer always sees zero and fires
the claim; the `SADD` only breaks ties among true simultaneous finishers.

### Decision: B3.2 joins on a summary even when children fail

A failed child still counts toward the join; the downstream node runs with
`map.output.fanOut = { childCount, succeeded, failed, cancelled }`. The
fail-fast policy ("one child fails → cancel siblings, fail the parent") is
B3.4, opt-in via a `failureThreshold`.

---

## B3.3 — Fan-Out Output Aggregation (`apps/api`, `apps/worker`)

### Decision: the join writes a results file; the map node's output only holds its path

At `joinFanOut`, when a `flow.reduce` node is downstream, the orchestrator
collects every child's sink output into one array (ordered by `fanOutIndex`)
and writes it to `${ARTIFACT_DIR}/${parentRunId}/${mapKey}/results.json`. The
`flow.map` node's own `output` gets only `{ resultsPath, resultsCount }` plus
the B3.2 `fanOut` summary — a couple hundred bytes regardless of child count.
100 children each returning 10 KB would be 1 MB; inline on `map.output` it would
blow `assertOutputSize`'s 64 KB cap. This is the same "large data travels by
reference" discipline every other node already follows — the API just happens
to be the writer here, and it already mounts the shared `artifact_data` volume.

### Decision: aggregate the subgraph *sink* outputs, ordered by fanOutIndex

`getFanOutChildOutputs` gathers each child's subgraph-leaf NodeRun output
(a node with no outgoing edge to another subgraph node). Single sink → that
output; multiple sinks → `{ [sinkKey]: output }`; child didn't succeed → `null`.
Order is `fanOutIndex`, never completion time, so `reduce` sees element `i`
where `flow.map` put source element `i`. The whole thing is two queries
(`run.findMany` + `nodeRun.findMany`), grouped in memory — no N+1.

### Decision: concat writes by reference too; sum/mean return a scalar inline

`concat` flattens the elements and writes the result to the reduce node's own
artifact dir, returning `{ mode, count, resultsPath }` — a concatenation can be
arbitrarily large, so it can't go inline either. `sum`/`mean` fold a numeric
`field` (dot-path, e.g. `score.accuracy`; omit if the elements are numbers) and
return `{ mode, field, value, count }`, which is always tiny. `custom` (a
user script) is deferred — the roadmap lists it but B3.3's "real aggregate"
bar is met by the built-in folds.

---

## B3.4 — Fan-Out Failure & Cancellation Cascade (`apps/api`)

### Decision: fail-fast by default, `failureThreshold` to opt into tolerance

`FlowMapConfig.failureThreshold` defaults to `0`: the first failed child run
cancels every still-running sibling and aborts the parent (skipping the
downstream reduce node). A pipeline where one shard's failure invalidates the
aggregate — the common case — should stop wasting compute immediately. Setting
`failureThreshold: N` flips to tolerate-partial: the join fires once every child
is terminal as long as `failed <= N`, and the downstream node runs on
`map.output.fanOut = { succeeded, failed, ... }` (the results file has `null`
for each failed child's slot).

### Decision: `abortRun` owns the child-run cancel; `spawnFanOut` sweeps the race

`abortRun` (called on threshold breach, and on an unevaluable condition)
`cancelChildRunsOf(runId)` before it skips pending nodes. But `spawnFanOut` runs
on a *different* async stack — a child created in the window between abort's
cancel query and spawn's next parent-status check would be left RUNNING. So
`spawnFanOut` also checks the parent status every iteration (`break` if not
RUNNING) and, after the loop, sweeps once more with `cancelChildRunsOf` if the
parent is no longer RUNNING. Belt and suspenders; no orphan child survives a
fail-fast.

### Decision: retry resets failed children in place, keyed by the same idem key

`retryFanOutChildren` finds a `flow.map`'s `FAILED`/`CANCELLED` children by
`idempotencyKey` prefix (`${parentRunId}:${mapKey}:`), resets each in place —
subgraph NodeRuns back to `PENDING` (`attempt++`), the pre-SUCCEEDED map seed
left alone, Redis `dispatched` set cleared (`clearDispatched`), in-degrees
re-seeded, roots re-dispatched — and releases the join claim
(`clearFanOutJoinClaim`) so the join re-fires when the retried children finish.
Reusing the child run (not deleting + recreating with a fresh key) keeps its
history and its `fanOutIndex`, and matches how `retryFailedNodesService` already
resets a FAILED node. Survivor children are never touched, so retry re-runs
*only* what failed.

### Decision: `data.source` reads resolved input for `csvPath` / `url`

`data.source` was reading `ctx.config` (raw), so a `{{ … }}` ref in `csvPath` /
`url` silently never resolved. It now prefers `ctx.input` (the control plane's
resolved copy), falling back to `ctx.config` — the same pattern `registry.deploy`
uses. Fixes a latent bug and is what lets a fan-out seed a per-child input path.

---

## B3.5 — Fan-Out in the UI (`apps/web`, `apps/api`)

### Decision: two run-level SSE events, not per-child node events

`RUN_SPAWNED` fires once (carrying `total`), `RUN_CHILD_COMPLETED` fires per
child terminal (carrying the running per-status tallies, not a delta). Both go
on the *parent* run's SSE channel — the editor already subscribes there. The
client just overwrites `fanOut[mapNodeKey]` with the latest tallies, so a
dropped or out-of-order event self-heals on the next one. Child runs keep their
own event streams; the UI doesn't subscribe to 100 of them.

### Decision: one node + a pill + a drawer, never N canvas nodes

The `flow.map` node renders a `done / total` progress pill and bar in place
(`CustomNode`), and selecting it opens `FanOutPanel` — a paginated child list
(`GET /runs/:id/children`, 50/page) where clicking a row loads that child's full
run and renders its existing `GanttChart`. This reuses the run-detail + Gantt
machinery already built for the parent; a child run is just a run.

### Decision: `abortRun` sweeps children twice (before and after the FAILED transition)

B3.4 put the child-run cancel before `abortRun`'s FAILED transition, which
reintroduced a flaky orphan under load (a concurrent `spawnFanOut` reads the
parent as still RUNNING and keeps creating children after the sweep). Moving the
transition first broke the *condition-error* abort path (B1.1) — its
skip-pending-nodes loop began racing a stale `getNodeRunMap`. Resolution: keep
B3.4's order (cancel → skip → transition) and add a **second**
`cancelChildRunsOf` after the transition. With `spawnFanOut` also checking the
parent status every iteration and once more after its loop, three sweeps cover
every interleaving and neither path regresses.

---

## B4 — Hard Cancellation (`apps/worker`, `packages/queue`)

### Decision: a Redis flag the worker polls, not a per-job kill signal

`cancelOneRun` sets `run:{runId}:cancelled` (24 h TTL). The worker checks it
once before starting an executor and every 5 s while one runs. There is no
targeted "kill job X" channel: the run id is the unit of cancellation, the flag
is one key, and a worker that picks up a stale job for an already-cancelled run
bails on the pre-check with no wasted work. BullMQ's own job removal still
handles anything still queued; the flag is only for the job a worker already
holds.

### Decision: abort → the timeout watchdog's process-group SIGKILL

`runPython` already kills the whole child process group on timeout
(`process.kill(-child.pid, 'SIGKILL')`) so orphan grandchildren don't linger.
Cancellation reuses that exact `killGroup()` — a `signal.addEventListener('abort',
…)` that clears the timer, kills the group, and rejects with
`PythonCancelledError`. One kill path, proven by the timeout case.

### Decision: a cancelled executor returns normally, not throws

If the worker rethrew on a cancel-induced executor error, BullMQ would mark the
job failed and **retry it** (attempts: 3) against an already-cancelled run.
Instead `processJob` catches, confirms it was a cancellation (signal aborted /
`PythonCancelledError` / flag set), transitions the NodeRun `RUNNING →
CANCELLED` (idempotent — `cancelOneRun`'s `updateMany` usually got there first),
emits `NODE_CANCELLED`, and returns `null`. The job completes cleanly; the
control plane's `onNodeSucceeded` no-ops because the NodeRun isn't `RUNNING`.

### Decision: 5 s poll, not the 15 s heartbeat

The roadmap suggested piggybacking the cancel check on `startHeartbeat`'s 15 s
tick, but only `torch.train` uses that heartbeat — `pandas.preprocess` and
`model.evaluate` also shell out to Python and need aborting. So the poll lives
in `processJob` (covers every executor) at 5 s, comfortably inside the "~15 s"
target with margin for the SIGKILL and the DB write.

---

## B5 — Make `retryPolicy` Real (`apps/api`, `apps/worker`)

### Decision: `cap` rides the payload; `attempts` + base delay ride the job opts

BullMQ's job options natively take `attempts` and `backoff.delay`, so those come
straight from `node.retryPolicy`. But a custom `backoffStrategy` function only
receives `(attemptsMade, type, err, job)` — and `job.opts.backoff` carries the
base `delay`, not an arbitrary ceiling. So `cap` is passed on `job.data`
(`JobPayload.retryCap`) and `exponentialJitter` reads both: base from
`job.opts.backoff.delay`, cap from `job.data.retryCap`.

### Decision: a retryable failure resets the NodeRun to QUEUED

This was a latent bug, not just missing config. `processJob` claims
`QUEUED → RUNNING` and never moves the row back on a throw. So BullMQ's second
attempt re-ran `processJob`, its `QUEUED → RUNNING` claim failed (the row was
still `RUNNING`), the handler `return null`ed, and BullMQ marked the job
**completed** — a transient failure became a phantom success with null output.
The fix: on a retryable throw with attempts remaining, transition
`RUNNING → QUEUED` (clearing `startedAt`) before rethrowing, so the next attempt
genuinely re-executes. `attempts: 5` on `fail.py` now runs 5 times.

### Decision: the worker stamps the taxonomy; `onNodeFailed` preserves it

The BullMQ `failed` event only carries `failedReason` (a string), so the
control plane can't classify the error. Instead the worker writes
`{ message, taxonomy, attempt, maxAttempts }` onto `NodeRun.error` in its catch
(via `tryTransitionNodeRun`'s `error` field on a retry, or `setNodeRunError` on
the terminal attempt). `onNodeFailed` then checks `nr.error.taxonomy` and keeps
that object rather than overwriting with `{ message: failedReason }`. The UI
reads `taxonomy` off the `NODE_FAILED` payload to say *"failed permanently"* vs
*"failed after N attempts."*

### Decision: `retryPolicy` is a first-class NodeDef field in the web store, not a config key

The per-type config schemas are strict (`z.object` strips unknowns), so a
`_retryAttempts` key stuffed into `config` would be dropped at
`POST /workflows`. `retryPolicy` lives on `NodeData.retryPolicy` in the Zustand
store, has its own `updateNodeRetryPolicy` action, and is spread onto the
serialised `NodeDef` by `toGraph()` / restored by `graphToFlow()` — the same
pattern edge `condition` uses (B1.2). A blank field is dropped so the engine
default applies.

---

## C1.1 — Extract the Artifact-Store Interface (`apps/worker`)

### Decision: one narrow interface (`put`/`get`/`exists`/`localPath`), not a full filesystem shim

The temptation with an abstraction like this is to make it look like `fs` —
`readdir`, `stat`, `mkdir`, arbitrary paths. That would leak the *filesystem's*
shape into the interface, which defeats the point: an S3 bucket doesn't have
directories, `stat`, or rename semantics. Every real call site only ever did
one of four things to an artifact: write it, read it, check whether it
exists, or get a real local path for a Python script to read/write through.
So the interface is exactly those four operations, keyed by a `/`-joined
string relative to the store's root — small enough that `FsArtifactStore` and
a future `S3ArtifactStore` (C1.2) can both implement it completely, with
nothing left over that only one of them can do.

### Decision: `localPath()` does not create anything on disk

An earlier draft had `FsArtifactStore.localPath(key)` eagerly `mkdir -p` its
resolved path, on the theory that "give me a local path" implies "make sure
it's usable." That broke `flow.reduce`: it writes `reduced.json` via
`store.put()`, then calls `store.localPath()` on that same key just to report
the path in its output — and `mkdir` on a path that already exists as a *file*
throws `EEXIST`. The fix is that `localPath()` promises nothing about what
exists at that path; it's a pure resolver (for `fs`) or a download-to-temp-dir
step (for `s3`, in C1.2). Callers that need a *directory* to exist rely on
what already made it true before this refactor — Python's own
`os.makedirs(outputDir, exist_ok=True)` — and callers writing a single known
file go through `put()`, which creates its own parent directory. No call site
needed `localPath()` to have side effects; the bug was inventing a contract
nothing actually required.

### Decision: `data.source`'s *local/bundled* CSV lookup stays on `fs`, on purpose

The "Done when" checkbox says no executor calls `fs` directly — but
`resolveLocalCsv`/`BUNDLED_CSV` aren't reading a *stored artifact*, they're
locating an external input that lives on the worker's own disk (an
operator-configured path, or the dataset baked into the image). That file
gets read into a `Buffer` and `store.put()`'d immediately — one line
later it's a completely normal store-managed artifact like the URL-fetch
branch. Routing the *lookup* itself through the store would mean inventing a
second, parallel "external source" concept inside `ArtifactStore` for a case
that will look identical under `S3ArtifactStore` (the worker's own disk is
still local disk, regardless of where finished artifacts live) — not a
meaningful step toward C1.2.

---

## C1.2 — S3/MinIO Artifact Backend (`apps/worker`, `apps/api`)

### Decision: executor outputs hold store KEYS, not resolved paths — under both backends

This is the one C1.1 assumption C1.2 had to overturn. Under `fs`, an
executor's path-shaped output (`csvPath`, `weightsPath`, ...) was a resolved
absolute path — safe, because the shared volume made that path valid on
*any* worker. Under `s3` that assumption is false by construction: the node
consuming that output might dispatch to a different worker, possibly a
different machine, and a local temp path from one worker's `withOutputDir`
call means nothing to another. The fix generalizes past S3, though — a key
(`{runId}/{nodeKey}/file`) is a stable, backend-independent name for "this
artifact," and resolving it to something a Python script can actually open
happens exactly once, immediately before that script runs
(`resolveIfStored()`), on whichever worker needs it. `NodeRun.output` (and
therefore the UI, and the download route) now sees the same shape regardless
of `ARTIFACT_BACKEND` — one less thing that's allowed to differ between the
two.

**Consequence:** `sha256OfPath`/`pathExists` from C1.1 (added specifically
because `registry.deploy`'s `weightsPath` was "an arbitrary upstream absolute
path, not a key this store allocated") are gone. Under the new scheme
`weightsPath` **is** a key like everything else, so `registry.deploy` uses
plain `store.exists`/`sha256`. C1.1's special-casing wasn't wrong — it was
correct for what was true *at the time*; C1.2 changed the premise.

### Decision: `resolveIfStored()` tries the store first, falls through on a miss — no per-field special-casing

Every "template ref" field (`torch.train`'s `trainPath`, `model.evaluate`'s
`weightsPath`/`testPath`, `registry.deploy`'s `weightsPath`) is documented in
`packages/contracts/src/node-types.ts` as coming *only* from an upstream
node's output — always a key once resolved. But `pandas.preprocess`'s own
`csvPath` is dual-purpose: it can equally be a literal path the script
resolves itself (relative to its own `python/` directory, or the bundled
default), unrelated to any upstream `data.source`. Hard-coding "treat this
field as a key" per node type would need to know which of the two a given
config actually is. Instead, `resolveIfStored(store, value)` just tries
`store.exists(value)` — if the store recognizes it as a key, resolve it;
otherwise return `value` untouched and let Python's own resolution logic
(which already handled literal/relative/bundled paths before any of this
existed) take it from there. One function, no per-field knowledge, correct
for both cases.

### Decision: `withOutputDir()` as a new interface method, not implied by `localPath()`

The roadmap's sketch interface only listed `put`/`get`/`exists`/`localPath`/
`presignedUrl`. In practice, `pandas.preprocess` and `torch.train` don't need
"the local path of one key" — Python writes *several* files into a directory
it's handed (`train.parquet` + `test.parquet`; `model.pt`), and only after it
returns does anyone know which files exist or what to call them. `localPath()`
resolves one key; it can't also mean "give me a scratch directory and, once
I'm done, turn whatever ended up in it into properly-keyed artifacts." Those
are two different contracts, so they're two different methods.
`FsArtifactStore.withOutputDir` hands back the real persistent directory
(nothing to upload — but see the bug below, it still has to rewrite Python's
return value); `S3ArtifactStore.withOutputDir` hands back a temp directory,
uploads everything written into it once the callback resolves, and deletes
the temp directory unconditionally (`finally`), so a thrown error from Python
doesn't leak scratch directories on disk.

### Bug: presigned URLs signed with the wrong endpoint

The API's S3 client is configured with `ARTIFACT_S3_ENDPOINT=http://minio:9000`
— correct for the API and worker CONTAINERS talking to MinIO over the Docker
network, wrong for a presigned URL, because the host embedded in a presigned
URL's signature comes from whatever endpoint signed it, and a browser on the
host machine cannot resolve the hostname `minio`. Real AWS S3 never has this
split (one public DNS name, reachable identically from everywhere), so this
is purely a local-MinIO artifact. Fixed with a second S3 client, used only
for `getSignedUrl()`, pointed at a separate `ARTIFACT_S3_PUBLIC_ENDPOINT`
(`http://localhost:9000` in the compose overlay) — the internal client (used
for the actual `put`/`get`/`exists` calls) keeps using the internal endpoint.

### Bug: `registry.deploy`'s checksum silently `null` under `fs`, caught only by live testing

`FsArtifactStore.withOutputDir`'s first implementation didn't rewrite
anything — it just handed Python the real directory and returned whatever
Python returned. Under `fs` that meant `weightsPath` stayed an *absolute*
path. `registry.deploy` then called `store.exists(weightsPath)`, and
`FsArtifactStore.exists` unconditionally `path.join(root, key)`s — joining an
already-absolute path onto the root produces a nonsense double-prefixed path
(`/data/artifacts/data/artifacts/...`) that obviously doesn't exist. The
result wasn't a crash: `registry.deploy` is written to tolerate a missing
checksum (a missing checksum is deliberately not a reason to fail an
otherwise-successful deploy), so the pipeline completed normally with
`checksum: null` and no error anywhere. The existing
`full-pipeline.integration.test.ts` didn't catch it because it only asserts
`weightsPath` is literally equal between `train` and `deploy`'s output, never
that the checksum is non-null. It surfaced only when a live curl run against
the actual running stack was inspected by hand. **Fix:** give
`FsArtifactStore.withOutputDir` the same absolute-path→key rewrite
`S3ArtifactStore.withOutputDir` already had. **Lesson reinforced:** a green
integration suite proves the *paths already covered* still work; a live
smoke run against the real stack is what catches the assumption nobody wrote
a test for. This is the second time this exact pattern has caught a real bug
in this project (the first was B5's phantom-success retry bug) — worth
treating as a standing practice, not a one-off.

### Note: fan-out (`flow.map`/`flow.reduce`) is not part of the S3 migration

The fan-out join (`orchestrator.service.ts`'s `joinFanOut`) writes
`results.json` straight to `ARTIFACT_DIR` on local disk — it predates the
`ArtifactStore` abstraction and lives in `apps/api`, not `apps/worker`, out
of C1's stated scope (`apps/worker/src/artifact-store.ts`). Under
`ARTIFACT_BACKEND=s3`, `flow.reduce`'s `ctx.store.exists(resultsKey)` check
will correctly report "not found" (the orchestrator never uploaded it) and
fail the run with a clear `UnrecoverableError` — a loud, honest failure, not
silent data loss. Extending fan-out's join to go through `ArtifactStore` is
a real follow-up, not done here.

### Note: no artifact lifecycle/TTL policy

Neither backend expires anything. On the shared volume this is cheap
(disk is disk); on S3 it is not (storage cost accrues per byte, forever,
across every run this system has ever executed). Roadmap C1.2 flagged this
as a documentation-only follow-up rather than a build item for this phase —
the two real options are an S3 bucket lifecycle rule (expire under a given
prefix pattern after N days) or a periodic sweep keyed off `Run.finishedAt`
that calls `store` deletes directly; the former is simpler and doesn't need
this codebase to run anything on a schedule, so it's the more likely answer
when this is actually built.
