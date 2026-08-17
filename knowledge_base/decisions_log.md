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
