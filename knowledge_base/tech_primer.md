# Tech Primer: DAG Engine Technologies

Welcome to the DAG Engine! This document explains the core technologies we've introduced so far in simple, beginner-friendly terms.

---

## Phase 0 Technologies

### 1. What is a Monorepo? (pnpm workspaces)
Normally, if you have a frontend app, a backend app, and a shared library, you would put them in three separate Git repositories. A **monorepo** puts them all in one repository. 

We use `pnpm workspaces` to manage this. It allows our `web` app and our `api` app to both easily import our shared `graph-core` package without having to publish it to the internet (npm) first. They just link to each other locally. This means if you change a shared type or algorithm, you immediately know if you broke the frontend or backend.

### 2. What is Redis?
Redis is an extremely fast database that keeps all its data in memory (RAM). We use it primarily as a **Message Broker** and a **Task Queue**. 
Imagine it like a post office: when our API wants a Python script to run, it writes a message to Redis. The worker processes are constantly asking Redis, "Do you have any work for me?" Redis hands them the job. 

### 3. What is Redis AOF (Append-Only File)?
Since Redis keeps data in RAM, if the computer crashes, you lose everything. Redis normally takes "snapshots" (saving to the hard drive every 60 seconds). But if it crashes at second 59, you lose 59 seconds of jobs. 
**AOF (Append-Only File)** fixes this. Every time we add a job, Redis writes that exact command to a log file on the hard drive. If it crashes, it just replays the log file when it starts back up. We use this so we *never* lose a user's workflow job if a server goes down.

### 4. What is Zod?
Zod is a TypeScript validation library. It helps us ensure that data looks exactly the way we expect it to. 
For example, when our app starts, it needs certain environment variables (like `DATABASE_URL`). Instead of just hoping they are there, we use Zod to check them the millisecond the app turns on. If `DATABASE_URL` is missing or isn't a valid URL, Zod catches it and safely crashes the app with a helpful error message, preventing weird bugs later on.

---

## Phase 1 Technologies

### 5. What is a Zod "Discriminated Union"?
In our system, a workflow node can be one of five types: `kaggle.download`, `pandas.preprocess`, `torch.train`, `model.evaluate`, or `registry.deploy`. Each type needs different settings. For example, a `kaggle.download` node needs a `datasetSlug`, while a `torch.train` node needs an `epochs` count.

A **discriminated union** lets us say: "Look at the `type` field. If it says `torch.train`, then the `config` object MUST have an `epochs` field. If it says `kaggle.download`, then `config` MUST have a `datasetSlug`." TypeScript then automatically understands which fields are available based on the `type` — no manual type casting needed.

### 6. What is `z.infer<>` and why does it matter?
Normally in TypeScript, you'd write a `type` or `interface` to describe the shape of your data, AND THEN write a separate validator to check that incoming data matches that shape. This creates two places to update whenever you add a field.

`z.infer<typeof MySchema>` automatically generates the TypeScript type from the Zod schema. There is only one place to define the shape: the Zod schema. The TypeScript type is automatically derived from it. This is the "single source of truth" principle.

### 7. What is `.superRefine()` in Zod?
Most Zod validations check individual fields (e.g., "is this a valid URL?"). But some rules need to look at the whole object at once. For our graph, we need to check that:
- No two nodes have the same `key`
- Every edge's `from` and `to` refers to a real node

These checks need to see all nodes AND all edges at the same time. `.superRefine()` gives us that power — it runs a custom function on the entire parsed object, letting us add any errors we find to Zod's issue list with precise path information (e.g., "the problem is at `edges[2].to`").

---

## Phase 2 Technologies

### 8. What is Kahn's Algorithm?
Imagine you are cooking dinner: you can't chop the onions until you peel them, and you can't cook them until they are chopped. Kahn's Algorithm sorts these tasks so you always do the prerequisites first.
It works by finding tasks that have **zero prerequisites** (in-degree of 0). It puts those tasks in the "do this now" bucket, then effectively removes them from the list, checking if any other tasks now have zero prerequisites.
We use it to group our graph into "tiers". If two nodes are in the same tier, it means neither depends on the other, so we can run them at the exact same time (concurrently).

### 9. What is a 3-Color DFS?
DFS (Depth-First Search) is a way to explore a graph by going as deep as possible before backtracking. We use it to detect **cycles** (e.g., A depends on B, B depends on A).
We color the nodes as we go:
- **WHITE**: Unvisited.
- **GRAY**: We are currently visiting this node or its children. It's on our "active" path.
- **BLACK**: We have fully explored this node and all its children. It's safe.
If we ever try to visit a node that is currently **GRAY**, we know we've looped back onto our active path — meaning we found a cycle!

### 10. Iterative vs. Recursive Algorithms
A **recursive** function is one that calls itself. It's very easy to write DFS recursively. However, every time a function calls itself, it takes up a slot on the computer's "call stack." If the graph is 10,000 nodes deep, the call stack gets too large and crashes the program.
An **iterative** function uses a simple `while` loop and stores its state in an array (a manual stack) instead of relying on the computer's call stack. This is slightly harder to write but is infinitely safer for large data.

---

## Phase 3 Technologies

### 11. What is Prisma ORM?

An **ORM** (Object-Relational Mapper) is a tool that lets you interact with a database using your programming language instead of raw SQL. Prisma is the ORM we use for PostgreSQL.

You write a `schema.prisma` file describing your tables (called **models**) and Prisma does two things:
1. **Generates a type-safe TypeScript client** — so instead of writing `SELECT * FROM "NodeRun" WHERE id = $1`, you write `prisma.nodeRun.findUnique({ where: { id } })` and TypeScript knows exactly what fields the result has.
2. **Manages database migrations** — when you change the schema, Prisma generates a SQL migration file that you commit to git and apply to every environment.

**`prisma generate` vs `prisma migrate dev`:**
- `prisma generate` — reads your schema and regenerates the TypeScript client. Run this after any schema change so your code matches the new schema.
- `prisma migrate dev` — generates a new SQL migration file AND applies it to your local database. Use this during development when you want to actually change the database structure.

### 12. What is the Singleton Client Pattern?

Our `client.ts` creates exactly one `PrismaClient` instance for the whole Node.js process:

```ts
export const prisma = new PrismaClient();
```

Why only one? `PrismaClient` manages a connection pool to PostgreSQL. Creating multiple instances wastes connections and can exhaust the database's connection limit. By exporting a single shared instance, every repository function shares the same pool.

### 13. What is a "Conditional Update" (Optimistic Concurrency)?

Imagine two workers both finish processing a node at the exact same millisecond. Both read the database and see the node's status is `RUNNING`. Both then try to write `SUCCEEDED`. If they do a regular update (`SET status = 'SUCCEEDED'`), both succeed — and both then try to dispatch the node's children, creating duplicate work.

A **conditional update** adds an extra check to the SQL:

```sql
UPDATE "NodeRun" SET status = 'SUCCEEDED'
WHERE id = $id AND status = 'RUNNING'
```

The database processes this as one atomic operation. Only one worker's update will match the `WHERE status = 'RUNNING'` condition — the other will match 0 rows (because the first worker already changed the status). We check the row count: `count === 0` means "you lost the race, stop here."

In plain English: *"Change the status to SUCCEEDED, but only if it's currently RUNNING."*

---

## Phase 4 Technologies

### 14. What is Express.js?

Express is a minimal web framework for Node.js. It lets you define **routes** — functions that respond when a specific URL and HTTP method is called.

```ts
app.post('/workflows', (req, res) => {
  res.json({ created: true });
});
```

We use Express for the API (control plane) — it receives requests from the browser, validates them, runs business logic, and sends back a response.

### 15. What is the App Factory Pattern?

Instead of writing `app.listen(3001)` at the top level of our app file, we wrap the Express setup inside a function `createApp()`. Only the entry point `index.ts` calls `listen()`.

Why? Because our tests import `createApp()` to get an Express app instance and pass it to Supertest — **without** opening a real network port. If `listen()` were called at import time, every test file would try to start a server on port 3001 and likely crash.

### 16. What is Supertest?

Supertest is a test library that lets you make HTTP requests to an Express app **in-process** — no actual server is started, no network port is used, no latency. You hand it your `app` object and call methods like `.get('/health')` or `.post('/workflows').send({...})`.

It's the standard way to write integration tests for Express APIs.

### 17. What is Pino?

Pino is a structured JSON logger for Node.js. Instead of `console.log('User created')`, you write:

```ts
logger.info({ userId, workflowId }, 'Workflow created');
```

This produces a JSON line: `{"level":30,"userId":"u1","workflowId":"wf1","msg":"Workflow created"}`. In production, log aggregators (Datadog, CloudWatch) can filter, search, and alert on these structured fields. With `console.log`, you'd have to parse strings manually.

We use **child loggers** inside runs: `logger.child({ runId })` creates a logger that automatically includes `runId` in every line it produces — you never forget to include it.

### 18. What is a "Correlation ID"?

When an unexpected error (500) happens in the API, we don't send the full stack trace to the client — that would leak internal details. Instead we generate a random UUID (`correlationId`), log the full error with that ID, and return only the ID to the client.

The user can give the ID to support, who can search the logs for it and find the exact error. The client gets just enough info to report the problem without exposing implementation details.

---

## Phase 5 Technologies

### 19. What is BullMQ?

BullMQ is a robust, production-ready queue system for Node.js built on top of Redis. It handles things you'd otherwise have to build yourself:
- **Retries** when a task fails.
- **Backoff** (waiting before retrying).
- **Concurrency** limits (e.g., only run 1 GPU task at a time).
- **Stalled job recovery** (if a worker crashes while processing a job, BullMQ detects the timeout and puts it back in the queue).

### 20. What is a Lua Script in Redis?

Redis can run small scripts written in the Lua programming language. The massive advantage is **atomicity**: when Redis runs a Lua script, it pauses all other commands until the script finishes. 

If you read a value, change it, and write it back using a Lua script, it's guaranteed that no other worker can jump in and mess up the value in the middle. We use it to safely count down dependencies (in-degree).

### 21. What is Redis Pub/Sub?

Pub/Sub (Publish/Subscribe) is a messaging pattern where senders (publishers) send messages to a "channel" without knowing who is listening. Receivers (subscribers) listen to channels and get messages instantly.

We use it for live UI updates. When a node finishes, the control plane publishes an event to `run:123:events`. Any connected browser looking at run 123 receives it immediately.

### 22. What is "Jitter" in Backoff?

When an API goes down, hundreds of queued jobs might fail at the exact same moment. If they all have a 5-second backoff, they will all wait exactly 5 seconds and hit the API again simultaneously. This is called a "thundering herd" and often takes the API down again.

**Jitter** means adding randomness to the backoff. Instead of exactly 5 seconds, a job might wait `5 seconds + random(0 to 2) seconds`. This spreads out the retries so the API isn't overwhelmed.

---

## Phase 5 (continued)

### 23. What is a Deterministic JobId in BullMQ?

When you `add()` a job to BullMQ, you can optionally pass a `jobId`. If you don't, BullMQ generates a random UUID and stores it in an internal set keyed by id. If you **do** pass a `jobId`, BullMQ first checks if that id already exists in any state (waiting, active, delayed, failed, completed). If it does, the new `add()` call is a no-op — the duplicate is silently dropped.

**Deterministic** means the id is computed from your own business data, not random. In our code (`packages/queue/src/queues.ts:79–81`):

```ts
export const createJobId = (runId: string, nodeKey: string, attempt: number): string =>
  `${runId}:${nodeKey}:${attempt}`;
```

Two consequences:
1. **Network-retry safety.** If the API successfully enqueues a job and then crashes before it can write `NodeRun.status = 'QUEUED'` to Postgres, the next orchestrator pass will re-evaluate and try to enqueue the same job again. With a random id, both jobs would exist; the worker would execute the node twice. With a deterministic id, the second `add()` is silently ignored — at-least-once delivery from the producer becomes exactly-once processing in the queue.
2. **Attempt-aware retries.** Including `attempt` in the id means a retried job (after a transient failure) is a *different* job id from the original. If we had used `${runId}:${nodeKey}` only, the retry's `add()` would collide with the original (already-completed) id and BullMQ would drop it — the retry would never run.

The cost is a string concatenation per dispatch. The benefit is two layers of deduplication (deterministic jobId at the queue layer, `@@unique([runId, nodeKey])` at the DB layer) for free.

---

## Phase 6 Technologies

### 24. What is the Orchestrator loop?

The Orchestrator loop is a state machine driven by events. When a graph node succeeds, the orchestrator:
1. Marks the node as `SUCCEEDED` in the DB.
2. Finds all children of the node in the Graph.
3. Decrements their "unmet dependency" counters in Redis.
4. If a child's counter hits `0`, the orchestrator immediately enqueues it.

Because it runs inside the central API process and consumes `QueueEvents`, workers don't need to know anything about the graph, what comes next, or how to speak to Postgres. They just do the work and exit.

### 25. What is an Idempotency Key?

An idempotency key is a unique token (often a UUID) generated by the client and sent in an API request. The server saves this token. 

If the client's internet drops before it gets the server's response, it will retry the request. The server sees the same idempotency key, realizes it already processed the request, and returns the original result instead of processing it a second time. In the DAG engine, this guarantees `startRun` never creates duplicate runs for the same user interaction.

---

## Phase 8 Technologies

### 26. What is `child_process.spawn`?

Node.js is a single-threaded runtime. If you need to do heavy data crunching (like Pandas) or call another language (like Python), you must run it in a separate process. `spawn` starts a new OS process, executes a command (e.g., `python3 script.py`), and sets up a pipeline (stdio) so the Node.js parent can stream data into the child and read the output back.

### 27. What is an Atomic Write?

When a computer writes a file, it does so in chunks. If the power goes out mid-write, the file is half-written and corrupted. An atomic write solves this:
1. Write the new data to a temporary file (`data.json.tmp`).
2. Ask the OS to rename the temporary file to the final name (`data.json`).
At the OS file-system level, renames are instantaneous and uninterruptible (atomic). You either have the old file, or the new file, but never a corrupted half-file.

### 28. What are process groups and `kill(-pid)`?

When you `spawn` a Python script, it might internally spawn other scripts (like starting a PyTorch data loader). If the timeout triggers and you only kill the main Python script, its children keep running and become "zombies" that eat CPU forever. By killing the *process group* (which in Unix is done by passing a negative PID like `kill(-pid)`), the OS kills the parent and all its children simultaneously.

---

## Phase 9 Technologies

### 29. What is a Thundering Herd?

Imagine 100 servers all send a request to one database at exactly the same moment. The database gets overwhelmed and all 100 requests fail. The servers all wait 5 seconds and try again simultaneously. This repeats forever. The "thundering herd" is when many processes synchronise on the same failure, then retry in lockstep, repeatedly overloading the same resource. The solution is to add randomness (jitter) to the retry delay so the retries spread out over time.

### 30. What is a Semaphore?

A semaphore is a counter that controls access to a shared resource. Imagine a car park with 10 spaces. When a car enters, the counter decrements (9 spaces left). When a car leaves, the counter increments (10 spaces again). When the counter is 0, the barrier blocks the next car. In the DAG engine, we use Redis as the shared counter so all API server processes see the same limit.

### 31. What is a Dead-Letter Queue?

When a job fails its maximum number of retry attempts, it moves to the "dead-letter" set — a holding area for jobs that couldn't be processed. Unlike a normal queue, jobs here are not automatically retried. An engineer can inspect them, fix the underlying problem (e.g., update an API key), and then manually re-enqueue them. In BullMQ, `removeOnFail: false` keeps all failed jobs in the failed set so the error trail is always preserved for forensic analysis.

---

## Phase 10 Technologies

### 32. What is Server-Sent Events (SSE)?

SSE is a web standard that lets the server push data to the browser over a plain HTTP connection that stays open. The server sends a specially formatted text stream, and the browser's `EventSource` API reads each event. Unlike WebSockets, SSE is one-directional (server → browser only), uses a regular HTTP connection (no upgrade handshake), and the browser reconnects automatically if the connection drops.

### 33. What is `Last-Event-ID`?

Every SSE frame can carry an `id:` field. The browser remembers the last ID it received. When the connection drops and `EventSource` reconnects, it adds the header `Last-Event-ID: {lastId}` to the request. The server uses this ID to replay only the events the client hasn't seen yet — no duplicates, no gaps.

### 34. What is Redis Pub/Sub subscriber mode?

When you call `SUBSCRIBE` on a Redis connection, the connection enters "subscriber mode". In this mode, the only commands it can receive are `SUBSCRIBE`, `UNSUBSCRIBE`, and `PSUBSCRIBE`. It can no longer issue `GET`, `SET`, `PUBLISH`, or any other general command. This is why the DAG engine creates a brand new, dedicated Redis connection for each SSE client rather than reusing the shared connection.

### 35. What is chunked transfer encoding?

Normally, HTTP responses have a `Content-Length` header so the browser knows how much data to expect. For SSE, the response never ends — data keeps coming. The server uses `Transfer-Encoding: chunked` instead, which lets it send data in pieces ("chunks") without knowing the total size in advance. Each SSE event is one chunk. The browser reads chunks as they arrive and fires `EventSource` callbacks in real time.

---

## Phase 11 Technologies

### 36. What is Zustand?

Zustand is a small, fast state-management library for React. Unlike Redux, it doesn't require boilerplate like actions or reducers. Unlike React Context, it provides precise selector subscriptions. We use it to hold the frontend DAG engine state (nodes, edges, node execution statuses).

### 37. What is Selector Granularity?

When a component subscribes to a store via a selector function (e.g. `useStore(state => state.activeRunId)`), the component only re-renders when the exact value returned by the selector changes. This is crucial for performance. In our visual editor, when an SSE event updates the status of Node A, only Node A re-renders because it selects its own status (`state => state.nodeStatuses['node-A']`). Node B, Node C, and the rest of the canvas do not re-render. If we used React Context for this, the entire canvas would re-render on every SSE tick.

### 38. What is React Flow?

React Flow is a library for building node-based applications and diagrams. It provides the canvas, zooming/panning, and the mechanics for dragging nodes and connecting edges. We provide it with custom React components for our specific DAG nodes (`CustomNode`) which display the node type icon and live execution status.

---

## Phase 12 Technologies

### 39. What is Testcontainers?

Testcontainers is a library that lets your tests start real Docker containers — a real Postgres, a real Redis — instead of a mock or a fake in-memory substitute. Your test code says "give me a Postgres 16," Testcontainers pulls the image if needed, starts a container, and hands your test the exact host/port it's listening on. When the test run finishes, the container is thrown away.

Why bother, when a mock is faster? Because some bugs only exist in the real thing. A mocked Redis will happily let you write "atomic" Lua-script logic that's actually broken, because the mock doesn't run Lua at all — it just returns whatever you told it to return. A real Redis will tell you the truth. Testcontainers is how you get a real Redis (and a real Postgres) into a test without a human having to remember to `docker compose up` first, and without every developer's laptop needing the exact same database already running with the exact same empty state.

### 40. What is a "globalSetup" file in a test runner?

Most test frameworks let you define per-test setup (`beforeEach`) and per-file setup (`beforeAll`). A **global setup** runs *once*, before any test file is even loaded, and its own separate teardown function runs once at the very end, after every test file has finished. It's the right place to do something expensive and shared — like starting a Testcontainers database — that every test file needs but that would be wasteful to redo per file.

### 41. Why can't you just set `process.env.DATABASE_URL` in a test and have the database library pick it up?

Because of **import hoisting**. In JavaScript/TypeScript, every `import` statement at the top of a file is hoisted — meaning it's guaranteed to run *before* any other code in that file, including a `beforeAll()` block further down. If a database library reads `process.env.DATABASE_URL` the moment it's imported (to build its connection), and your test only sets that env var inside `beforeAll()`, you've set it too late — the import already ran with the old (or missing) value.

The fix used in this project: read the connection details from a small file on disk *first*, set `process.env` from that, and only *then* use a **dynamic import** — `await import('@dag/db')` instead of `import { db } from '@dag/db'` at the top of the file. A dynamic import is a regular function call: it runs exactly where you write it, in order, not hoisted to the top. That guarantees the environment variable is already correct by the time the module (and its database connection) is created.

### 42. What is a "worker thread" versus a "child process" (fork)?

Both let you run code in parallel to your main program, but they isolate differently. A **worker thread** runs inside the *same* operating-system process — it shares that process's memory space at a low level, and starting one is cheap. A **forked child process** is a genuinely separate operating-system process with its own memory — more expensive to start, but fully isolated: if one crashes, or if some native (non-JavaScript) code inside it misbehaves, it cannot corrupt the other process's memory.

This project's test runner (Vitest) defaults to worker threads for speed. But the integration tests open real database and Redis network connections, and this project hit a real, repeatable crash that traced back to a connection's callback firing after its worker thread had already been torn down and recreated for the next test file. Switching to `pool: 'forks'` — real, separate processes — fixed it, at the cost of a slightly slower test startup.

### 43. What is a race condition, and why is "just run it twice and see" not a real test for one?

A race condition is a bug that only happens when two things run at almost exactly the same moment, in a specific order that isn't guaranteed. The classic example here: two workers both finish a task at the same millisecond, both check "is my sibling task also done yet?", both see "no," and both wrongly conclude they're responsible for starting the next step — so it starts twice.

You *could* write a test that just fires two real workers and hopes they happen to collide at the right moment. Sometimes it would catch the bug; usually it wouldn't, because computers are fast and the "bad window" is often a fraction of a millisecond — the test would pass 99 times out of 100 even with the bug still present, which is worse than no test at all (it creates false confidence). The reliable technique is to **force** the two things to overlap on purpose: call both operations inside the test with no `await` between the two calls (e.g. `Promise.all([opA(), opB()])`), so the code genuinely starts both before either finishes, every single time you run the test — not most of the time, every time.

### 44. What is Prometheus / a "metrics" endpoint?

Prometheus is a widely-used monitoring system. It works by periodically visiting a URL your application exposes (conventionally `/metrics`) and reading a very simple plain-text format: a metric name, optional labels in curly braces, and a number. For example: `dag_queue_depth{queue="cpu",state="waiting"} 42`. Prometheus stores that number with a timestamp every time it "scrapes" your app, building up a time series it can graph, alert on, or query later ("show me queue depth over the last hour").

`prom-client` is the Node.js library that formats your application's numbers into that exact text format so any Prometheus-compatible tool can read them without any custom glue code.

### 45. What is the difference between a Gauge, a Counter, and a Histogram?

Three of Prometheus's basic metric types, each shaped for a different kind of number:
- A **Gauge** goes up and down — it represents a value *right now* (how many jobs are currently waiting in the queue, how many workers are currently connected). You can set it directly to whatever the true value is.
- A **Counter** only ever goes up (until the process restarts) — total requests served, total errors. You increment it; you never set it back down.
- A **Histogram** buckets a stream of individual measurements (like "this task took 240ms," "that one took 1.8s") into ranges, so you can later ask "what fraction of tasks finished in under 1 second?" or compute percentiles like p95 (the value below which 95% of measurements fell).

This project uses Gauges for "how many nodes are in each status right now" (recomputed fresh from the database every time Prometheus asks) and a Histogram for "how long did each node take to run" (recorded the instant each node finishes, since there's no way to reconstruct that number later from just the database's current state).

### 46. What is p50 / p95 / p99 latency?

These are percentiles of a set of measured durations. If you sort every node's execution time from fastest to slowest, **p50** (the median) is the value in the middle — half of everything finished faster, half slower. **p95** is the value at the 95th-percentile mark — 95% of executions finished at or below this time; the remaining 5% (the "tail") took longer. **p99** is the same idea at the 99th percentile — an even smaller, slower tail.

Why bother with p95/p99 instead of just the average? An average can hide a bad tail: if 190 requests take 100ms and 10 take 10 seconds, the average looks fine (~600ms) but 5% of your users are having a terrible experience. p95/p99 surface exactly that tail, which is usually what "the system feels slow sometimes" is actually about.

### 47. What is `taskkill /T` (and why does killing a process sometimes not actually kill it)?

When one program starts another — a "parent" starting a "child" process — the operating system tracks that relationship. On Windows, if you spawn a program *through a shell* (like `cmd.exe`), the process handle you get back refers to that shell, not to whatever program the shell went on to run. Asking the shell to stop doesn't necessarily stop the program it launched — the shell can exit on its own, leaving its child running with nobody watching it anymore. This is called an **orphaned process**: still alive, still using resources (like a database connection), but invisible to whatever spawned it if you only kept a handle to the immediate shell.

`taskkill /PID <id> /T /F` tells Windows: find this process ID, find every process Windows recorded as a *descendant* of it (the `/T` flag, for "tree"), and force-kill (`/F`) all of them. Because Windows records that parent-child relationship at the moment a process is created — independent of whether the parent is still alive — this reliably reaches an orphaned grandchild process even after the immediate shell in between has already exited.
