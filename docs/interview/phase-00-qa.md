# Phase 0 — Interview Q&A: Monorepo Scaffold and Local Infrastructure

---

## Q1 (Architecture) — Why use a monorepo instead of three separate repositories?

**A:** The forcing function is `graph-core`. The cycle-detection and topological-sort algorithms must run identically in the browser (for instant edge-rejection feedback) and on the API server (for authoritative validation before persisting a version). With separate repos you'd need to publish `graph-core` as an npm package on every change — a round-trip that adds latency to every iteration and introduces version drift risk. A pnpm workspace `workspace:*` dependency resolves directly to the TypeScript source, making the browser and server provably use the same code path. Beyond `graph-core`, a monorepo gives us a single `pnpm -r typecheck` across all seven packages and atomic refactors — changing a shared type requires one PR, not three coordinated ones.

---

## Q2 (Algorithm/Complexity) — What is the time and space complexity of installing dependencies in a pnpm workspace versus npm/Yarn?

**A:** pnpm uses a **content-addressable store** — each package version is stored once on disk in `~/.pnpm-store`, and workspaces are linked via hard links. For N packages sharing the same dep version, pnpm stores it once; npm or Yarn (without PnP) would store it N times. Install time is O(unique packages) rather than O(total references). Space is also O(unique packages). The practical impact: `pnpm install` in our 7-package workspace is significantly faster than npm on a warm store, because ioredis, zod, and TypeScript aren't downloaded multiple times.

---

## Q3 (Design) — Why does `graph-core` have zero runtime dependencies?

**A:** Two reasons — bundle and portability. First, `graph-core` is imported by `apps/web` and bundled by Vite for the browser. Any runtime dep in `graph-core` gets pulled into the browser bundle — a Node.js-only package like `ioredis` would cause Vite to fail or produce a broken bundle. Second, zero deps is a hard portability guarantee: the package can be imported in any JavaScript environment (Node.js, browser, Deno, edge workers) without polyfills or shims. We enforce this by having no `dependencies` key in the package's `package.json` — only `devDependencies` for tooling.

---

## Q4 (Why This Library) — Why pnpm workspaces over Nx or Turborepo?

**A:** Nx and Turborepo add a build graph cache and remote caching on top of the workspace primitives. For our scale — seven packages, a team of one — the overhead of configuring Nx project graphs and task pipelines outweighs the benefit. pnpm workspaces give us `workspace:*` dependencies, `pnpm -r` recursive scripts, and hoisted node_modules natively. We can migrate to Turborepo later if build times become painful; the migration is additive (add `turbo.json`, keep everything else). Starting with pnpm keeps the onboarding overhead near zero.

---

## Q5 (Failure Mode) — What happens if Redis is restarted without `appendonly yes`?

**A:** Without AOF, Redis uses RDB snapshots — a full dataset dump written periodically (default: every 60 seconds if ≥10 keys changed). Between two snapshots, a Redis crash silently discards all writes. For a task queue, those writes are **pending BullMQ jobs**. The run would stall forever: the NodeRuns are in `QUEUED` state in Postgres, but the corresponding jobs no longer exist in Redis. No error is emitted, no retry is triggered, the UI shows the nodes stuck in "QUEUED" indefinitely. `appendonly yes` enables AOF — every write command is appended to a log file and synced to disk. On restart, Redis replays the log and the queue is fully restored. Zero job loss.

---

## Q6 (Design) — Why are environment variables Zod-parsed at boot instead of read ad-hoc via `process.env`?

**A:** `process.env` returns `string | undefined` for every key. Reading it ad-hoc has three failure modes: (1) a missing `DATABASE_URL` causes `undefined` to be passed to the Prisma client, which throws a cryptic error deep in connection setup — not at the point of the `process.env` read; (2) type coercion is manual and error-prone (`API_PORT` is a string but we need a number); (3) there's no validation — a `DATABASE_URL` with a typo in the hostname satisfies `typeof x === 'string'` but fails at first query. Zod-parsing at boot solves all three: the process crashes immediately on startup with a structured error listing exactly which variables are missing or invalid, and all consumers get a fully-typed `Env` object with no undefined fields.

---

## Q7 (TypeScript) — What does `"noUncheckedIndexedAccess": true` do and why does it matter here?

**A:** With this flag, any array or object index access returns `T | undefined` instead of `T`. Example: `const node = nodes[0]` has type `NodeDef | undefined` even if `nodes` is typed as `NodeDef[]`. Without it, `nodes[0].key` would typecheck even on an empty array, causing a runtime `TypeError`. For `graph-core` — where we traverse adjacency maps and pop from queues — this flag catches "I forgot to handle the empty case" bugs at compile time. It's stricter than standard strict mode and is a deliberate choice to catch index-out-of-bounds mistakes that would otherwise only appear at runtime.

---

## Q8 (Infrastructure) — Why are Postgres and Redis in Docker Compose rather than started as local processes?

**A:** Local process installation (Homebrew Postgres, Windows Postgres installer) leads to version skew across developers and CI — someone on Postgres 14 may not reproduce a bug that only appears on Postgres 16. Docker Compose pins the exact version (`postgres:16`, `redis:7-alpine`) and is one command on any machine with Docker installed. Named volumes persist data across restarts. Health checks (`pg_isready`, `redis-cli ping`) allow dependent services (API, workers) to wait for readiness with `depends_on: { condition: service_healthy }` — no `sleep 5` hacks.

---

## Q9 (Design) — The `vite.config.ts` has path aliases for `@dag/graph-core` and `@dag/contracts`. Why are these needed separately from `tsconfig.json`?

**A:** TypeScript path aliases (`paths` in `tsconfig.json`) are resolved by `tsc` and IDEs for type-checking and editor navigation. But Vite has its own module resolution that doesn't read `tsconfig.json` paths — it uses its own resolver. Without the `resolve.alias` entries in `vite.config.ts`, Vite would look for `@dag/graph-core` in `node_modules` and fail (it's a workspace package, not a published package). The aliases in both files must be kept in sync — they map the same logical names to the same physical paths. This is a known pnpm + Vite workspace friction point; some teams use a plugin (`vite-tsconfig-paths`) to auto-read tsconfig paths.

---

## Q10 (Failure Mode) — What is the failure mode if a worker process starts with a missing `REDIS_URL` env var?

**A:** Without Zod env validation: the worker imports `ioredis`, constructs a `Redis` client with `undefined` as the URL, which ioredis interprets as the default `localhost:6379`. On a production server where Redis is on a different host, the worker silently connects to nothing (or to an unrelated Redis instance), dequeues no jobs, and logs no error — it appears to be running but does no work. With Zod env validation: the process exits at startup with `❌ Invalid environment variables — Worker cannot start: { REDIS_URL: ['REDIS_URL must be a valid Redis connection string'] }`. The failure is loud, immediate, and attributable to the exact misconfiguration.

---

## Q11 (Why This Library) — Why TypeScript strict mode, and what specifically does it catch that the default config misses?

**A:** `"strict": true` enables a bundle of checks: `strictNullChecks` (no implicit `any` from null/undefined), `strictFunctionTypes` (covariance/contravariance checking on function parameters), `noImplicitAny`, `strictBindCallApply`, and others. Without `strictNullChecks`, TypeScript would allow `const x: string = maybeUndefined` without error — the most common source of runtime TypeErrors in JavaScript codebases. For a distributed system where a `NodeRun.output` might be `null`, strict null checks force every consumer to handle the null case explicitly. We add `noUncheckedIndexedAccess` on top, which strict mode doesn't include, to catch array index issues in the graph traversal code.

---

## Q12 (Design) — How does the `tsconfig.base.json` extension pattern work across packages, and why is the `web` package's tsconfig different?

**A:** Each package's `tsconfig.json` has `"extends": "../../tsconfig.base.json"`, inheriting `strict`, `noUncheckedIndexedAccess`, `target: ES2022`, and `module: CommonJS`. The `web` package overrides these because Vite expects `"module": "ESNext"` and `"moduleResolution": "Bundler"` — Vite handles module resolution itself, not `tsc`. Using `CommonJS` in the web tsconfig would cause Vite to mishandle dynamic imports and tree-shaking. Setting `"noEmit": true` on the web package prevents `tsc` from producing JS output — that's Vite's job. The api and worker packages use `CommonJS` because Node.js 20 supports both ESM and CJS, but CJS avoids the `.js` extension requirement in ESM imports (a friction point with TypeScript's `NodeNext` module resolution).
