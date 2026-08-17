# ADR-001: Monorepo and Local Infrastructure

- **Status:** Accepted
- **Date:** 2026-08-18
- **Phase:** 0 — Monorepo scaffold and local infrastructure

---

## Context

The DAG Engine is composed of three runtime processes (`api`, `worker`, `web`) that share business logic:

1. **Graph validation** (`detectCycle`, `topologicalSort`) must run identically in the browser *and* on the API server. If the implementations diverge, a user could draw a cycle in the editor that the server accepts, or vice versa — producing a confusing split-brain experience.
2. **Wire schemas** (Zod schemas for `NodeDef`, `EdgeDef`, job payloads, run events) must be shared — duplicating them leads to type drift where the API emits a field the client doesn't know exists, or the client sends a shape the server rejects.
3. The team needs a single `pnpm install` and a single `pnpm -r typecheck` to verify the whole system — not three separate repos with three CI pipelines and mismatched dep versions.

The central tension: how do you share TypeScript code between a Node.js process and a browser bundle without coupling them at the process level?

---

## Decision

Use a **pnpm workspace monorepo** with two application packages (`apps/api`, `apps/worker`, `apps/web`) and three shared library packages (`packages/graph-core`, `packages/contracts`, `packages/db`).

### Why pnpm workspaces over three separate repos?

| Requirement | Separate repos | pnpm workspace |
|---|---|---|
| Share `graph-core` between browser + API | Needs a published npm package or git submodule | Plain `workspace:*` dependency — direct source reference |
| Guarantee identical validation | Manual sync of two copies | One source file, imported by both |
| Single typecheck command | Three CI pipelines | `pnpm -r typecheck` |
| Atomic refactors across layers | Multi-repo PRs, coordination overhead | One commit, one PR |

The killer argument: `graph-core` must be imported by **both** `apps/web` (in the browser, bundled by Vite) and `apps/api` (in Node.js). A separate repo would require publishing it to npm on every change, adding a round-trip latency to every iteration. A workspace `workspace:*` dependency resolves directly to the TypeScript source — no build step, no publish step, no version drift.

### Why `graph-core` has zero runtime dependencies

`packages/graph-core` exports pure functions over plain JavaScript objects. It has **no `dependencies`** — only `devDependencies` for tooling.

Rationale:
- **Browser bundle size:** every runtime dep in `graph-core` is pulled into the Vite bundle. A `lodash` import here would inflate every user's page load.
- **Universal import guarantee:** if `graph-core` imported `ioredis` (a Node.js package), Vite would fail to bundle it for the browser. The zero-dep rule makes the package unconditionally importable in any JavaScript environment.
- **Testability:** pure functions with no side effects can be tested with `vitest` in a bare Node.js environment — no mocking, no containers.

Enforcement: the package's `package.json` has no `dependencies` key — only `devDependencies`. Any PR that adds a runtime dep will be caught in code review (and will blow up the browser bundle if merged).

### Why Redis is configured with `appendonly yes`

Redis's default persistence mode (`RDB snapshots`) writes a full dataset snapshot periodically. Between two snapshots, if Redis crashes, all data written since the last snapshot is lost.

For a task queue, "data" means **pending jobs**. A restart between snapshots would silently drop all queued `NodeRun` jobs — the run would stall forever with no error, no retry, no log.

`appendonly yes` enables the **Append-Only File (AOF)** log: every write command is `fsync`ed to disk. On restart, Redis replays the AOF to restore exact state. No job is lost.

Cost: slightly higher write latency and larger disk footprint. Acceptable for a job queue workload where durability is the primary requirement.

Note: we also add `--save 60 1` (RDB snapshot every 60s if ≥1 key changed) as a secondary safety net — on a clean shutdown the final RDB is consistent.

### Why environment variables are Zod-parsed at boot

The naive pattern is `process.env.DATABASE_URL` scattered across the codebase. This has several failure modes:

1. **Silent undefined:** if `DATABASE_URL` is unset, `new PrismaClient()` receives `undefined` and throws a cryptic error 10 layers deep — far from where the env var is read.
2. **Type unsafety:** `process.env` returns `string | undefined` — every consumer must null-check, or TypeScript accepts `undefined` silently (depending on config).
3. **No validation:** a `DATABASE_URL` with a typo passes the `string` check but fails when the first query runs.

Our `env.ts` (one per app) uses `z.object({ ... }).safeParse(process.env)` at module load time:

- If any variable is missing or malformed, the process **exits immediately with a clear error** — never partially starts.
- All consumers import `env.ts` and get a fully-typed `Env` object with no `undefined` fields.
- Coercions (`z.coerce.number()`) handle the fact that `process.env` values are always strings.

This is especially important for worker processes that may be spawned in a container without a `.env` file — they must fail loudly at boot, not silently at the point of the first Redis call.

---

## Alternatives Considered

| Option | Why Rejected |
|---|---|
| Three separate repositories | `graph-core` would need to be published to npm on every change; validation logic would drift between browser and API; no single `typecheck` command |
| Nx or Turborepo | Additional complexity and tooling overhead; pnpm workspaces cover all our needs (shared deps, script orchestration) without a build cache we don't need yet |
| Lerna | Deprecated in favour of pnpm/Nx patterns |
| Redis without AOF | Job loss on crash; acceptable for a cache, unacceptable for a task queue |
| `dotenv` + manual type assertions | Type-unsafe; silent failures; no schema |
| Runtime `process.env` reads | Scattered, hard to audit, undefined-unsafe |

---

## Consequences

**What this buys us:**
- A single `pnpm install` + `pnpm -r typecheck` + `pnpm -r test` covers the entire system.
- `graph-core` is guaranteed identical in browser and server — the UI's cycle-rejection and the server's cycle-rejection are provably the same code path.
- Worker and API processes crash loudly on misconfiguration rather than failing silently at runtime.
- Redis queue state survives container restarts — no lost jobs.

**What it costs us:**
- All packages share the same node_modules hoisting strategy — a dep version conflict between packages requires resolution (rare with pnpm's strict isolation).
- AOF adds a small write overhead compared to RDB-only mode.

**What breaks if load increases 100×:**
- The monorepo structure is unaffected by load — it's a development-time concern.
- Redis AOF replication lag could become a concern at very high throughput; at that point, consider Redis Sentinel or Cluster with AOF on replicas.

---

## Interview Framing

> "We use a pnpm workspace monorepo because `graph-core` — the cycle detection and topological sort — has to run in the browser *and* on the API server. If those were separate repos, we'd need to publish `graph-core` to npm on every iteration, and we'd risk the two environments drifting. With a workspace `workspace:*` dependency, both import the same TypeScript source. Redis runs with `appendonly yes` because the default RDB snapshotting would lose all queued jobs between snapshot intervals — for a task queue, durability is non-negotiable. And environment variables are Zod-parsed at boot so a misconfigured container exits immediately with a clear error, rather than failing 10 calls deep when the first database query runs."
