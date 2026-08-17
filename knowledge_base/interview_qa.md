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

