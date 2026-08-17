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

