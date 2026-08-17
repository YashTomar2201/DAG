# DAG Engine — System Architecture

## Overview

The DAG Engine is a distributed, visual workflow execution system. Users build directed acyclic graph (DAG) pipelines in a drag-and-drop editor; the system validates, schedules, and executes them reliably at scale.

---

## Repository Layout (Monorepo)

```
dag-engine/
├─ apps/
│  ├─ web/       React 18 + Vite + React Flow + Zustand — the visual editor
│  ├─ api/       Express control plane — orchestration, validation, REST API
│  └─ worker/    BullMQ consumers — data plane, executes actual task logic
├─ packages/
│  ├─ graph-core/  Pure graph algorithms (ZERO runtime deps) — shared by web + api
│  ├─ contracts/   Zod schemas — single source of truth for all wire formats
│  └─ db/          Prisma ORM + repository helpers
├─ infra/          docker-compose.yml (Postgres + Redis)
├─ python/         ML executor scripts (preprocess.py, train.py, evaluate.py)
└─ docs/           ADRs, deep-dives, interview Q&A
```

---

## Three-Layer Architecture

```
React Flow Canvas
      │  POST /workflows/:id/runs
      ▼
┌──────────────────┐   enqueue   ┌─────────┐   consume   ┌────────────┐
│  Control Plane   │────────────▶│  Redis  │◀───────────▶│  Worker ×N │
│  (Express + PG)  │             │ BullMQ  │             │  (exec)    │
└──────────────────┘◀────────────└─────────┘─────────────└────────────┘
       │  completion event → decrement in-degree → enqueue unlocked children
       ▼
  PostgreSQL (Run, NodeRun, RunEvent)  ──SSE──▶  browser live status
```

### Layer 1 — Control Plane (`apps/api`)
- Receives graph JSON from the frontend
- Runs cycle detection (DFS) and topological sort (Kahn's)
- Persists graph versions as immutable snapshots
- Dispatches ready nodes to Redis; reacts to completions; unlocks children
- **Never executes user task logic**

### Layer 2 — Message Broker (Redis + BullMQ)
- Durable job queues: `queue:io`, `queue:cpu`, `queue:gpu`
- Atomic in-degree counters (Lua scripts) to prevent double-dispatch
- Pub/sub channel `run:{runId}:events` for live browser updates

### Layer 3 — Data Plane (`apps/worker`)
- N independent worker processes consuming from Redis
- Executes tasks (Python scripts via child_process.spawn)
- Reports terminal status; control plane reacts and unlocks children

---

## Key Design Decisions (Phase 0)

### Why a pnpm workspace monorepo?
`graph-core` must be imported by **both** `apps/web` (browser, bundled by Vite) and `apps/api` (Node.js). A workspace `workspace:*` dependency resolves directly to the TypeScript source — no publish step, no version drift.

### Why `graph-core` has zero runtime dependencies
Any runtime dep in `graph-core` would be pulled into the browser bundle. A Node.js-only package (like `ioredis`) would cause Vite to fail. Zero deps = unconditional importability in any JS environment.

### Why Redis uses `appendonly yes`
Default RDB snapshots lose all writes between snapshot intervals. For a job queue, this means lost `NodeRun` jobs on Redis restart — runs stall silently. AOF persists every write to disk; Redis replays it on restart. No job loss.

### Why env vars are Zod-parsed at boot
`process.env` is `string | undefined`. Ad-hoc reads cause silent failures deep in connection setup. Zod parsing at boot crashes loudly with a structured error listing exactly which variables are missing.

---

## Wire Contracts (`packages/contracts`) — Phase 1

All wire formats are Zod schemas; types are inferred with `z.infer<>`. Nothing is hand-typed.

| Schema | What it describes |
|--------|-------------------|
| `NodeDefSchema` | Discriminated union on `type` — each node type has its own typed `config` |
| `EdgeDefSchema` | A directed edge between two node keys (`from`, `to`) |
| `GraphSchema` | `{ nodes, edges }` with 4 structural refinements via `.superRefine()` |
| `NodeStatusSchema` | 7-value enum: PENDING→QUEUED→RUNNING→SUCCEEDED/FAILED/SKIPPED/CANCELLED |
| `RunStatusSchema` | 5-value enum for the overall run |
| `JobPayloadSchema` | BullMQ queue message: runId, nodeKey, nodeRunId, type, config, input, attempt |
| `RunEventSchema` | SSE + pub/sub envelope: runId, nodeKey?, type, payload, ts |
| `ErrorTaxonomySchema` | retryable vs. unrecoverable error classification |

**Structural Rules Enforced in `GraphSchema`:**
- ✅ Node keys unique within the graph
- ✅ Every edge endpoint refers to an existing node (no dangling edges)
- ✅ No self-loops (from ≠ to)
- ✅ No duplicate edges
- ✅ Node count ≤ 200
- ❌ Cycle detection — deferred to Phase 2 (`detectCycle`); requires graph traversal, not schema validation

---

## Graph Algorithms (`packages/graph-core`) — Phase 2

This package has **zero runtime dependencies** and exports pure functions for graph traversal. It operates purely on the `Graph` contract.

| Algorithm | Function | Purpose |
|-----------|----------|---------|
| **Adjacency Builder** | `buildAdjacencyMap(graph)` | Single-pass helper that returns `adj: Map<node, children[]>` and `inDegree: Map<node, count>`. |
| **Cycle Detection** | `detectCycle(graph)` | Iterative 3-state (WHITE/GRAY/BLACK) DFS. Returns `{ hasCycle: boolean, path?: string[] }`. |
| **Topological Sort** | `topologicalSort(graph)` | Kahn's algorithm. Returns `{ order, tiers }`. Evaluates nodes with 0 in-degree, grouping them into concurrent tiers. |

**Key Properties:**
- `detectCycle` uses an explicit stack (`[nodeKey, childIndex][]`) to prevent call stack overflows on extremely deep linear graphs.
- `topologicalSort` groups nodes into `tiers` — arrays of nodes that have no interdependencies and can be safely dispatched to BullMQ simultaneously.


## Phase Status

| Phase | Status | Summary |
|-------|--------|--------|
| 0 — Monorepo scaffold | ✅ Complete | pnpm workspace, tsconfig, ESLint, Docker, Zod env |
| 1 — Wire contracts | ✅ Complete | Zod schemas for all wire formats, 18 tests passing |
| 2 — Graph algorithms | ✅ Complete | Iterative DFS cycle detection, Kahn's topological sort, 0 runtime deps |
| 3 — Persistence layer | ⏳ Pending | Prisma schema, repositories |
| 4 — Control plane API | ⏳ Pending | Express routes, validation |
| 5 — Redis + BullMQ | ⏳ Pending | Queues, Lua atomicity |
| 6 — Orchestrator | ⏳ Pending | Dispatch loop |
| 7 — Context passing | ⏳ Pending | Template resolution |
| 8 — Worker data plane | ⏳ Pending | Python bridge, executors |
| 9 — Fault tolerance | ⏳ Pending | Retries, crash recovery |
| 10 — SSE streaming | ⏳ Pending | Live status updates |
| 11 — Visual editor | ⏳ Pending | React Flow UI |
| 12 — Testing | ⏳ Pending | Testcontainers, benchmarks |
| 13 — Containerisation | ⏳ Pending | Docker multi-stage builds |
| 14 — Docs consolidation | ⏳ Pending | MASTER-QA, walkthrough |
