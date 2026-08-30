# System Design Walkthrough

This document is the verbal narrative you deliver in an interview. It is designed as a
**5-minute continuous story** that takes the interviewer from the user's canvas action through
to the browser updating in real time, covering every key technical decision naturally in sequence.
The two follow-up questions at the end ("how would you scale to 10k concurrent workflows?" and
"what breaks first?") are answered at the end.

---

## The 5-Minute Verbal Tour

> **Tip:** Speak through this section as a story, not a list. Draw the three-box diagram
> (Browser → API → Redis → Workers → API → Browser) on the whiteboard before you start talking.
> It anchors every sentence that follows.

---

### Step 1 — The user draws an edge, and the browser rejects a cycle instantly

The user is in the React Flow editor (`apps/web`). When they drop an edge that would form a
cycle, `onConnect` fires before the edge is saved. We import `detectCycle` from
`@dag/graph-core` — the *exact* same function the API server uses — and run it in the browser.
If it returns `hasCycle: true`, we reject the connection, highlight the offending path in red,
and never call the server. Zero latency, zero round trips.

This is the payoff for Phase 0's zero-dependency rule: `graph-core` is pure TypeScript with no
Node.js builtins and no npm deps, so Vite bundles it for the browser identically to how Node
requires it on the server. One implementation, used in two environments, guaranteed to be in sync.

---

### Step 2 — The user clicks Save, and the API validates the graph

`POST /workflows/:id/versions` arrives. The `validateBody` middleware parses the body through the
Zod `CreateVersionBody` schema (from `@dag/contracts`). If the body is malformed, it stops here
with a 400.

Inside `createVersionService`, we call `validateGraph(graph)`:
1. `GraphSchema.parse(graph)` — checks structural rules (no duplicate node keys, no dangling
   edges, no self-loops) in a single pass.
2. `detectCycle(graph)` — the iterative 3-colour DFS. If it returns `hasCycle: true`, we throw
   `CycleError(path)`, which the central error handler maps to HTTP 422 with the cycle path in
   the body. The browser highlights the exact edges.
3. `topologicalSort(graph)` — Kahn's algorithm. Produces `{ order, tiers }`: `order` is the
   linear execution sequence; `tiers` groups nodes into levels of parallelism (nodes at the same
   tier have no interdependencies and can run simultaneously).

We persist the version row with `graph`, `topoOrder`, and `tiers` stored together. The topological
sort is **never recomputed at run time** — it's O(V+E) once at save time, O(1) at dispatch.

---

### Step 3 — The user clicks Run

`POST /workflows/:id/runs` calls `startRun(versionId)`:
1. One Postgres transaction creates the `Run` row (status `PENDING`) and one `NodeRun` row per
   node (all `PENDING`). The `@@unique([runId, nodeKey])` constraint is the structural backstop
   against double-execution.
2. `seedInDegrees(runId, graph)` writes the initial in-degree of every node into a Redis hash
   (`run:{runId}:indegree`) in a single pipelined round trip.
3. We compute the initial ready set — every node whose in-degree is 0 (those with no parents) —
   and call `dispatchNode` for each.

`dispatchNode` does three things:
1. `tryTransitionNodeRun(id, 'PENDING', 'QUEUED')` — a conditional SQL `UPDATE ... WHERE status =
   'PENDING'`. If `count === 0`, another actor already dispatched this node; we abort. This is the
   distributed lock that gates BullMQ.
2. Resolve template references. If the node's config contains `{{ nodes.preprocess.output.path }}`,
   we look up the parent's `NodeRun.output` from Postgres and substitute the literal value. The
   resolved input is persisted on `NodeRun.input` before the job goes to the queue. Workers always
   receive literals — they never see a template.
3. `queue.add(type, payload, { jobId: createJobId(runId, nodeKey, attempt) })` — push to the
   correct BullMQ queue (`queue:io` / `queue:cpu` / `queue:gpu`) based on the node type. The
   deterministic `jobId` makes BullMQ silently deduplicate if the API crashes and retries.

---

### Step 4 — A worker executes the node

A BullMQ `Worker` process pulls the job. The executor registry is typed as
`Record<NodeType, ExecutorFn>` — adding a new node type in the contracts without a matching
executor is a compile error, not a runtime crash.

For a Python task, `runPython(script, input)` spawns a child process, writes the input JSON to
stdin, streams stdout line-by-line to the run log, and waits for a `::RESULT:: {json}` sentinel
as the final output line. Non-zero exit → `RetryableError` or `UnrecoverableError` depending on
the exit code and stderr content.

Every executor checks for `result.json` before doing any work (idempotency). It writes to
`result.json.tmp` then `fs.renameSync` (atomic write). A SIGKILL mid-write leaves only the `.tmp`
file; the real output is never partial.

For long tasks, `startHeartbeat` calls `job.extendLock()` every 15 s, preventing BullMQ from
falsely reclaiming a live job as stalled.

---

### Step 5 — The control plane reacts to completion and unlocks children

The API process subscribes to BullMQ `QueueEvents`. When a job emits `completed`, it fires
`onNodeSucceeded(runId, nodeKey, output)`:
1. `assertOutputSize(output)` — rejects inline payloads > 64 KB. Large data travels by reference
   (a path to the shared artifact volume).
2. `tryTransitionNodeRun(id, 'RUNNING', 'SUCCEEDED')` — conditional update, same pattern.
3. For each child in the adjacency map: call the atomic Lua script (one Redis round trip):
   - `HINCRBY run:{runId}:indegree nodeKey -1` → get `remaining`
   - If `remaining > 0`, return 0 (still waiting on other parents).
   - `SADD run:{runId}:dispatched nodeKey` → if returns 0, another caller already claimed it.
   - Return 1 only if we atomically decremented to ≤ 0 AND won the SADD claim.
   - Only when the Lua script returns 1 do we call `dispatchNode` for the child. This is
     Kahn's algorithm made distributed and atomic — all in one Redis operation.
4. If no non-terminal `NodeRun` rows remain, transition the `Run` to `SUCCEEDED`.

On failure: `onNodeFailed` does a BFS over all descendants using `graph-core`'s adjacency map
and marks them `SKIPPED` — never `FAILED`, because they never ran.

---

### Step 6 — The browser sees it happen in real time

Every state transition appends a `RunEvent` row to Postgres **and** publishes to the Redis
pub/sub channel `run:{runId}:events`. Postgres is the durable store; Redis is the low-latency
broadcast.

`GET /runs/:id/events` is a Server-Sent Events endpoint. On connect, it replays all persisted
`RunEvent` rows since `Last-Event-ID` (the cursor the browser's `EventSource` sends on reconnect),
then subscribes to the live pub/sub channel. A reconnecting browser never misses a transition —
the Postgres replay covers the gap, pub/sub covers the live stream.

Each SSE client gets its own Redis subscriber connection (`subscribeToRun` spawns a fresh
`new Redis()`). A subscribed connection is in subscriber mode — it can't issue regular commands —
so isolating per client prevents cross-stream interference and makes cleanup trivial.

In the browser, `runSlice` in Zustand receives each SSE frame and updates only the affected node's
status. `CustomNode` subscribes with a narrow selector (`s => s.nodeStatuses[id]`) — only that
node re-renders. The rest of the 50-node canvas is untouched.

---

## Interview Follow-Up: "How would you scale this to 10,000 concurrent workflows?"

The current architecture handles hundreds of concurrent runs comfortably. At 10,000 the pressure
points shift to four specific layers:

**1. The orchestrator process becomes a bottleneck.**
The API is a single Node.js process today. At 10,000 concurrent runs completing nodes, the
`QueueEvents` listener receives thousands of `completed` events per second, each triggering an
async call stack of Postgres writes + Redis Lua scripts. Node's event loop will saturate.
*Fix:* Split the orchestrator into its own horizontally-scalable service. The key insight is that
`onNodeSucceeded` is safe to run on any API instance because every critical operation uses atomic
primitives: the conditional Postgres update and the Lua script. Two orchestrator instances cannot
both win — only one sees `tryTransitionNodeRun` return `true` and only one sees the Lua script
return 1. Scale the orchestrator pool behind a BullMQ `QueueEvents` consumer group.

**2. Postgres becomes the write bottleneck.**
At 10,000 concurrent runs, `allNodeRunsTerminal`'s `COUNT(*)` query (is the run done?) and every
`tryTransitionNodeRun` write land on one Postgres primary.
*Fix:* Replace the per-completion `COUNT` query with the Redis `remaining` counter pattern
(Q16 in `interview_qa.md`): maintain `run:{id}:remaining` as a Redis atomic counter, decrement
it on each terminal transition, and check `=== 0` for run completion — O(1) per event, no DB
query. For writes, add a read replica for `GET /runs/:id` queries and reserve the primary for
write-path only. Beyond that: PgBouncer for connection pooling (the `connection_limit` tuning
issue from Phase 12 becomes unmanageable at scale without it).

**3. Redis becomes the in-degree state bottleneck.**
Each run owns two Redis hashes. At 10,000 runs × 200 nodes = 2,000,000 hash fields. Redis is
single-threaded; Lua scripts serialize. Under high fan-out (all 10,000 runs completing their
root node simultaneously), the Lua script queue can grow deep.
*Fix:* Redis Cluster with consistent hashing on `runId` — all keys for one run (`indegree`,
`dispatched`, `slots`) hash to the same shard, so the Lua script never crosses shard boundaries.
This is transparent to the application layer because all three keys share the same hash tag
pattern (`{runId}:*`).

**4. SSE connections become a file-descriptor problem.**
10,000 concurrent browser clients = 10,000 persistent HTTP connections + 10,000 Redis subscriber
connections on the API process.
*Fix:* Move SSE behind a dedicated streaming gateway (e.g., a Nginx push stream module, or a
purpose-built SSE multiplexer). The gateway holds the HTTP connections; the API publishes to the
Redis pub/sub channel; the gateway subscribes once per channel and fans out to all connected
browsers. 10,000 browser connections collapse to at most one Redis subscriber per active run,
regardless of how many clients are watching it.

---

## Interview Follow-Up: "What breaks first under load, and what would you fix?"

**What breaks first:** The orchestrator's single event loop. Every `QueueEvents.completed` event
triggers 3–5 async operations (Postgres write, Lua call, conditional dispatch). A sustained burst
of completions — the moment a wide fan-out run's 200 parallel nodes all finish within a second —
queues hundreds of events against one event loop. Latency spikes before any infrastructure limit
is hit because Node.js's single thread becomes the serialisation point.

**Second to break:** The Postgres connection pool. `packages/db/src/client.ts` sets a fixed
`connection_limit` per process. The current default (5 for workers, higher for the control plane)
was sized for the scale test's 4-worker scenario. At 10,000 runs and N orchestrator replicas, the
arithmetic of `N × connection_limit < postgres max_connections` becomes load-bearing. Without
PgBouncer, the first symptom is `FATAL: sorry, too many clients already` — the exact error Phase
12's benchmark hit — and the fix is connection pooling, not tuning per-process limits.

**Third:** Redis memory. 10,000 active runs each with a 200-key in-degree hash and a dispatched
set. At peak, that's ~20 million keys. The 7-day TTL on abandoned runs (`seedInDegrees` sets
`EXPIRE run:{id}:indegree 604800`) prevents unbounded growth, but the working set during a burst
of 10,000 simultaneous active runs needs to fit in Redis's allocated memory. On a 4 GB Redis
instance, 20 million small-integer hash values is borderline. Redis Cluster is the answer.

**What would not break:** The worker fleet, the queue dispatch architecture, the Lua atomicity,
and the correctness guarantees (no double-execution). These are stateless or externally atomic —
adding more workers adds throughput without touching state. The bottlenecks are all in the
*control plane*, not the *data plane*, which is exactly what the "workers stay dumb" architectural
decision was designed to achieve.

---

## Quick-Reference: The One-Sentence Explanation of Each Phase's Core Decision

| Phase | Core Decision | One-Sentence Why |
|-------|--------------|------------------|
| 0 | pnpm workspace monorepo | `graph-core` must run identically in the browser and on the server with no publish step. |
| 1 | Zod as single source of truth | Types inferred via `z.infer<>` so there is only one place to update when a field changes. |
| 2 | Iterative DFS + Kahn's | DFS gives the exact cycle path for UI highlighting; Kahn's naturally groups nodes into concurrent tiers. |
| 3 | Immutable `WorkflowVersion` | A run pins a version; mutating the graph mid-run would make the scheduler read a graph that no longer matches what was dispatched. |
| 3 | Conditional `UPDATE ... WHERE status = $from` | Collapses read+write into one atomic SQL operation, preventing the lost-update race without a separate lock. |
| 4 | `topoOrder` cached at version-creation time | O(V+E) once is free; O(V+E) per run start at 1000 concurrent starts/s is wasteful and racy. |
| 5 | Lua script for in-degree decrement | Redis pauses all other commands during Lua — the only way to make "decrement and test" atomic across distributed workers. |
| 5 | Three queues by resource profile | A 40-minute GPU job on a single queue starves 2-second IO jobs behind it; separate queues let each pool scale to its own resource type. |
| 6 | Control plane owns scheduling | Workers that enqueue their own children need DB access and graph logic; keeping them dumb lets them scale horizontally with zero coordination. |
| 7 | Template resolution at dispatch time | That's the only window where the parent's output exists AND we haven't yet committed to running the child. |
| 8 | `Record<NodeType, ExecutorFn>` (non-Partial) | Compile error if a new node type has no executor — converts runtime crashes into build failures. |
| 9 | Full-jitter exponential backoff | Desynchronises simultaneous retries, preventing the thundering herd that guaranteed rate-limits repeat. |
| 10 | Dual-write Postgres + Redis pub/sub | Redis pub/sub is fire-and-forget; Postgres replay gives reconnecting clients a gapless ordered history. |
| 11 | Zustand narrow selectors | A status tick on one node must not re-render a 50-node canvas; narrow selectors make re-renders O(1) per update, not O(N). |
| 12 | Testcontainers over mocked DB | Mocks cannot disagree with your mental model; real Postgres and Redis catch bugs in Lua atomicity, row locking, and stalled-job TTLs. |
| 13 | `tsx` in production containers | All other phases already validated `tsx`; introducing a compiled `dist/` path would mean production runs a code path no test ever exercised. |
