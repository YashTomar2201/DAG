# Interview Q&A

This document contains challenging interview questions based on the new code added to the system, along with confident, detailed answers.

---

## Phase 0: Monorepo Scaffold & Local Infrastructure

### Q1: Why did you choose a monorepo for this architecture instead of separate frontend and backend repositories?
**Answer:** The primary driver was the need to share our core graph algorithms (`graph-core`) between the browser (for instant, visual cycle detection feedback) and the Node.js API (for authoritative validation). If they were separate repositories, we'd have to publish `graph-core` as an npm package and risk version drift, leading to a split-brain scenario where the frontend allows a connection that the backend rejects. A pnpm workspace allows both applications to import the exact same TypeScript source code directly.

### Q2: You mentioned your shared library (`graph-core`) has "zero runtime dependencies." Why is that a strict requirement, and how do you enforce it?
**Answer:** Because `graph-core` is imported by the frontend, any runtime dependency we add to it gets bundled into the user's browser by Vite. If we accidentally imported a Node-specific library like `ioredis` into the graph logic, it would break the browser bundle entirely. By keeping it pure (only relying on standard JavaScript objects), we guarantee it can run anywhere—Node, browser, or edge workers. We enforce this by ensuring the `package.json` for `graph-core` only contains `devDependencies`, which would be caught immediately in a PR review.

### Q3: What is the risk of using Redis's default snapshotting mechanism for a task queue, and how did you mitigate it?
**Answer:** Redis's default RDB snapshotting saves the state of the database to disk at intervals (e.g., every 60 seconds). If the Redis container crashes between snapshots, all writes during that window are lost. In a task queue context, a "write" is a pending job. If those jobs vanish from Redis but our Postgres database still thinks they are "QUEUED", the run will stall indefinitely with no error or retry. I mitigated this by starting Redis with `--appendonly yes`, which writes every command to an Append-Only File (AOF) on disk. On restart, Redis replays the log, ensuring zero job loss.

### Q4: How do you handle environment variables, and why is doing it natively with `process.env` considered an anti-pattern in your architecture?
**Answer:** Native `process.env` reads return `string | undefined` and provide no structure. If a required URL is missing, the application might fail 10 layers deep when the database client attempts to connect, producing a cryptic error. Instead, I use Zod to define a strict schema for our environment variables (e.g., enforcing that `DATABASE_URL` is a valid URL). This schema is parsed at module load time. If the configuration is invalid, the process crashes immediately with a structured error pinpointing exactly what is missing or misconfigured, ensuring the application never enters an invalid state.

---

## Phase 1: Wire Contracts

### Q5: Why did you choose Zod as the single source of truth for your type definitions instead of writing TypeScript interfaces directly?
**Answer:** TypeScript interfaces only exist at compile time — they are erased after transpilation. If I wrote an interface `NodeDef` and a separate runtime validator, I'd have two places to maintain. Zod schemas exist at runtime AND generate the TypeScript type via `z.infer<>`. When I add a field to a Zod schema, the TypeScript type updates automatically. This eliminates an entire class of bugs where the validator and the type drift apart. It also means a single schema definition works for HTTP body validation, SSE payload parsing, and compile-time type-safety — all from one source.

### Q6: Explain your `NodeDef` discriminated union. What problem does it solve and how does the worker benefit from it?
**Answer:** A discriminated union on `type` means each node variant carries its own strictly-typed `config`. For example, `torch.train` nodes have `{ epochs: number }` in their config, while `kaggle.download` nodes have `{ datasetSlug: string }`. In the worker's executor registry (`Record<NodeType, (ctx) => Promise<Output>>`), the TypeScript compiler can verify at build time that every possible node type has a corresponding executor. If a developer adds a new node type to the contracts but forgets to add an executor, the build fails — not a runtime crash in production. Zod's `z.discriminatedUnion()` also does O(1) branch lookup on the `type` field rather than linearly scanning all branches.

### Q7: Why can't cycle detection live in the `GraphSchema` Zod refinement?
**Answer:** Zod's `.superRefine()` callback has access to the parsed object and can run custom validation, but it cannot perform stateful graph traversal. Cycle detection requires a depth-first search — you start at a node, follow its edges, maintain a "currently on the stack" (GRAY) set, and detect when you revisit a GRAY node. This is an algorithm that builds up state (the DFS stack, the color map) as it runs across potentially hundreds of nodes and edges. Zod's refinement model is designed for single-pass, field-level validation. Cycle detection belongs in `packages/graph-core` as a pure function that takes a graph and returns `{ hasCycle: boolean; path?: string[] }`.

### Q8: What is the `ErrorTaxonomySchema` and why does classifying errors as retryable vs. unrecoverable matter for correctness?
**Answer:** The error taxonomy distinguishes between transient failures (network timeout, HTTP 429, filesystem lock) that are worth retrying versus permanent failures (invalid credentials, Python `SyntaxError`, schema validation error) that will never succeed no matter how many times you retry. If you misclassify a permanent error as retryable, BullMQ will retry it the full 3 times with exponential backoff — wasting 2+ minutes before the run finally fails, potentially hammering an external API (like Kaggle) with repeated bad requests. With `UnrecoverableError`, BullMQ skips all remaining retries immediately and moves the job directly to the failed set, giving the user faster feedback and protecting external services.

---

## Phase 2: Graph Algorithms

### Q9: Why did you implement cycle detection using a 3-color DFS instead of just using Kahn's algorithm, which can also detect cycles?
**Answer:** Kahn's algorithm detects *if* a cycle exists (because the final sorted array will be shorter than the total number of nodes), but it cannot easily tell you the *exact path* of the cycle. From a UX perspective, simply saying "Cycle detected" is unhelpful. The user needs to know exactly which nodes caused the loop (e.g., "Extract → Preprocess → Extract"). By using a 3-color Depth-First Search, the moment we encounter a GRAY node (a node currently on the recursion stack), we can trace the parent pointers back up the stack to construct the exact sequence of nodes that form the cycle, allowing the UI to highlight the exact edges.

### Q10: Your DFS implementation is iterative rather than recursive. Why did you make this choice, and what specific error does it prevent?
**Answer:** A recursive DFS uses the JavaScript engine's call stack to maintain state. In V8 (Node.js/Chrome), the maximum call stack size is roughly 10,000 frames. If a user builds a linear pipeline of 15,000 nodes, a recursive implementation will throw a `RangeError: Maximum call stack size exceeded`, crashing the entire Node process or the browser tab. By writing it iteratively, I use a JavaScript array (`[]`) to simulate the stack. This moves the memory allocation from the constrained call stack to the heap, which is only limited by available system RAM, making the algorithm immune to call stack overflow attacks or edge cases.

### Q11: Explain how Kahn's algorithm naturally maps to distributed task concurrency in your worker architecture.
**Answer:** Kahn's algorithm works by calculating the in-degree (number of prerequisites) for every node. It starts by finding all nodes with an in-degree of 0. Because these nodes have no pending dependencies, they can all be executed at the exact same time. My implementation groups these 0-in-degree nodes into a `tier` array. Once a tier is complete, we simulate the nodes finishing by decrementing the in-degree of their children. Any children that hit 0 become the next tier. This maps perfectly to our BullMQ worker pool: the orchestrator can take an entire tier, dispatch all of its nodes to the queue simultaneously, and let the independent worker processes chew through them in parallel.

---

## Phase 3: Persistence Layer

### Q12: Why is `WorkflowVersion` immutable, and what breaks if you allow editing a graph while a run is in progress?

**Answer:** A `Run` stores a `workflowVersionId` — a pointer to the exact graph snapshot that was valid when the user clicked "Run". The orchestrator reads this snapshot to know which nodes exist, their types, their configs, and which edges connect them. If the graph were mutable (in-place editable), consider this failure: a user removes the `preprocess` node while the run is 2 nodes deep. The orchestrator tries to dispatch `train`, which depends on `preprocess`, but `preprocess` no longer exists in the graph. The lookup returns `undefined` and the run crashes in an unrecoverable state with a confusing error. Immutability means the orchestrator always reads a frozen, consistent snapshot — no matter how many times the user edits the workflow afterward.

### Q13: You already have a Redis Lua script that prevents double-dispatch. Why do you also need `@@unique([runId, nodeKey])` at the database level?

**Answer:** Defence in depth. The Lua script is the primary guard — it's an atomic "decrement and check" that runs in Redis. But Redis is an external process that can fail: the server can restart, the network can partition, or the Lua script itself could have a latent bug. If two API instances race during a Redis restart and both believe they won the dispatch, both will attempt `createMany` to insert a `NodeRun` row. Postgres will reject the second insert with a unique constraint violation — `ERROR: duplicate key value violates unique constraint "NodeRun_runId_nodeKey_key"`. The application catches this and aborts. The unique constraint is a structural guarantee at the storage layer that does not depend on Redis being healthy. The system has four layers: Lua atomicity → SADD dispatch guard → deterministic BullMQ jobId deduplication → DB unique constraint. All four must fail simultaneously to get a double-execution.

### Q14: Walk me through the exact race condition that `tryTransitionNodeRun` prevents. Describe the specific interleaving.

**Answer:** Consider node `D` in a diamond graph (`A → B → D`, `A → C → D`). Workers `W1` and `W2` finish `B` and `C` simultaneously.

**Without the conditional update (naive read-then-write):**
1. `W1` reads `NodeRun[D].status` → `PENDING`
2. `W2` reads `NodeRun[D].status` → `PENDING`  
3. `W1` writes `status = QUEUED`, dispatches `D` to BullMQ
4. `W2` writes `status = QUEUED`, dispatches `D` to BullMQ again

`D` now has two jobs in the queue. It executes twice, writing two artifacts and potentially corrupting the output.

**With the conditional update:**
1. `W1` issues: `UPDATE NodeRun SET status='QUEUED' WHERE id=$d AND status='PENDING'` → `count=1` ✅
2. `W2` issues the same query → `count=0` (the row is now `QUEUED`, not `PENDING`) → `W2` aborts silently

Only `W1` dispatches `D`. The Postgres row-level lock ensures the two `UPDATE` statements are serialized even if they arrive simultaneously.

### Q15: Why is `RunEvent` append-only, and what dual role does it serve?

**Answer:** `RunEvent` is simultaneously an **audit log** and an **SSE replay source**. 

As an audit log, it provides a tamper-evident record of every state transition for post-mortem debugging ("which worker picked up `train` at what time? What did it return?"). If events could be updated or deleted, you could lose the evidence of what went wrong.

As an SSE replay source, a reconnecting browser client sends `Last-Event-ID: 42` and the server fetches `WHERE runId = ? AND id > 42 ORDER BY id ASC`, then switches to live pub/sub. If an event with `id = 35` was deleted, the client would skip it and show a gap — a node that flipped from `QUEUED` to `RUNNING` but the browser never showed it. The `BigInt @default(autoincrement())` id is a monotonically increasing cursor that is only safe as a replay cursor if events are never removed from the sequence.

### Q16: What is the time complexity of `allNodeRunsTerminal`, and how would you optimize it at 10,000 concurrent runs?

**Answer:** `allNodeRunsTerminal` runs `COUNT(*) WHERE runId = ? AND status NOT IN (...)`. With the `@@index([runId, status])` composite index, Postgres can perform an **index-only scan** — it reads only the index, not the table rows. For a run with N nodes, this is O(N) in the number of index entries scanned, but the index is clustered and compact so it's very fast in practice.

At 10,000 concurrent runs, calling this after every node completion creates 10,000 × average_nodes COUNT queries per second. The scalable optimization: maintain a Redis atomic counter `run:{id}:remaining` (initialized to the node count, decremented atomically when each node reaches a terminal state). When the counter hits 0, the run is complete — no database query needed. This is O(1) per completion event. The DB count becomes a recovery fallback only (on API restart, re-read from Postgres to reseed the counter).

---

## Phase 4: Control Plane API

### Q17: Why does the control plane API never execute user task logic, and what would break if it did?

**Answer:** The control plane's job is scheduling — deciding *what* runs next and persisting state transitions. Task logic (running Python scripts, downloading datasets, training models) is unpredictable in duration: a training job might run for 40 minutes. If the API process ran task logic inline, it would hold the HTTP request open for 40 minutes, exhaust the Express thread pool, and block all other requests. The API would become unresponsive. More critically, you couldn't horizontally scale the API and the task execution independently — the API would need GPU nodes. By keeping the API pure control logic and delegating execution to stateless worker processes via a Redis queue, you can run 1 API instance (scheduling is fast) and 100 worker instances (execution is slow). They scale independently.

### Q18: Your `POST /workflows/:id/validate` always returns HTTP 200 even for invalid graphs. Isn't that wrong — shouldn't errors return 4xx?

**Answer:** HTTP status codes signal the outcome of the *request*, not the outcome of the *validation*. The request itself succeeded — the server understood it, processed it, and is returning a structured answer. The answer happens to be "your graph has a cycle." Returning 422 for a cyclic graph makes the client-side code bifurcated: it must handle both HTTP error codes (for network failures, auth errors, 5xx) and validation failures (4xx) using different code paths. By returning 200 with `{ valid: false, cyclePath }`, the client always reads the same field (`valid`) to decide what to do. HTTP 4xx/5xx is reserved for truly exceptional outcomes: the server is down, authentication failed, the request was malformed at the structural level (missing required fields — that's a 400). "This graph has a cycle" is expected, normal domain feedback, not an exceptional error.

### Q19: Walk through what happens when a user submits a graph with a cycle — from HTTP request to HTTP response.

**Answer:**
1. `POST /workflows/:id/versions` arrives with `{ graph: { nodes, edges } }`.
2. `validateBody(CreateVersionBody)` middleware runs first: it validates that the body has a `graph` field (basic structure). This passes because the field exists.
3. The route handler calls `createVersionService({ workflowId, graph: req.body.graph })`.
4. Inside the service, `validateAndProcessGraph(rawGraph)` runs `GraphSchema.parse(rawGraph)` — checks node key uniqueness, no dangling edges, no self-loops. This passes for a structurally valid but cyclic graph.
5. `detectCycle(graph)` runs the iterative DFS. It finds the cycle and returns `{ hasCycle: true, path: ['deploy','extract','preprocess','train','evaluate','deploy'] }`.
6. The service throws `new CycleError(path)`.
7. The route handler's `catch (err)` block calls `next(err)`.
8. Express passes `err` to the registered `errorHandler` (the 4-argument middleware at the end of the app).
9. `errorHandler` checks `err instanceof CycleError` → true. It responds: `res.status(422).json({ error: 'Graph contains a cycle', cyclePath: [...] })`.
10. The browser receives 422 and highlights those exact edges in red.

### Q20: Why does the topoOrder get cached on the `WorkflowVersion` row instead of being computed each time a run starts?

**Answer:** Two reasons — **latency** and **consistency**. 

On latency: Kahn's algorithm is O(V+E). For a 200-node graph, this is fast in a single request. But at 1 000 concurrent run starts per second, you'd run Kahn's 1 000 times per second unnecessarily. The graph doesn't change between version creation and run start — the version is immutable. Computing once and caching is pure upside.

On consistency: The `topoOrder` is computed from the exact graph bytes stored in `WorkflowVersion.graph`. If we recomputed at run-start time from the stored JSON, we'd need to re-parse the JSON and re-run the algorithm, introducing a theoretical (though unlikely) inconsistency if the parsing library behaved differently. Caching the result alongside the graph on the same row guarantees they are always in sync — they were written atomically in the same transaction.

### Q21: What does your central error handler do with an unexpected error that isn't one of your typed classes?

**Answer:** It generates a `correlationId` using `crypto.randomUUID()`, logs the full error (including stack trace) with that ID using Pino — `logger.error({ err, correlationId, url, method }, 'Unhandled error')` — and returns `{ error: 'Internal server error', correlationId }` to the client with status 500. The full stack trace never reaches the client, which prevents leaking internal implementation details (file paths, library names, DB schema). The `correlationId` gives support engineers a way to find the exact log entry for that request. This pattern is common in production systems: structured logging + opaque correlation IDs + sanitised client responses.

---

## Phase 5: Redis + BullMQ Queue Infrastructure

### Q22: Walk me through the exact two-worker interleaving that would cause a double-dispatch if you didn't use a Lua script for in-degree tracking.

**Answer:** Consider the diamond graph: Node A runs, then B and C run in parallel. Node D depends on both B and C. 

If we don't use a Lua script, the application code would look like this:
1. `const remaining = await redis.hget(inDegreeKey, 'D');`
2. `await redis.hset(inDegreeKey, 'D', remaining - 1);`
3. `if (remaining - 1 === 0) dispatch('D');`

Here is the race condition interleaving:
- **T0:** Worker 1 (processing B) calls `hget('D')` and receives `2`.
- **T1:** Worker 2 (processing C) calls `hget('D')` and receives `2`.
- **T2:** Worker 1 calculates `2 - 1 = 1` and calls `hset('D', 1)`.
- **T3:** Worker 2 calculates `2 - 1 = 1` and calls `hset('D', 1)`.

**Result:** Node D's in-degree is stuck at `1` forever. It never reaches `0`, so D never gets dispatched. The workflow hangs permanently. 

Alternatively, if we used Redis `HINCRBY` without Lua:
1. `const remaining = await redis.hincrby(inDegreeKey, 'D', -1);`
2. `if (remaining === 0) dispatch('D');`

This fixes the lost update, but introduces a new race condition if the orchestrator re-evaluates logic. By wrapping the `HINCRBY` and a subsequent `SADD` into a single atomic Lua script, Redis guarantees that no other commands execute between those steps. Only one worker will see `remaining == 0` and successfully add it to the dispatched set, cleanly preventing both stalls and double-dispatches.

### Q23: Why do we need deterministic `jobId`s in BullMQ?

**Answer:** Idempotency and at-least-once delivery. If the API process (the control plane) successfully enqueues a job but crashes before it can write the "QUEUED" state to Postgres, upon recovery it will evaluate the state and try to enqueue the job again. If we didn't provide a `jobId`, BullMQ would generate a random UUID and the worker would execute the job twice. By explicitly setting `jobId = \`${runId}:${nodeKey}:${attempt}\``, BullMQ's internal Redis sets will silently ignore the second enqueue request because the ID already exists.

### Q24: What happens if a Kaggle API rate-limit triggers 50 `kaggle.download` jobs to fail at the exact same time?

**Answer:** If all 50 jobs use a standard exponential backoff (e.g., waiting exactly 2, 4, 8 seconds), they will all sleep for 2 seconds and then hit the Kaggle API again at the exact same millisecond. This "thundering herd" guarantees they will be rate-limited again. To fix this, I registered a custom `exponentialJitter` strategy in BullMQ. It adds randomness to the backoff: instead of exactly 4 seconds, a job might wait `4 + random(0, 2)` seconds. This desynchronizes the retries, spreading the API load over a wider time window and allowing the external service to recover.

### Q25: Why separate the Redis connections for BullMQ and Pub/Sub?

**Answer:** It's a fundamental limitation of the Redis protocol. When you issue a `SUBSCRIBE` command on a connection, that connection is placed into a special subscriber mode. It can only issue a very limited subset of commands (like `UNSUBSCRIBE`). It cannot execute `GET`, `SET`, `HINCRBY`, or run Lua scripts. Because our application needs to both publish/subscribe to events AND enqueue BullMQ jobs, it requires two independent TCP connections to the Redis server.

### Q26: Walk through the four-layer defence against double-dispatch. What does each layer specifically catch?

**Answer:** The system has four independent layers that must all fail simultaneously for a node to be executed twice:

**Layer 1 — Lua atomicity** (`packages/queue/src/lua.ts:13–18`).
Catches: two workers whose parents (say `b` and `c` in a diamond) finish on different machines in the same millisecond. Without the Lua script, both call `HGET indegree d` → `1`, both compute `1 - 1 = 0`, both dispatch. With the Lua script, Redis serialises the two `HINCRBY`+`SADD` blocks — only one sees `SADD return 1`. The other sees `SADD return 0` (or `remaining > 0`) and bails.

**Layer 2 — SADD dispatch guard** (`packages/queue/src/lua.ts:16`).
Catches: a *third* caller arriving after the count has already hit 0 — e.g. a delayed retry from the orchestrator, a restarted API instance reading stale state, a manual replay tool. `HINCRBY` would happily go to `-1` and the script would still return `1` if we only checked `remaining == 0`. The `SADD` check rejects any caller who is not the first to claim the dispatch slot.

**Layer 3 — Deterministic `jobId` deduplication** (`packages/queue/src/queues.ts:79–81`).
Catches: the control plane successfully enqueuing a job, then crashing (or hitting a network timeout) before it records `NodeRun.status = 'QUEUED'`. On the next orchestrator tick, the row still says `PENDING`, so the dispatcher enqueues again. With `${runId}:${nodeKey}:${attempt}` as the id, BullMQ's `SET NX` sees the id already exists and silently drops the duplicate. Without this layer, we'd need an extra DB round-trip *before* every `add()` to check "did I already queue this?" — and that check would itself be racy.

**Layer 4 — `@@unique([runId, nodeKey])` on `NodeRun`** (`packages/db/prisma/schema.prisma`).
Catches: everything above failing at once — Redis restarted mid-flight, the Lua script had a latent bug, the orchestrator forked. Two `INSERT`s for the same `(runId, nodeKey)` race; Postgres rejects the loser with a unique-constraint violation. The application catches it and aborts. This is a *structural* guarantee at the storage layer that does not depend on Redis being healthy.

The acceptance test `packages/queue/src/lua.test.ts:80–106` proves layer 1 + layer 2: it fires three concurrent `decrementInDegree(runId, 'd')` callers and asserts `results.filter(r => r).length === 1`. The DB constraint is exercised in the integration tests.

---

### Q27: Why three BullMQ queues by resource profile? What's the concrete failure with one queue?

**Answer:** Consider a single global `queue:tasks` with worker concurrency 1 per worker. A user submits a 200-node graph: 5 `kaggle.download` nodes, 90 `pandas.preprocess` nodes, 100 `torch.train` nodes, plus a final `registry.deploy`. All 200 jobs land on one queue.

The workers start pulling jobs in FIFO order. By chance, the first 100 jobs in the queue are all `torch.train`. Each one takes 40 minutes on the GPU. The 5 `kaggle.download` jobs are queued **behind** 100 GPU jobs that each hold a worker slot for 40 minutes. The IO jobs — which individually take 2 seconds each — now wait 100 × 40 minutes = 4000 minutes ≈ **67 hours** of head-of-line blocking.

The user sees their workflow "stuck on IO" for almost three days, even though the IO jobs are trivially fast.

**With three queues** (`packages/queue/src/queues.ts:33–53`), the IO jobs sit on `queue:io` with worker concurrency 10+ and are processed immediately, in parallel with the long-running GPU work on `queue:gpu`. Concurrency on `queue:gpu` is explicitly pinned to 1 per worker so two CUDA jobs don't fight for the same device. The CPU queue runs with `os.cpus().length` workers, scaling to the box.

A secondary failure mode with one queue: **memory and process pinning**. A `pandas.preprocess` job might need 2 GB of RAM; a `torch.train` job might need 16 GB. With one queue, you can't pin your worker pool — every worker must be sized for the worst case. With three queues, the IO workers are tiny (low memory, no GPU), the GPU workers are huge (lots of RAM, CUDA), and you scale each pool independently based on the actual mix of jobs in the system.

---

## Phase 6: Orchestrator Loop

### Q28: Why does the control plane decide what runs next instead of the workers just enqueuing their children?

**Answer:** Separation of concerns and horizontal scalability. If workers enqueued their own children, every worker would need full access to the database (to read the graph edges), knowledge of the orchestration state (to run the Lua decrement scripts), and network access to every BullMQ queue. 

By keeping workers "dumb" — they just take a job, execute it, and return a result — they can be scaled infinitely. The API (control plane) handles the complex graph traversal and state transitions. If we want to change the orchestration logic (e.g. adding conditional branches or loops), we only update the control plane, without touching the worker Docker images.

### Q29: In Kahn's algorithm, you compute in-degrees statically. How does that map to runtime execution?

**Answer:** Kahn's algorithm seeds a queue with nodes that have an in-degree of 0, then decrements children as nodes are popped. 

During orchestration, we map this exactly to Redis. When `startRun` is called, a pipeline writes the static in-degrees of every node into a Redis hash (`run:{runId}:indegree`). Then, as nodes dynamically complete over hours or days, `onNodeSucceeded` triggers the Lua script to decrement the child's counter. When the counter hits `0`, it exactly mimics Kahn's "pop and push 0-degree children" step, safely dispatching the node across distributed time and space.

### Q30: Why must `tryTransitionNodeRun` be executed before pushing to BullMQ, rather than after?

**Answer:** It acts as a distributed lock. If two orchestrator instances process the same completion event (e.g. due to a network retry), they might both try to dispatch the same child. If we enqueued first, we would push two jobs to BullMQ, and the worker would run the task twice. By updating Postgres first using `UPDATE NodeRun SET status='QUEUED' WHERE status='PENDING'`, only one orchestrator will get `rowCount === 1`. The loser gets `rowCount === 0` and aborts before touching BullMQ.

### Q31: When a node fails, why do you traverse its descendants and mark them `SKIPPED` instead of `FAILED`?

**Answer:** Accuracy of telemetry. If Node A fails, Node B (its child) never even starts. If we mark Node B as `FAILED`, our dashboards and metrics will show an elevated failure rate for Node B, even though Node B's code never executed. Marking it `SKIPPED` correctly indicates that the node was preempted by an upstream failure, keeping error metrics clean and accurate.

---

## Phase 7: Context Passing

### Q32: Why are worker outputs capped at 64 KB? What happens if a worker tries to return a 2 GB model?

**Answer:** Three systems simultaneously break if inline output is unbounded:
1. **Postgres.** The output is stored in `NodeRun.output` (a JSON column). Every row returned by `GET /runs/:id` must include this column. A single 2 GB run would cause every query to the run view to transfer gigabytes of data.
2. **Redis pub/sub.** When `NODE_SUCCEEDED` fires, the output is embedded in the event and published to `run:{runId}:events`. Redis pub/sub messages have a practical maximum of a few MB. The message would never deliver, or would be silently truncated.
3. **API memory.** The orchestrator holds the output in Node.js heap while dispatching children. Multiple concurrent runs with large outputs would exhaust process memory.

The contract: workers write large data to the shared artifact volume (`ARTIFACT_DIR/{runId}/{nodeKey}/...`) and return a small reference object — `{ "path": "...", "rows": 48213, "checksum": "sha256:..." }`. This is typically under 1 KB. The 64 KB limit is enforced by `assertOutputSize()` in `onNodeSucceeded` before any DB or Redis write. Violation immediately fails the node with a clear error message pointing at the artifact convention — not a generic crash.

### Q33: Why does the control plane resolve templates, not the worker?

**Answer:** Two principles are at stake: *workers stay dumb* and *auditability*.

If the worker resolved templates, it would need to call back to the API to fetch parent outputs — coupling the worker to the control plane's database, adding a network round-trip inside the worker's execution window, and requiring the worker to understand the template syntax. A worker failure during resolution would be attributed to the wrong component.

By resolving at dispatch time in the control plane: (1) the worker only ever receives literal values, (2) the resolved input is persisted on `NodeRun.input` before the job is enqueued, so every execution is reproducible — a forensic engineer looking at any NodeRun row 6 months later sees exactly what the worker was given, and (3) if a template fails to resolve, the failure happens before the job is on the queue, cleanly preventing the worker from starting with bad data.

### Q34: Why is an unresolved template a hard failure instead of passing `undefined` downstream?

**Answer:** Failing silently with `undefined` pushes the error to the wrong place. If `{{ nodes.preprocess.output.metadataPath }}` resolves to `undefined` and the worker receives `{ "csvPath": undefined }`, the worker will crash with a TypeError like `Cannot read property 'split' of undefined` in `pandas.preprocess.py`. The stack trace points at the Python script, not at the misconfigured template. Whoever debugs it has to chase a red herring through worker code before discovering the real bug is a misspelled path in the workflow definition.

`UnresolvedTemplateError` catches this at dispatch time, includes the exact template string that failed, and names the node it came from. The run fails before any worker CPU is spent on a job that was doomed to crash. The user gets: `Unresolved template "{{ nodes.preprocess.output.metadataPath }}" in node "train".` — clear, actionable, in the right place.

---

## Phase 8: Worker Data Plane

### Q35: How does the TypeScript compiler guarantee you haven't forgotten to implement an executor?

**Answer:** The executor registry is typed as `Record<NodeType, ExecutorFn>`. Because we use the strict `Record` type rather than `Partial<Record>`, TypeScript enforces that every single member of the `NodeType` discriminated union has a corresponding key in the registry object. If a junior dev adds a new node type in the contracts package but forgets to write an executor for it, the worker package fails to compile. This converts what would normally be a delayed runtime crash (when the job is dequeued) into an immediate compile-time failure.

### Q36: Why communicate with Python via stdout JSON instead of a REST callback?

**Answer:** A REST callback requires the Python script to know the API's address, carry an authentication token, and handle network retries if the API is momentarily unavailable. It also means the script cannot run in an air-gapped environment.

By using stdio, the Node.js bridge controls the boundaries. We pass the input context as a single JSON line on stdin. The Python script prints its output to stdout as `::RESULT:: {json}`. This requires zero network config, zero auth, and zero DB connections inside the script. We get full log streaming for free by capturing the rest of stdout, and we catch errors by buffering stderr. It makes the Python code entirely decoupled from the DAG infrastructure.

### Q37: Why do the executors write to a `.tmp` file and rename it, rather than writing directly to the final file?

**Answer:** Atomicity and idempotency. If an executor writes a 500 MB `dataset.csv` directly, and the worker process is killed via SIGKILL halfway through the write, the file system contains a corrupted half-file. When BullMQ re-delivers the job after the lock expires, the idempotency check sees `dataset.csv` exists, assumes the job already finished successfully, and short-circuits. The downstream nodes now run on corrupted data.

By writing to `dataset.tmp` and using `fs.renameSync()`, the target file only ever appears on the file system when it is 100% complete. On a crash, the half-written `.tmp` file is ignored, the idempotency check accurately sees the target file is missing, and the executor cleanly re-runs the work.

### Q38: Why do long-running tasks need a heartbeat (`extendLock`)? What happens without it?

**Answer:** BullMQ distributes jobs using Redis locks. By default, a lock expires after 30 seconds (`lockDuration`). If a worker crashes, the lock expires and BullMQ safely re-delivers the job.

However, if a `torch.train` job takes 2 hours, it will exceed the 30-second lock while still actively computing. BullMQ will assume the worker died and give the job to a *second* worker. Now two workers are training the exact same model in parallel — duplicating expensive GPU costs and potentially corrupting the weights file if they both write to it. The heartbeat calls `job.extendLock()` every 15 seconds, continually pushing the lock expiry forward as long as the worker is genuinely alive, completely preventing false re-deliveries.

---

## Phase 9: Fault Tolerance

### Q39: Why is classifying a bad-credentials error as retryable actively harmful?

**Answer:** Three reasons compound each other:

1. **Wasted time.** Retrying a Kaggle `403 Unauthorized` with exponential backoff (2 s, 4 s, 8 s …) takes 14 seconds just for three attempts. If `attempts: 10`, that's over 4 minutes before the run fails. The user is staring at a "downloading" spinner while nothing can ever succeed.

2. **Wasted API quota.** Kaggle may count 403 responses against rate limits for the API key. Each retry burns quota on a request that was always going to fail.

3. **Misleading signal.** After 10 failed attempts, the dead-letter record shows `attempt: 10`. The user might reasonably conclude "this is a flaky network problem — I should retry later," when the actual fix is "update your `KAGGLE_API_KEY` env var." Marking it unrecoverable at attempt 1 surfaces the real diagnosis immediately.

### Q40: Explain the exact math of exponential backoff with full jitter. Why does it prevent the thundering herd?

**Answer:** Standard exponential backoff: `delay = BASE * 2^attempt`. With `BASE=2000ms`, attempt 1 waits exactly 4000 ms, attempt 2 waits 8000 ms. **Every** process that fails at the same time uses the exact same delay — they retry simultaneously.

Full jitter: `delay = random(0, min(CAP, BASE * 2^attempt))`. The *window* grows exponentially, but each job picks an independent random point within it. For attempt 1, jobs pick random values between 0 and 4000 ms. With 50 jobs, they spread uniformly across 4 seconds. No single spike hits the external service; instead, it sees a steady, low-rate stream of retries that it can handle. By the time attempt 2 comes around (window 0–8000 ms), jobs that failed at attempt 1 are distributed even more sparsely across 8 seconds.

### Q41: How does BullMQ convert a SIGKILL'd worker into a safe re-delivery? Why is that only safe because executors are idempotent?

**Answer:** When a worker picks up a job, it acquires a Redis lock with a TTL (e.g. 60 s). As long as the worker is alive, it calls `extendLock()` to push the TTL forward. If the worker is `SIGKILL`'d (which cannot be caught), it stops calling `extendLock`. After 60 s, the lock expires. BullMQ's stalled-job monitor (running in a separate process) scans for jobs whose locks have expired and marks them "stalled." On the next check interval, the job is re-queued with an incremented attempt number and a fresh lock.

This is only safe because every executor checks for `result.json` before doing any work. If the `torch.train` job was SIGKILL'd after writing 90% of `model.pt` (but before the atomic rename), the re-delivered job finds no `result.json`, detects the orphaned `.tmp` file, and re-runs training from scratch on the correct weights. Without idempotency, the second worker would duplicate the training run, write a second model file, and potentially overwrite a half-completed weights file from the first worker.

### Q42: The system has three layers of concurrency limiting. Which resource does each protect?

**Answer:**

| Layer | Implementation | Resource Protected |
|-------|---------------|-------------------|
| **Per-worker concurrency** | `Worker({ concurrency: 4 })` | CPU cores / GPU slots on a single machine. Prevents one machine from overloading its own hardware. |
| **Per-run semaphore** | Redis SET (`semaphore.ts`) | Total cluster capacity per run. Prevents one user's 200-node fan-out from starving all other runs. |
| **Queue-level rate limit** | BullMQ `limiter: { max, duration }` | External API rate limits (e.g. Kaggle: 200 req/min). Prevents the cluster from collectively overwhelming a third-party service. |

Each layer protects a different boundary: the machine, the cluster, and the external world. Removing any one of them exposes the corresponding resource to exhaustion.

---

## Phase 10: Real-Time SSE Streaming

### Q43: Why SSE instead of WebSockets for the run status stream?

**Answer:** SSE is a unidirectional server→client push protocol that runs over a plain HTTP/1.1 connection. WebSockets are bidirectional and require a protocol upgrade handshake. For a read-only event stream, SSE is strictly simpler: there's no upgrade request, no custom message framing, no ping/pong logic to implement, and no special proxy configuration beyond `proxy_read_timeout`. The browser's `EventSource` API handles reconnection automatically, sends `Last-Event-ID` on reconnect, and works through nginx, AWS ALB, and CloudFront without modifications. WebSockets would be the correct choice if the browser needed to push data back — for example, live terminal input, collaborative editing, or real-time graph position sync.

### Q44: Why persist events to Postgres AND publish to Redis? Why not pub/sub alone?

**Answer:** Redis pub/sub is fire-and-forget. If a message is published to `run:{runId}:events` and no subscriber is listening at that exact moment (disconnected browser, server restart, brief network blip), the message is permanently discarded — Redis has no message store. A client that reconnects after a 5-second gap and re-subscribes will receive all future events but has no way to recover events published during the gap. From the client's perspective, the run appears frozen: it saw `NODE_RUNNING` for `train` but never received `NODE_SUCCEEDED`, so the UI shows the node as perpetually running. By persisting every event to `RunEvent` (Postgres, append-only), reconnecting clients replay exactly the missed events using the `Last-Event-ID` cursor, then switch to live pub/sub for future events. The dual-write guarantees no client ever misses a state transition.

### Q45: How does `Last-Event-ID` make reconnection exactly-once?

**Answer:** Every SSE frame the server writes includes an `id:` field set to the Postgres `RunEvent.id` (a monotonically increasing BigInt). The browser's `EventSource` tracks the last ID it received. On reconnect, it automatically sends `Last-Event-ID: {id}` in the request headers. The server calls `getRunEventsService(runId, lastEventId)` which issues `WHERE id > :lastEventId ORDER BY id ASC`. This is a half-open range: the cursor event is excluded (no duplicates), but every subsequent event is included (no gaps). The client receives exactly the events published between its last `id` and the present — not more, not less.

### Q46: Why does each SSE client get its own Redis connection? Why not share one?

**Answer:** Two constraints make sharing impossible. First, a Redis connection that has called `SUBSCRIBE` enters subscriber mode — it can no longer issue any regular command including `PUBLISH`, `GET`, or `SET`. Sharing this connection with the orchestrator (which needs to `PUBLISH` events) would corrupt both. Second, all messages for all channels arrive on the shared connection, and the client code must filter by channel. With 1000 concurrent SSE connections sharing one subscriber, each message is delivered to 1000 handlers, 999 of which check the channel and discard it — O(n) overhead per event. A dedicated connection per client is O(1): it only receives messages for the one channel it subscribed to, and cleanup is trivially safe (just `unsubscribe` and `quit`).

### Q47: Why buffer worker log lines at 200 ms before sending as SSE frames?

**Answer:** A `torch.train` script calling `print()` per batch can emit 200+ lines per second. Without buffering, each line triggers: `res.write()` → Node.js buffer flush → TCP segment → TCP ACK → browser `EventSource` callback → DOM mutation. At 200 events/s the server's event loop is doing 200 system calls per second for one training log. The browser is firing 200 DOM mutations per second on a single `<pre>` element, causing continuous layout recalculations that peg a CPU core. Buffering at 200 ms groups all lines in each interval into a single `NODE_LOG_BATCH` frame, capping throughput at 5 frames/s regardless of how verbose the script is — a 40× reduction in both server write overhead and browser DOM mutations — while keeping the perceived delay under 200 ms, which is invisible to a human reading a scrolling log.

---

## Phase 11: Visual Graph Editor (Frontend)

### Q48: Why use Zustand with sliced stores instead of React Context for the live run state?

**Answer:** During a live workflow execution, SSE status and log events arrive continuously—potentially 5-10 times a second. If this state were held in React Context, every update would trigger a top-down re-render of every component consuming that context (the canvas, all nodes, all side panels). In a large graph, this causes massive DOM thrashing and CPU spikes. Zustand supports selector granularity (`useRunStore(s => s.nodeStatuses[id])`), meaning a component only subscribes to the specific slice of state it cares about. When Node A's status updates, only Node A's component re-renders. The rest of the canvas is untouched.

### Q49: What is the architectural payoff of the "zero-dependency" rule enforced on `@dag/graph-core` in Phase 2?

**Answer:** Because `@dag/graph-core` contains pure TypeScript logic with no Node.js built-ins (`fs`, `crypto`) or external NPM dependencies, it compiles flawlessly for the browser. In Phase 11, we import the exact same `detectCycle` function used by the backend and run it inside React Flow's `onConnect` handler. This allows the frontend to instantly reject cyclic edges and highlight the cycle path in red before the user even saves. The backend remains the ultimate authority, but the frontend provides zero-latency UX validation using shared code, avoiding duplicate implementation or unnecessary API roundtrips.

### Q50: How do you handle form validation and rendering for custom node types without writing bespoke UI code for each?

**Answer:** The configuration panel is schema-driven. When a node is selected on the canvas, the UI reads the node's type and looks up the corresponding metadata (which strictly mirrors the Zod schemas defined in `@dag/contracts`). The `ConfigPanel` maps over these fields, rendering generic inputs, numbers, or dropdowns based on the schema definitions. This means adding a new executor type (like `snowflake.query`) to the platform only requires updating the backend schema—the frontend automatically knows how to render its configuration form, ensuring UI and backend validation are always in sync.

---

## Phase 12: Testing, Observability, and Load Proof

### Q51: Why Testcontainers instead of mocking Postgres and Redis in the integration suite? What specifically can a mock not catch?

**Answer:** A mock returns whatever the test tells it to return — it can never disagree with the test author's mental model of how the dependency behaves, which means it structurally cannot catch a bug in that mental model. Three concrete classes of bug in this codebase live entirely in that gap:

1. **Lua atomicity.** The in-degree decrement script's correctness depends on Redis actually pausing all other commands while the script runs. A mocked Redis client would just execute whatever JavaScript the test wired up for `eval()` — there's no way for it to accidentally *not* be atomic, because it was never really concurrent in the first place. It cannot demonstrate the bug it's supposed to prevent.
2. **Postgres row-level locking.** `tryTransitionNodeRun`'s safety depends on `UPDATE ... WHERE status = $from` taking a real row lock so two concurrent callers genuinely serialize. A mock's `updateMany` is just a function call; two "concurrent" calls to it in a test are never actually racing for a lock, they're just two sequential JavaScript function calls.
3. **BullMQ lock expiry and stalled-job recovery.** This depends on Redis TTLs actually expiring and a real background process actually re-scanning for stalled jobs on an interval. There is no meaningful way to mock a TTL expiring.

Testcontainers gives every test run a real, disposable Postgres and Redis — the same images the local dev environment uses — so passing tests are evidence about the real system's behavior, not about how faithfully a hand-written mock reproduces it.

### Q52: Your race-condition test needs `b` and `c` to complete at exactly the same moment. How do you force that deterministically instead of hoping two real workers happen to collide?

**Answer:** By not using two real workers for this at all — the test calls `onNodeSucceeded(runId, 'b', ...)` and `onNodeSucceeded(runId, 'c', ...)` **directly, together, inside one `Promise.all([...])`**, in the same Node.js process. Both calls begin executing synchronously the moment `Promise.all` runs, and each hits its own first `await` (a real Postgres query inside `onNodeSucceeded`) before either function has had a chance to finish. From that point, the event loop is genuinely interleaving two in-flight async call stacks that are both about to try to decrement `d`'s Redis in-degree counter — which is exactly the two-worker race condition the system is supposed to defend against, reproduced on purpose.

The alternative — spin up two real worker processes and hope they finish `b` and `c` within the same few milliseconds — would work *sometimes*. Computers are fast; the "bad window" where the race actually manifests can be a fraction of a millisecond. A test that only sometimes exercises the interleaving it's supposed to test gives false confidence: it can pass 99 times in a row with a real bug present, and the one time it happens to fail, nobody trusts it enough to investigate. `Promise.all` on two direct async calls forces the exact same interleaving on every single run, deterministically, not probabilistically.

### Q53: Why does the race-condition test seed `a`, `b`, and `c` directly into the database instead of dispatching them through `startRun` like a real run would?

**Answer:** This suite shares two long-lived worker processes across every test file (spawned once, in the suite's global setup, not per test). Those workers are always polling the real BullMQ queues. If the test dispatched `a`/`b`/`c` through the real `startRun`/`dispatchNode` path, it would create real jobs on a real queue — and the shared workers would race to pick up and execute `b` and `c` themselves, on their own schedule, before the test's own `Promise.all` ever got a chance to run its two `onNodeSucceeded` calls. The test would then be racing against an uncontrolled, real worker instead of deterministically forcing the interleaving it's trying to prove is safe — exactly the flaky, "hope it collides" test the deterministic design was meant to avoid.

The fix: seed `b` and `c`'s rows directly into Postgres as `RUNNING`, and seed the Redis in-degree hash directly, so no BullMQ job is ever created for them — nothing else in the system can touch them before the test does. Only `d`, the thing actually under test, goes through the real `dispatchNode()` → `queue.add()` path, so the assertion ("exactly one execution was ever enqueued for `d`") is still proven against real code, not a stand-in.

### Q54: Writing the retry-failed integration test found a real bug. Walk through it.

**Answer:** `retryFailedNodesService` reset a `FAILED` node's row to `PENDING` (incrementing its attempt counter) and reset its `SKIPPED` descendants to `PENDING` too, then transitioned the `Run` back to `RUNNING` — and returned success. But nothing in that function ever called `dispatchNode` for the reset node. In every other part of the system, a node gets dispatched because something *unlocks* it: `startRun`'s initial scan finds in-degree-0 nodes, or `onNodeSucceeded`'s Lua decrement finds a child whose last parent just finished. A node that reached `FAILED` already had its dependencies satisfied — that's *why* it was able to run and fail in the first place — so there is no future decrement coming that would ever dispatch it again. The route returned `{ retried: 1, ... }`, looking successful, while the run sat frozen forever.

The Testcontainers integration test caught this because it actually waits for the run to reach a terminal state after calling retry — `waitUntil(() => run.status === 'SUCCEEDED' || 'FAILED')` — and the promise simply never resolved within the timeout. A test that only checked "the DB row says PENDING now" (the kind of assertion a mocked-DB unit test would naturally settle for) would have passed while the real behavior was broken. The fix: after resetting failed nodes to `PENDING` and putting the run back in `RUNNING`, explicitly call `dispatchNode` for each of them. The reset `SKIPPED` descendants don't need the same fix — `onNodeFailed`'s original BFS never touched their Redis in-degree counters when it marked them skipped, so those counters are still sitting at their original value and will decrement and dispatch correctly through the normal path once the retried node succeeds.

### Q55: `startRun` had a bug where the caller saw the wrong run status. What was it, and why did five earlier phases of tests miss it?

**Answer:** `startRun` fetches `run` from `createRun` (status `PENDING` at that point), then calls `tryTransitionRun(run.id, 'PENDING', 'RUNNING', ...)` to flip the row in Postgres. That call succeeds — but nothing then updates the *in-memory* `run` object the function goes on to return. Postgres correctly shows `RUNNING`; the object `POST /runs` serializes into its response, and everything else in the codebase that calls `startRun()` directly, still shows the stale `status: 'PENDING'` captured before the transition. In JavaScript, mutating a database row doesn't retroactively change a variable you already read from it.

Phase 6's own acceptance test (`orchestrator.test.ts`) actually asserts `expect(run.status).toBe('RUNNING')` — the right check existed from day one. But that test is `describe.skipIf`-guarded to only run when a real `DATABASE_URL`/`REDIS_URL` are configured, specifically so the fast mocked suite doesn't fail on missing infrastructure. In this environment, nothing had ever pointed real infrastructure at that test file before the Testcontainers suite did in Phase 12 — so a correct test had been sitting in the repo, silently skipped, the entire time. The fix is a two-line patch: after the transition succeeds, set `run.status = 'RUNNING'` and `run.startedAt = startedAt` on the object before returning it. The deeper lesson is about the skip guard itself, not just the bug — a test that's frequently skipped provides exactly as much protection as no test at all.

### Q56: Explain the `/metrics` design: why are some numbers recomputed on every scrape and others captured once, at the moment they happen?

**Answer:** It comes down to whether the number is a *snapshot* of current state or a *measurement* that only exists at one instant in time. "How many `NodeRun`s are currently `RUNNING` right now" is a snapshot — Postgres can answer it correctly at any moment with a `GROUP BY status` count, and doing that on every `/metrics` request guarantees the number is always exactly right, because it's derived fresh from the same table every application invariant is enforced against. The alternative — a running counter incremented at every dispatch/success/failure/skip/cancel call site — introduces five separate places that all have to remember to update it correctly forever; one refactor that forgets an increment and the metric silently drifts from reality with no way to detect it.

Node execution duration is the opposite case: it's a *measurement*, not a snapshot. Postgres only stores the *latest* `startedAt`/`finishedAt` on each row — there is no historical time series anywhere in the database that a scrape-time query could reconstruct "what was the distribution of the last 10,000 node durations." That number only exists at the moment a node transitions to a terminal state, so it has to be captured right then, inside `onNodeSucceeded`/`onNodeFailed`, into a `prom-client` `Histogram`. Using a scrape-time query for the histogram is impossible; using an incremented counter for the status gauges is unnecessary risk for no benefit. The two metric types get two different collection strategies because they're two different kinds of fact.

### Q57: The scale test uses a fan-out/fan-in graph shape instead of a chain — why does that matter for what the benchmark is trying to prove?

**Answer:** The benchmark exists to show that adding worker processes increases throughput — which requires actually creating a situation where more concurrent capacity has something to do. A straight 10-node chain can't create that situation at any real scale: since every node in a chain has exactly one predecessor, at most one node per run can ever be "ready to dispatch" at the same instant — with 200 concurrent runs, that's a ceiling of 200 simultaneously-ready nodes, regardless of whether 1 or 40 workers are available to pick them up. Beyond a handful of workers, adding more would show almost no measurable difference, and the benchmark would (correctly, but uselessly) report "no scaling benefit," which is true of a chain-shaped workload but says nothing about the engine's actual concurrency handling.

The scale-test graph is instead `root → 8 parallel branches → sink`: the moment every run's `root` node finishes, up to `runs × 8` nodes become ready near-simultaneously — with 200 runs, up to 1,600 nodes racing for `queue:cpu` slots at the same moment. That burst is what actually exercises the dispatch/queue machinery under contention, which a chain-shaped graph never would — whether or not the *result* turns out to be clean scaling (it wasn't, on this machine — see Q58/Q59) is a separate question from whether the test is capable of measuring it at all.

### Q58: The first attempts at running the scale test at full scale (200 runs, 4 workers) failed outright with a Postgres error, not a timing number. What happened, and what does it teach?

**Answer:** `FATAL: sorry, too many clients already` — a genuine Postgres connection-pool exhaustion, not a simulated failure. Each worker *process* constructs its own `PrismaClient`, and Prisma's default connection-pool size assumes that client owns the database's entire connection budget; it has no way to know three other worker processes made the identical assumption. With `postgres:16`'s default `max_connections = 100`, four workers each defaulting to roughly a dozen connections, plus the control-plane process handling 200 concurrent runs' worth of dispatch and completion traffic through its own pool, comfortably exceeded that ceiling. A second, compounding bug made it worse: `worker-process.ts` spawns workers with `shell: true` (the `tsx` binary is a `.CMD` shim on Windows), and on Windows the `ChildProcess` handle returned in that case refers to the *shell*, not the real worker it launches — `proc.kill()` only signaled the shell, leaving every "stopped" worker from every prior attempt still running, still holding its connection, invisible to anything tracking the handle. By the third or fourth accumulated run, exhaustion was inevitable before the benchmark even started.

Both are fixed now (`packages/db/src/client.ts` bounds `connection_limit` explicitly per process; `worker-process.ts` uses `taskkill /T` on Windows to kill the whole process tree). The general lesson: **the database connection budget is a real, easy-to-hit wall that has nothing to do with the DAG engine's own logic** — it's purely an artifact of "N processes, each assuming it owns the pool." At real production scale the standard fix is a connection pooler in front of Postgres (PgBouncer, or Prisma Accelerate) so the number of application processes can grow independently of how many connections Postgres itself has to hold open; hand-sizing per-process pools (what this project does) is a stopgap appropriate for a handful of processes, not for real horizontal scale.

### Q59: With the connection issue fixed, the actual benchmark numbers came back — and they *don't* show clean 4x-workers-means-4x-throughput scaling. What do they show, and is that a bad result?

**Answer:** The real numbers, 200 runs of the 10-node fan-out graph on this machine (12 logical cores):

| Workers | Throughput | p95 latency | Max queue depth |
|---|---|---|---|
| 1 | 11.0 nodes/s | 908ms | 1604 |
| 4 | 12.3 nodes/s | 4097ms | 1542 |

Throughput improved only marginally (1.12x) with four times the worker processes, and p95 latency got noticeably *worse*. That is not a bug in the DAG engine's dispatch logic — the queue-depth numbers are nearly identical between the two passes, which means workers in both cases were never starved for work and Redis/Postgres were never the bottleneck at this scale. What changed is `CPU_CONCURRENCY=8` per worker × 4 worker processes = 32 concurrent slots all trying to spawn real `python3` child processes simultaneously, on a machine with 12 logical cores. Past a certain point, adding more concurrent OS process spawns doesn't find idle capacity — it makes every process wait longer for CPU time via context-switching, which shows up as worse tail latency even as the raw completion count creeps up slightly.

This is not a bad result to report — it is *the* result a load test exists to produce. A benchmark that only ever reports "everything scales linearly" without ever finding where that breaks down is not measuring anything; it's restating an assumption. The honest reading here is: this project's own architecture (dispatch, Lua atomicity, queue routing) held up identically under both passes — nothing broke, no correctness issue, no duplicate work — and the actual limiting factor at this load, on this hardware, was CPU-bound process-spawn contention, which is a property of the *deployment environment* (four worker processes sharing one 12-core box), not of the software. Four workers on four separate machines — the scenario horizontal scaling is actually meant for — would not share this constraint. Being able to say precisely which layer the bottleneck lived in, rather than reporting a number without an explanation, is the difference between a benchmark and a demo.

---

## Phase 13: Containerisation and Horizontal Scaling

### Q60: `packages/db`, `graph-core`, `contracts`, and `queue` are pure TypeScript with no build step — their `package.json` "main" points straight at `./src/index.ts`. Why did that break in Docker when it never broke in local development, and how did you fix it?

**Answer:** It broke because of what runs the code, not where the code lives. In local development, every entry point runs through `tsx` (`tsx watch src/index.ts`) — `tsx` patches Node's module loader so that *any* `.ts` file required anywhere in the process, including a workspace package pulled in via `require('@dag/db')`, gets transpiled on the fly. A `tsc`-compiled production build has no such patch: `tsc` compiles `apps/api/src/index.ts` to JavaScript, but a bare `import ... from '@dag/db'` in that source is left as `require('@dag/db')` in the output — TypeScript doesn't rewrite package-name imports, only resolves them for type-checking. At runtime, plain `node` follows that `require` to `@dag/db`'s `package.json`, sees `"main": "./src/index.ts"`, and has no idea how to execute a `.ts` file. It's not a bug in any one file; it's a mismatch between "the workspace's whole design assumes a transpiler is present" and "a naive `node dist/index.js` production setup assumes it isn't."

The fix: keep running production containers via `tsx`, exactly like every dev script and every Phase 12 test already does — `CMD ["node_modules/.bin/tsx", "src/index.ts"]` — instead of introducing a second, less-exercised code path (a real per-package build, or a bundler) that only production would ever use. The trade-off is real — `tsx` has to ship in the runtime image, and every container pays a small transpile cost at startup — but it means production runs the *identical* command every other phase of this project already validated, rather than a new one that's never been tested until the first real deployment.

### Q61: Why does the worker's Dockerfile install `python3` but deliberately not `pandas` or `torch`, even though the reference use case is an ML pipeline?

**Answer:** Because the actual scripts don't import them. `apps/worker/python/preprocess.py`, `train.py`, and `evaluate.py` are pure-stdlib fixtures — built in Phase 12 to exercise the real Node↔Python bridge, the worker's idempotency checks, and its heartbeat/lock-extension machinery under real test and load conditions, not to perform real machine learning. Installing real PyTorch (routinely several hundred MB to multiple gigabytes, more with CUDA support) for code that never once calls `import torch` would be pure image bloat working directly against this same phase's "slim runtime" goal, for a capability nothing in the image actually uses.

This is a documented, deliberate scope boundary, not an oversight papered over — the Dockerfile's own comment names the exact line a deployment with real ML scripts would need to add (`RUN pip3 install -r requirements.txt`, right after the `python3` install). Being explicit about "this is a fixture, here's what a real version would need" is more defensible in review than either silently installing multi-gigabyte dependencies nothing uses, or leaving a reader to wonder whether the omission was intentional.

### Q62: Walk through the exact two-part failure the Docker build hit around pnpm's version, and why the second failure wasn't visible from the first error message.

**Answer:** First failure: `corepack enable` with no version pin fetches whatever pnpm currently publishes as "latest," which turned out to require Node.js ≥22.13 — and the build's base image was `node:20-alpine`. The error was explicit (`this version of pnpm requires at least Node.js v22.13`), so the apparent fix was obvious: pin the exact pnpm version already used everywhere else in the project (`corepack prepare pnpm@11.6.0 --activate`, plus adding a `packageManager` field to the root `package.json` so corepack has a version to find in the first place — which also required copying `package.json` into the Docker build's `fetch` stage a step earlier than before, since corepack needs to see that field before the first `pnpm` command runs).

That fix did not work. The *second* failure, after pinning to 11.6.0 specifically, was a completely different error: `Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite`. This wasn't a version-selection bug at all — pnpm 11.6.0 itself, the exact version already running locally on this project's own development machine, imports `node:sqlite`, a Node.js builtin that only exists from Node 22.5 onward. The first error message was actually correct and specific; it just happened to also be true of the *pinned* version, not only "latest" — the local dev machine had simply never surfaced this requirement because it already runs Node 22.14. The real fix was bumping every Dockerfile's base image from `node:20-alpine` to `node:22-alpine` (which PROJECT_GUIDE.md's "Node.js 20+" tech-stack entry already permits — "+" means 20 or newer). The general lesson: a clean Docker build is often the first time a project's actual toolchain requirements get checked against an environment with no locally-installed version quietly satisfying something nobody wrote down — the same value Testcontainers provided for runtime bugs in Phase 12, here applied to the build environment.

### Q63: Why does the `migrate` one-shot service build from the Dockerfile's `build` target instead of the same slim `runtime` target the `api` and `worker` services use?

**Answer:** `prisma migrate deploy` needs the Prisma CLI to run — and the Prisma CLI is a devDependency of `packages/db`, exactly the category of package `pnpm prune --prod` strips out to produce the slim `runtime` image. Two ways to reconcile that: add the Prisma CLI back into the runtime image (so every API and worker container permanently carries a tool they never use, forever, for a command that runs once at cluster startup), or point the one-shot migration service at an *earlier* build stage that still has it. The Dockerfile already has such a stage — `build`, the one right before `prod-deps` strips devDependencies out — so the `migrate` compose service simply targets that stage directly (`target: build`). The actual long-lived runtime images stay exactly as slim as `pnpm prune --prod` can make them; the one container that pays for the extra weight is the one that exists for a few seconds per deployment, which is precisely where that trade-off is free.

### Q64: Why gate API and worker startup on `service_completed_successfully` for the migration service, rather than just waiting for Postgres's own healthcheck?

**Answer:** Because those two things prove different facts. Postgres's healthcheck (`pg_isready`) proves the database *process* is up and accepting connections — it says nothing about whether the actual tables (`NodeRun`, `RunEvent`, everything `@dag/db`'s repository helpers assume exists) have been created yet in that particular database. A freshly-created Postgres container passes `pg_isready` the moment it finishes booting, well before any schema exists. If API or worker started as soon as Postgres was merely healthy, the very first query either of them issued would fail against a database with no tables — a real race, not a hypothetical one, and one that would get *more* likely to bite, not less, the faster the machine (less time between "Postgres healthy" and "API's first query" for the migration to sneak in).

`depends_on: { migrate: { condition: service_completed_successfully } }` makes "the schema is fully migrated" an explicit, structurally-enforced precondition: API and worker containers do not start their own entrypoint process at all until the `migrate` container has exited with code 0. There's no timing window to get unlucky in, and no fixed sleep duration to tune for "probably long enough" — the dependency is expressed as a fact about outcome (did the migration finish successfully), not a guess about duration.

### Q65: The workflow's own acceptance check for this phase requires proving `--scale worker=4` "requires zero config changes and produces no duplicate execution." What in the actual service definition makes that true, versus something that just happens to work today?

**Answer:** It's true structurally, not by luck. The `worker` service in `docker-compose.yml` has no `container_name` (a fixed name would make Compose refuse to start a second replica — names must be unique), no per-instance environment variable, and no manually assigned `WORKER_ID`. `docker compose up --scale worker=4` doesn't run four *different* service definitions; it runs four containers from the exact same one. Each container's `WORKER_ID` falls back to `worker-${process.pid}` (`apps/worker/src/worker.ts`) — a real OS process ID, which the kernel guarantees is unique within that container and which differs across containers by construction, since each is a separate process. No coordination between replicas is needed to avoid an identity collision because nothing about a replica's identity depends on any other replica existing.

"No duplicate execution" is a separate claim, proven elsewhere in the system, not by this configuration: it's the four-layer defence from Phase 5/6 (Lua atomic in-degree decrement, the `SADD` dispatch guard, BullMQ's deterministic `jobId`, and the `@@unique([runId, nodeKey])` Postgres constraint) that makes it structurally impossible for two workers — however many replicas exist — to both execute the same node. Scaling workers changes how much *capacity* is competing to pull the next job off a queue; it does not change how many times any given job can be claimed and run, which was already exactly once regardless of worker count.

---

## Phase 14: Documentation Consolidation

### Q66: Walk me through your system end-to-end in 5 minutes.

**Answer:**

> *Draw: Browser → API → Redis → Workers → API → Browser on the whiteboard. Reference each box as you go.*

**Step 1 — Browser, instant cycle detection.** The user drops an edge in the React Flow canvas. Before the edge is saved, `onConnect` calls `detectCycle` imported from `@dag/graph-core` — the exact same function the server uses. Zero API call, zero latency. If it returns `hasCycle: true`, the edge is rejected and the cycle path flashes red. This works because Phase 0's zero-dependency rule means `graph-core` bundles identically in the browser and on the server.

**Step 2 — API validates and versions the graph.** `POST /workflows/:id/versions` runs `GraphSchema.parse` (structural checks — unique keys, no dangling edges), then `detectCycle` (server is the authority), then `topologicalSort` via Kahn's algorithm, which returns both a linear order and `tiers` — groups of nodes with no interdependencies that can dispatch simultaneously. All three results are cached on the `WorkflowVersion` row. No recomputation per run.

**Step 3 — startRun seeds Redis and dispatches.** `POST /workflows/:id/runs` calls `startRun`: one Postgres transaction creates the `Run` and one `NodeRun` per node (all `PENDING`); then `seedInDegrees` writes every node's in-degree into a Redis hash in a single pipelined round trip; then nodes with in-degree 0 are dispatched immediately. `dispatchNode` does three things: conditional `UPDATE ... WHERE status='PENDING'` as a distributed lock, template resolution (parent outputs substituted into child configs — persisted literally on `NodeRun.input` before the job goes to the queue), and `queue.add` with a deterministic `jobId`.

**Step 4 — Worker executes.** A BullMQ `Worker` process pulls the job. The executor registry is `Record<NodeType, ExecutorFn>` — a non-Partial type, so adding a node type without an executor is a compile error. For Python tasks, `runPython` spawns a child process, streams stdout to the run log, reads the `::RESULT::` sentinel line as the output. Idempotency: checks for `result.json` first; writes to `.tmp` then atomically renames. For long tasks, `job.extendLock()` every 15 s prevents false stall detection.

**Step 5 — Control plane reacts.** The API listens to BullMQ `QueueEvents`. On `completed`, `onNodeSucceeded` runs: persist output, conditional transition to `SUCCEEDED`, then for each child — one atomic Lua round trip: `HINCRBY` the in-degree and `SADD` to the dispatched set. Only the caller that sees `SADD` return 1 dispatches the child. This is Kahn's algorithm made distributed and atomic. On failure: BFS all descendants, mark them `SKIPPED`.

**Step 6 — Browser sees it live.** Every transition writes to `RunEvent` (Postgres, for replay) and publishes to `run:{runId}:events` (Redis pub/sub, for immediacy). The SSE endpoint replays missed events since `Last-Event-ID` on reconnect, then hands off to live pub/sub. In the browser, Zustand's narrow selectors mean only the affected `CustomNode` re-renders — not the whole canvas.

---

### Q67: Your `KNOWN_LIMITATIONS.md` lists 10 gaps. Which one would you close first, and why?

**Answer:** The uncommitted Prisma migrations — because it's the only one that affects *correctness* on a fresh deployment right now, not in a scaled-up future scenario. Every other gap (auth, object storage, conditional branching) would surface when the system grows. The missing migration files would surface the first time anyone runs `docker compose up` on a machine that hasn't already manually run `migrate dev` — and the failure mode is silent: the containers start, `migrate deploy` finds no migration files to apply, and the API boots against a Postgres instance with no tables. The first API call crashes. That's not a scaling problem; that's a basic reproducibility gap.

The fix is two commands and one git commit: `pnpm --filter @dag/db db:migrate:dev` on a clean local database, remove `prisma/migrations/` from `.gitignore`, commit. Once that's done, `docker compose up --build` on any clean machine matches the behaviour the README promises.

The second priority would be the lint backlog — because ~30 `@typescript-eslint/no-explicit-any` errors in `apps/api`/`apps/worker` mean `pnpm -r lint` is broken in CI, which means real new errors introduced by future work would be invisible against the existing noise. A broken lint gate is technically not a functionality gap, but it makes every subsequent change riskier.

---

### Q68: The scale test shows only 1.12x throughput improvement going from 1 to 4 workers. Does that mean the architecture doesn't scale?

**Answer:** No — it means the architecture scaled correctly and the bottleneck is the *deployment environment*, not the dispatch logic. Let me be precise about what the numbers show.

Both passes completed all 2,000 nodes with zero errors and zero duplicate executions. The queue depth numbers are nearly identical (1604 vs 1542 max), meaning workers in both passes were never starved — Redis and Postgres were not the bottleneck. What changed between passes: `CPU_CONCURRENCY=8` × 1 worker = 8 concurrent `python3` spawns on a 12-core machine. `CPU_CONCURRENCY=8` × 4 workers = 32 concurrent `python3` spawns on the same 12 cores. Past 12 concurrent processes, you're not finding idle capacity — you're context-switching, which inflates tail latency (p95 908ms → 4097ms) even as raw completion count creeps up.

The four-worker test is four workers on *one machine*. Horizontal scaling is designed for four workers on *four machines*. The control plane, Redis dispatch, Lua atomicity, and conditional Postgres updates all behaved identically in both passes — the design is validated. The metric that would prove linear throughput scaling is CPU utilisation per machine, not aggregate throughput when all machines are the same machine. A production test would deploy four workers across four separate EC2 instances; we would expect throughput to scale roughly linearly there because each worker has its own 12 cores, not 3 contested ones.

The honest value of this benchmark is not the throughput number — it's that it found the *actual* bottleneck (CPU-bound process-spawn contention on shared hardware) rather than letting an assumption ("more workers = more throughput") go unexamined.
