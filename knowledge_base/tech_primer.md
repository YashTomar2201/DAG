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

---

## Phase 13 Technologies

### 48. What is a Docker image, and what is a "multi-stage build"?

A Docker **image** is a snapshot of a filesystem plus some metadata (what command to run, what port it expects, etc.) — think of it as a portable, self-contained box that has everything a program needs to run: the OS files, the language runtime, the app's own code, its dependencies. A **container** is just a running instance of an image.

Building an image the naive way — install your build tools, compile your code, done — leaves all those build tools sitting in the final image even though nothing needs them once the app is built, making the image bigger than it needs to be. A **multi-stage build** solves this by describing several images in one `Dockerfile`, each one a "stage." Early stages can have compilers, package managers, everything needed to prepare the code. The *final* stage starts fresh from a clean, minimal base and copies over only the finished result from the earlier stages — the compiler itself never makes it into what actually ships.

### 49. What is `pnpm fetch`, and why is it a separate step from `pnpm install`?

`pnpm fetch` downloads every package a project's lockfile says it needs into pnpm's local cache — but it does *not* need your actual source code to do that, only the lockfile. `pnpm install --offline` afterward links those already-downloaded packages into `node_modules`, using only what's already in the cache (no network needed).

Splitting it this way matters for Docker's caching. Docker re-runs a build starting from the *first* step that changed since the last build; everything before that point is reused instantly from cache. If you copy your lockfile and run `pnpm fetch` (which only depends on the lockfile) *before* copying your actual source code, then editing a source file doesn't invalidate the expensive "download every package from the internet" step — Docker sees the lockfile is unchanged and reuses that cached layer, only re-running the fast steps that come after.

### 50. What does `pnpm prune --prod` do, and why is it different from just running `pnpm install --prod`?

Every `package.json` can list two kinds of dependencies: `dependencies` (needed to actually run the program) and `devDependencies` (needed only while building/testing it — a test framework, a linter, a compiler). `pnpm install --prod` installs only the first kind, from scratch.

`pnpm prune --prod` does something related but different: it takes a `node_modules` folder that's *already fully installed* (both kinds) and deletes the devDependency packages out of it, in place. The end result — a `node_modules` with only production packages — is the same, but there's only ever been one `pnpm install` in the whole build. This matters in a multi-stage Docker build: you install everything once (because you need the devDependencies to run a build/codegen step), then prune afterward for the final slim image, instead of installing twice and hoping both installs agree.

### 51. What is `corepack`, and why does it matter which version of a package manager you're using?

Modern Node.js ships with a tool called `corepack` that can download and run a *specific* version of package managers like `pnpm` or `yarn`, based on a `packageManager` field in your `package.json` (e.g. `"packageManager": "pnpm@11.6.0"`). Without a pin, `corepack enable` grabs whatever the latest version currently is — which can silently be a version with different (and sometimes incompatible) requirements than the one you tested with locally. This project hit exactly that: `corepack enable` alone pulled in a pnpm release that flatly requires a newer Node.js version than the Docker base image had, and the fix was pinning the *exact* version already used everywhere else in the project (`corepack prepare pnpm@11.6.0 --activate`), so the version running in a clean Docker build is guaranteed to be the same one already tested on every developer's machine.

### 52. What is a Docker Compose "healthcheck," and what does `depends_on: { condition: service_healthy }` actually guarantee?

A container can be *running* (the process started) without being *ready* (the process is still booting up, still connecting to its database, still warming up). A **healthcheck** is a command Docker runs periodically inside a container to ask "are you actually ready to do useful work?" — for Postgres, that might be "can I open a connection and query it"; for a web API, "does `GET /health` return 200?"

Plain `depends_on: [postgres]` in Compose only waits for the postgres *container to start* — which can be well before Postgres has actually finished initializing and is ready to accept connections. `depends_on: { postgres: { condition: service_healthy } }` waits for postgres's *healthcheck* to pass first. This is the difference between "the database process began starting a moment ago" and "the database has confirmed it can actually serve queries" — and in a system with a startup race (an API server that tries to query a table the second it boots), that difference is the difference between a flaky failure on a slow machine and a reliable startup every time.

### 53. What is a "one-shot" container, and what does `service_completed_successfully` mean?

Most containers in a cluster are meant to run forever (a web server, a worker) — if one exits, something's usually wrong. A **one-shot container** is the opposite: it's designed to do one job and then exit, on purpose, with a success or failure code. Database migrations are a classic example — you want "apply any pending schema changes" to run exactly once per deployment, not stay running afterward.

`condition: service_completed_successfully` in a Compose `depends_on` block means "don't start this other service until the one-shot container has *finished running and exited with code 0*" — as opposed to `service_started` (just began) or `service_healthy` (a long-running healthcheck is passing). It's the right condition for exactly one kind of dependency: "do this finite task first, then let everything else start."

### 54. What is a named Docker volume, and why do multiple containers sometimes need to share one?

By default, every container has its own private filesystem that disappears when the container is removed. A **named volume** is storage that Docker manages independently of any one container's lifecycle — you can mount the *same* named volume into multiple different containers at once, and all of them see the identical set of files, including files another container just wrote.

This matters whenever two separate processes need to hand a large file to each other without going through the network. In this project, one worker container might clean and save a dataset file that a *different* worker container (running a later step of the same pipeline) needs to read — without a shared volume, the second container's filesystem simply wouldn't have that file, because the first container wrote it into its own private, invisible-to-others storage.

### 55. What does `docker compose up --scale worker=4` actually do, and why doesn't it need any extra configuration in this project?

Normally, one `service:` entry in a `docker-compose.yml` file produces exactly one container. The `--scale <service>=<N>` flag tells Compose to instead start N containers from that *same* service definition — same image, same environment variables, same everything, just multiple copies running in parallel.

For this to work well, the thing being scaled has to be genuinely interchangeable — no copy can assume it's "the only one" or hold private state another copy needs to know about. This project's worker containers qualify: each one just asks a shared queue "do you have any work for me?", does the work, and reports back — it never needs to coordinate with, or even be aware of, any other worker container. That's why scaling from 1 worker to 4 requires editing nothing except the number after `--scale`.

---

## Phase 14 Technologies

### 56. What is an Architecture Decision Record (ADR)?

An **ADR** is a short document that captures one significant technical decision made during a
project. It records: what was decided, what alternatives were considered and rejected, and why
the chosen option was better for *this specific context*. ADRs do not advocate for a decision in
general — they explain why it made sense *here, now, given these constraints*.

In this project, ADRs live conceptually in `knowledge_base/decisions_log.md` (every entry is an
ADR in narrative form) and are referenced by a numbered label (ADR-001 through ADR-009). They
map one-to-one with major structural decisions: why a monorepo, why iterative DFS, why Lua
atomicity, why `tsx` in production containers. Reading the ADRs in order is equivalent to
reading the build history of the system — you understand not just *what* was built but *why*.

Why bother? Two reasons:
1. **Onboarding.** A new engineer asking "why isn't this code using recursive DFS like the
   textbook example?" can find the answer in under a minute instead of needing to track down
   the person who wrote it.
2. **Change management.** Before reversing a decision, engineers check the ADR for the original
   reasoning. If the constraint that drove the decision no longer applies, reverting is justified.
   If it still applies, reverting is probably wrong.

---

### 57. What is a "Known Limitations" document, and why write one?

A known-limitations document is an explicit, honest list of what a system *cannot* do, paired
with an explanation of what closing each gap would require.

Writing it serves three purposes:

**1. Interview credibility.** Any sufficiently detailed system has gaps. An interviewer asking
"what would you improve?" after a demo is checking whether you've thought critically about your
own work. "Nothing, it's complete" is the worst possible answer. A prepared list of real gaps —
with real remediation plans — shows engineering maturity.

**2. Scope definition.** A limitations document is the honest complement to a README. The README
says "here's what this does"; the limitations file says "here's what it doesn't do and why that
choice was made." Together they fully define the scope of the project.

**3. Future-proofing.** When a future engineer considers extending the system — adding
multi-tenancy, or scheduled triggers — the limitations file tells them whether that extension
was deliberately deferred or simply never considered. This prevents both "we already thought
about this and decided not to" conversations and "nobody knew this was a problem" surprises.

---

### 58. What is a "system design walkthrough," and how is it different from a list of components?

A **system design walkthrough** is a narrative that follows a single real action through an
entire system from start to finish — a request lifecycle, not a component inventory. It answers
the question "how does this thing actually work?" rather than "what pieces does this system have?"

The difference matters in an interview. Listing components ("we have a Redis queue, a Postgres
database, and some workers") is easy to produce from reading a README and proves nothing about
understanding. A request lifecycle narrative — "when the user clicks Run, here's exactly what
happens at each step and why" — requires you to hold the full dataflow in your head and show how
each decision connects to the next.

A good walkthrough has two properties:
- **It is interruptible.** The interviewer can stop you at any sentence ("wait, why a Lua script
  there?") and you can answer completely without losing your place, then continue.
- **It explains decisions, not just facts.** Not "the API writes to Postgres" but "the API writes
  to Postgres *and* publishes to Redis pub/sub, because pub/sub is fire-and-forget and we need a
  durable source for SSE reconnection."

---

### 59. What does "p95 latency got worse with more workers" actually mean? Is that a bug?

In this project's scale test, adding 3 more workers (from 1 to 4) improved throughput by only
1.12x but made p95 latency *worse* (908ms → 4097ms). This sounds counterintuitive — more
workers should be faster, right?

Here's what actually happened: all four workers shared the same 12-core machine. Worker
concurrency was 8 per worker, so 4 workers = 32 concurrent `python3` processes competing for 12
CPU cores. When more processes are running than there are cores to run them, the OS constantly
switches between them (context-switching). Each process gets less CPU time per unit of wall-clock
time, so jobs take longer even though more of them are nominally "in progress." This is CPU
contention, not a flaw in the dispatch architecture.

**p95** (the 95th-percentile latency) is especially sensitive to this because it measures the
*tail* — the slowest 5% of jobs. Those jobs were already slower to begin with (perhaps they got
unlucky with core scheduling), and CPU contention made them even slower. The average (p50) would
tell a more optimistic story; p95 tells the honest one.

**Is it a bug?** No. The four-layer dispatch machinery (Lua atomicity, SADD guard, deterministic
jobId, DB unique constraint) behaved identically in both passes — zero duplicate executions, zero
correctness errors. The bottleneck is the deployment environment (4 workers on 1 machine), not
the software. Four workers on four *separate* machines would have four independent CPU budgets
and would show close to linear throughput scaling.
