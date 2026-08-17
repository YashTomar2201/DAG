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

