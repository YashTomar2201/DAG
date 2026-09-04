# Updates Log

A running record of fixes and polish applied to the DAG Engine **after** the
initial 14-phase build. Each entry: what changed, which files, and why.

---

## 2026-09-04 — B3.5: fan-out in the UI

**Phase:** roadmap B3.5. A fan-out now renders as **one** node with live progress
plus a drill-in to any child run's timeline — never N canvas nodes.

### Changes

- **`packages/contracts/src/events.ts`** — two SSE event types: `RUN_SPAWNED`
  (`{ mapNodeKey, total }`, emitted once when `spawnFanOut` starts) and
  `RUN_CHILD_COMPLETED` (`{ mapNodeKey, childRunId, fanOutIndex, status, total,
  succeeded, failed, cancelled }`, emitted per child reaching a terminal state).
- **`apps/api/src/services/orchestrator.service.ts`** — emits both on the
  **parent** run's channel (`spawnFanOut` / `onFanOutChildTerminal`). Also a
  `abortRun` hardening: a **second child-run sweep after** the FAILED
  transition, so a fail-fast can't leave an orphan child RUNNING behind a
  still-spawning `spawnFanOut` (its per-iteration status check + post-loop sweep
  are the other two backstops).
- **`apps/web/src/api/client.ts`** — the two new types added to the SSE
  listener set.
- **`apps/web/src/store/runSlice.ts`** — `fanOut: Record<mapNodeKey,
  { total, succeeded, failed, cancelled, done }>`; `RUN_SPAWNED` seeds `total`,
  `RUN_CHILD_COMPLETED` folds in the running tallies; `startListening` clears it.
- **`apps/web/src/components/CustomNode.tsx`** — a `flow.map` node with fan-out
  progress renders a `done / total` pill + a thin bar (green, amber if any
  failed) + a failure count.
- **`apps/web/src/components/FanOutPanel.tsx`** (new) — a slide-in that opens
  when a `flow.map` node is selected: the progress header, then a paginated
  child-run list (`GET /runs/:id/children`); click a child → its own
  `GanttChart` inline. Re-fetches as `progress.done` climbs.

### Verification

- `apps/api/src/integration/fan-out.integration.test.ts` gains an assertion:
  one `RUN_SPAWNED` (`total == columnCount`) and one `RUN_CHILD_COMPLETED` per
  child, the last carrying the fully-tallied summary, each with a numeric
  `fanOutIndex`. Full integration suite: 13 files / 41 tests green.
- `apps/web/src/store/runSlice.test.ts` (new, 5): `RUN_SPAWNED` seeds total;
  `RUN_CHILD_COMPLETED` updates tallies + derives `done`; two map nodes tracked
  independently; `startListening` clears fan-out state.
- `pnpm -r typecheck` / `lint` green.

### Rebuild note

`@dag/contracts` changed → `docker compose build api worker`. Web needs
`docker compose build web` for the baked editor.

## 2026-09-04 — B3.4: fan-out failure & cancellation cascade

**Phase:** roadmap B3.4. A failed child now fails the fan-out (or is tolerated
per config); cancelling the parent cancels the whole child subtree; retry
re-spawns only the failed children.

### Changes

- **`packages/contracts`** — `FlowMapConfig.failureThreshold` (default `0` =
  fail-fast: the first failed child cancels its siblings and fails the parent;
  set to N to tolerate up to N failures and let the join proceed on a partial
  result).
- **`apps/api/src/services/cancel.service.ts`** (new) — `cancelOneRun`,
  `cancelChildRunsOf` (depth-first over `parentRunId`), `cancelRunTree`. Own
  module so `run.service` and `orchestrator.service` share it without an import
  cycle. `run.service.cancelRunService` is now a thin wrapper over
  `cancelRunTree` — `POST /runs/:id/cancel` cascades to child runs.
- **`apps/api/src/services/orchestrator.service.ts`** —
  - `checkFanOutJoinIfChild` → `onFanOutChildTerminal`: if a child FAILED and
    `failed > threshold`, `abortRun(parent)`; otherwise join once all siblings
    are terminal. Guards added so a join can't resume a parent that a race
    aborted.
  - `abortRun` now cancels the run's child-run subtree first (via
    `cancelChildRunsOf`) before skipping pending nodes.
  - `spawnFanOut` checks the parent status each iteration and sweeps any
    race-window child after the loop — fail-fast can't leave an orphan child
    RUNNING.
  - `retryFanOutChildren(parentRunId, versionId)` (exported): for each
    `flow.map` node, reset every FAILED/CANCELLED child in place (subgraph
    NodeRuns → PENDING, attempt++), clear its Redis dispatch state, re-seed
    in-degrees, re-dispatch roots, and release the join claim. Called by
    `retryFailedNodesService` after it resets the parent's own FAILED/SKIPPED
    nodes.
  - `overSource` now also accepts a **JSON array literal** (small static
    fan-outs / fixtures), not only a template that resolves to an array.
- **`packages/queue/src/lua.ts`** — `clearFanOutJoinClaim` (SREM) and
  `clearDispatched` (DEL `run:{id}:dispatched`, so retried nodes re-enqueue).
- **`apps/worker/src/executors.ts`** — `data.source` now reads the **resolved**
  `csvPath` / `url` from `ctx.input` (falling back to `ctx.config`), so a
  `{{ nodes.X.output.Y }}` ref in those fields actually resolves — matches how
  `registry.deploy` already reads its input. (Latent bug fixed in passing;
  needed for per-child fan-out inputs.)
- **`apps/web`** — `flow.map` config panel gains a "Failed children allowed"
  field; `failureThreshold` added to the numeric-coercion set.

### Verification

- `apps/api/src/integration/fan-out-failure.integration.test.ts` (4):
  - **A. fail-fast** — one child fails at its gate, siblings (sitting in a slow
    node) are CANCELLED, the parent run FAILS, `reduce` + `merge` are SKIPPED.
  - **B. tolerate-partial** — `failureThreshold: 6` with 3 real + 3 bogus
    children → join proceeds, `map.output.fanOut = { succeeded: 3, failed: 3 }`,
    `reduce` + `merge` SUCCEEDED.
  - **C. cancel cascade** — `cancelRunService(parent)` while 8 children run →
    parent CANCELLED, every child terminal, ≥1 CANCELLED.
  - **D. retry only failed** — a fail-fast run with 1 survivor + 1 failed child;
    after the cause is removed, `retryFailedNodesService` re-spawns **only** the
    failed child (`respawnedChildren === 1`, survivor's NodeRun `attempt`
    unchanged), it recovers, and the parent run SUCCEEDS.
- Full integration suite: 13 files / 40 tests green. `pnpm -r typecheck` /
  `lint` / unit all green.

### Rebuild note

`@dag/contracts` + worker executor change → `docker compose build api worker`.

## 2026-09-04 — B3.3: fan-out output aggregation (flow.reduce)

**Phase:** roadmap B3.3. A `flow.reduce` node now folds a `flow.map`'s
children's *outputs* — not just the count summary B3.2 gave the downstream node.

### Changes

- **`packages/contracts`** — `flow.reduce` node type + `FlowReduceConfigSchema`
  `{ over (template ref to the results file), mode: 'concat'|'sum'|'mean',
  field? (dot-path for sum/mean) }`. (`custom`/script mode is a follow-up.)
- **`apps/api/src/services/orchestrator.service.ts`** — at `joinFanOut`, if any
  downstream node is `flow.reduce`, collect every child's **sink-node output**
  (subgraph leaves), ordered by `fanOutIndex`, write it to
  `${ARTIFACT_DIR}/${parentRunId}/${mapKey}/results.json` (atomic tmp+rename)
  and add `resultsPath` / `resultsCount` to the map node's output. The array
  never touches `map.output` itself, so a 1000-child fan-out stays under the
  64 KB cap. `subgraphSinkKeys` helper; `ARTIFACT_DIR` read straight off
  `process.env` (no `env.ts` `process.exit` risk).
- **`packages/db/src/repositories.ts`** — `getFanOutChildOutputs(parentRunId,
  sinkKeys)`: one `run.findMany` + one `nodeRun.findMany`, grouped in memory,
  ordered by `fanOutIndex`; `element` is the single sink's output, or a
  `{ [sinkKey]: output }` map, or `null` for a child that didn't succeed.
- **`apps/worker/src/executors.ts`** — `flowReduce`: reads the results file;
  `concat` flattens into one array written **by reference**
  (`{ mode, count, resultsPath }`); `sum` / `mean` fold a numeric `field`
  (dot-path via `dotGet`) → `{ mode, field, value, count }`; a missing file or
  no numeric values → `UnrecoverableError`. Routed to `ioQueue`.
- **`apps/web`** — `flow.reduce` palette entry (`Reduce`), `IconFanIn`,
  `ConfigPanel` fields (over / mode / field).

### Verification

- `apps/api/src/integration/fan-out-reduce.integration.test.ts` (3), real
  Postgres/Redis/workers: `split → map → reduce → merge` over the ~12-column
  titanic header —
  - the join writes `results.json` with all 12 child `work` outputs **ordered
    by `fanOutIndex`**; `map.output` carries only `{ fanOut, resultsPath,
    resultsCount }` and stays **< 2 KB**;
  - `mode: 'mean'` on `field: 'rows'` → `{ mode:'mean', field:'rows', value:<row
    count>, count:12 }`, `merge` ran once after `reduce`;
  - `mode: 'concat'` → `{ mode:'concat', count:12, resultsPath }`, the flattened
    file has 12 entries.
- Full integration suite: 12 files / 36 tests green. `pnpm -r typecheck` /
  `lint` / unit all green.

### Rebuild note

`@dag/contracts` changed → `docker compose build api worker`. No schema change.
The API container already mounts the `artifact_data` volume, so the join's
`results.json` lands where the reduce worker reads it.

## 2026-09-04 — B3.2: dynamic fan-out (spawn + summary join)

**Phase:** roadmap B3.2. A `flow.map` node now spawns one child run per element
of its resolved source array; the downstream node fires exactly once, after
every child is terminal, with a count summary.

### Changes

- **`packages/contracts/src/node-types.ts`** — new `flow.map` node type +
  `FlowMapConfigSchema` `{ overSource (template ref to an array), subgraph
  (node keys, non-empty), maxFanOut? (default 1000, abs max 10000) }`. Added to
  `NODE_TYPES` and the `NodeDef` discriminated union.
- **`apps/worker/src/executors.ts`** — `flowMap` executor: fails fast if
  `overSource` isn't an array or exceeds the 10 000 hard ceiling, logs the
  length, returns `{ count }` only (the orchestrator re-resolves the array —
  echoing 1000 elements would blow the 64 KB output cap). `queueForType` routes
  `flow.map` to `ioQueue`.
- **`packages/db/src/repositories.ts`** —
  - `createFanOutChildRun({...})` — one transaction: a child `Run`
    (`parentRunId` / `fanOutIndex`, `triggeredBy: 'fanout'`), a **pre-SUCCEEDED**
    NodeRun for the map key carrying `{ item, index, count }` (so the subgraph
    references it as `{{ nodes.<map>.output.item }}`), and PENDING NodeRuns for
    the subgraph. Idempotent on `${parentRunId}:${mapKey}:${i}`.
  - `countNonTerminalChildren(parentRunId)`, `getRunTreeInfo(runId)`.
- **`packages/queue/src/lua.ts`** — `claimFanOutJoin(parentRunId, mapKey)`:
  Redis `SADD` returns 1 for exactly one caller, so among simultaneous
  last-finishers only one runs the join.
- **`apps/api/src/services/orchestrator.service.ts`** —
  - `startRun` excludes every `flow.map` subgraph key from the parent run's
    NodeRuns and in-degree seeding (a subgraph node would otherwise sit PENDING
    in the parent forever).
  - `onNodeSucceeded`: a `flow.map` node calls `spawnFanOut` instead of
    `propagateToChildren` — the downstream in-degree decrement is deferred to
    the join.
  - `spawnFanOut` re-resolves `overSource`, guards `maxFanOut` / unknown
    subgraph keys (→ `abortRun`), then per element `createFanOutChildRun` →
    `RUNNING` → seed subgraph in-degrees → dispatch subgraph roots. Replay-safe.
  - `checkFanOutJoinIfChild` (called from `onNodeSucceeded` / `onNodeFailed` /
    `abortRun` on every terminal run): if no siblings remain non-terminal,
    `joinFanOut` merges `{ childCount, succeeded, failed, cancelled }` onto the
    map node's output and runs the normal `propagateToChildren` — so the
    downstream node dispatches once.
- **`apps/web`** — `flow.map` in the palette (`Fan-out (map)`), `IconFanOut`,
  `ConfigPanel` fields (over / subgraph / maxFanOut). `graphSlice.sanitizeConfig`
  now coerces `maxFanOut` to a number and splits `subgraph` (`"a, b"` → `["a","b"]`).

### Verification

- `apps/api/src/integration/fan-out.integration.test.ts` (5), real
  Postgres/Redis/2 workers: a `data.source → flow.map → data.source` graph with
  `overSource = {{ nodes.split.output.columns }}` (the ~12-column titanic
  header) → **12 child runs, all SUCCEEDED, `triggeredBy: 'fanout'`, contiguous
  `fanOutIndex`**; `work` NodeRuns span **≥2 workerIds** (parallel); each
  child's seed carries the right `item`/`index`; the downstream `merge` node ran
  **once** (`attempt: 0`), after the last child, with
  `map.output.fanOut = { childCount: 12, succeeded: 12, failed: 0 }`; the parent
  has **no** `work` NodeRun; **replaying `spawnFanOut` creates zero duplicate
  children** and doesn't re-run `merge`.
- Full integration suite: 11 files / 33 tests green. `pnpm -r typecheck` /
  `lint` / unit tests all green.

### Rebuild note

`@dag/contracts` changed → both `api` and `worker` images need
`docker compose build api worker`. No schema change.

## 2026-09-04 — B3.1: run-tree schema + read paths

**Phase:** roadmap B3.1. Purely additive groundwork for dynamic fan-out
(map/reduce) — no execution behaviour changes yet.

### Changes

- **`packages/db/prisma/schema.prisma`** + migration `20260903221423_b3_run_tree` —
  `Run` gains `parentRunId String?`, `fanOutIndex Int?`, a self-relation
  (`parent` / `children`, `RunTree`), and `@@index([parentRunId, status])` for
  the fan-out join query. All nullable; the FK is `ON DELETE SET NULL`.
- **`packages/db/src/repositories.ts`** —
  - `getChildRunSummary(parentRunId)` → `{ total, pending, running, succeeded,
    failed, skipped, cancelled }` from a single `groupBy`, never by loading
    child rows. All-zero for a childless run.
  - `listChildRuns(parentRunId, { limit, cursor })` → cursor-paginated, ordered
    by `fanOutIndex` then `id`, lean projection.
- **`apps/api/src/services/run.service.ts`** — `getRunService` now returns
  `{ ...run, children }` (the summary); new `listRunChildrenService(runId,
  { limit?, cursor? })` (default 50, max 200).
- **`apps/api/src/routes/run.routes.ts`** — `GET /runs/:id/children?limit=&cursor=`
  → `{ children: [...], nextCursor }`.
- **`apps/web/src/api/client.ts`** — `ChildRunSummary` / `ChildRunRow` types,
  `RunSummary.children?`, and `getRunChildren()` (forward-compat for B3.5; no UI
  yet).

### Verification

- `apps/api/src/integration/run-tree.integration.test.ts` (4): ordinary run →
  all-zero `children`; a 5-child parent (statuses 3×SUCCEEDED / FAILED / RUNNING,
  indices inserted out of order) → correct per-status counts; `GET
  /runs/:id/children` pages `[0,1] → [2,3] → [4]` in `fanOutIndex` order;
  unknown run id → 404. Full integration suite: 10 files / 28 tests green.
- `pnpm -r typecheck` / `lint` green; api unit 43/45 (2 skipped).
- `prisma migrate dev` applied the migration to the local DB; the Docker
  `migrate` one-shot (`migrate deploy`) applies it on the stack.

### Rebuild note

`@dag/db` schema change → `docker compose build api migrate`, then
`run --rm migrate`. Workers don't read the new columns yet.

## 2026-09-04 — B2 (UI): Automation panel

The editor now surfaces B2. `apps/web/src/components/AutomationPanel.tsx` — a
slide-in on the canvas (button bottom-right, same shape as Run History):

- **Cron schedules** — list (cron, plain-English gloss, timezone, `next in …`,
  `last fired …`), an enable/disable checkbox, delete, and an add row with four
  preset chips (`* * * * *`, `0 * * * *`, `0 2 * * *`, `0 9 * * 1`) feeding a
  free-text cron `<input>`.
- **Webhook triggers** — list (masked token, Copy URL, enable toggle, delete)
  and an add button; on create, a one-time green box reveals the full URL + the
  signing secret with Copy buttons and the `X-Signature-256` hint (the secret is
  never shown again).

`apps/web/src/api/client.ts` gained the schedule/trigger CRUD calls and
`webhookUrl()`; `icons.tsx` gained `IconClock` / `IconWebhook`. Only active once
the workflow is saved (both run its latest version). Browser-verified against
the live API: create/list/enable-toggle/delete for both; the Redis Job Scheduler
count returned to 0 after a UI delete.

## 2026-09-04 — B2 (backend): scheduled + webhook-triggered runs

**Phase:** roadmap B2. Runs could only start via `POST /runs`. Now a workflow
runs itself on a cron, or when a signed webhook fires. Engine + API + tests
here; the editor UI is a follow-up.

### Changes

- **`packages/db/prisma/schema.prisma`** + migration
  `20260903211647_b2_schedules_and_triggers` — two models:
  - `Schedule` — `{ cron, timezone, enabled, lastRunId, lastFiredAt, nextFireAt }`,
    pins the **workflow** (not a version): each fire runs the latest saved
    version. Indexed `[workflowId]` and `[enabled, nextFireAt]`.
  - `Trigger` — `{ token (unique), secret, enabled, lastRunId, lastFiredAt }`.
    `token` is the public URL segment; `secret` keys the HMAC.
- **`packages/queue/src/scheduler.ts`** (new) — a `scheduler` BullMQ queue plus
  helpers over BullMQ **Job Schedulers** (`upsertScheduleJob` /
  `removeScheduleJob` / `listScheduleJobIds`): Redis-backed cron that survives
  API restarts and never double-fires across replicas. Also `assertValidCron`
  / `nextCronFire` (via `cron-parser`, added as a `@dag/queue` dep) and
  `plannedFireMillis` — the tick's planned time for the idempotency key
  (parses BullMQ's `<id>:<millis>` job id, falls back to the current minute).
- **`apps/api/src/services/schedule.service.ts`** (new) — CRUD that keeps the
  DB row and the Job Scheduler in lock-step (create/enable → upsert,
  disable/delete → remove), plus `fireSchedule(scheduleId, jobId)`: resolves
  the latest version, `startRun` with
  `idempotencyKey = schedule:<id>:<plannedISO>`, records `lastRunId` /
  `nextFireAt`. `reconcileSchedules()` re-asserts every enabled row's Job
  Scheduler on boot (heals a flushed Redis).
- **`apps/api/src/scheduler-worker.ts`** (new) — a BullMQ `Worker` on the
  `scheduler` queue, started from `index.ts` only (not `createApp`, so
  integration tests don't spin a timer). One tick = one `fireSchedule`.
- **`apps/api/src/services/trigger.service.ts`** (new) — trigger CRUD (the
  `secret` is returned once, on create, never listed) and
  `handleWebhookService(token, rawBody, signature)`: constant-time HMAC-SHA256
  check of `X-Signature-256: sha256=<hex>` over the **raw bytes**, then
  `startRun` with `idempotencyKey = webhook:<triggerId>:<sha256(body)>` — an
  identical replay returns the first run. A disabled/unknown token is a flat
  404 (no oracle).
- **`apps/api/src/services/orchestrator.service.ts`** — `startRun` gained an
  `opts.triggeredBy` (`'api'` default, else `'schedule'` / `'webhook'`), so
  `Run.triggeredBy` records the origin.
- **Routes** — `apps/api/src/routes/schedule.routes.ts`
  (`GET|POST /workflows/:id/schedules`, `PATCH|DELETE /schedules/:id`) and
  `trigger.routes.ts` (`GET|POST /workflows/:id/triggers`,
  `PATCH|DELETE /triggers/:id`, and `POST /triggers/:token` — the webhook).
  Both mount at the app root (`app.ts`). Shared `tenantOf` extracted to
  `routes/tenant.ts`.
- **`apps/api/src/app.ts`** — `app.post('/triggers/:token', express.raw(...))`
  **before** `express.json` so the webhook handler sees the exact bytes the
  caller signed; `express.json` then no-ops for that request.
- **`apps/api/src/errors.ts`** — `UnauthorizedError` → HTTP 401 (bad/missing
  webhook signature).
- **`packages/db/src/repositories.ts`** — `findRunByIdempotencyKey`,
  `getLatestVersionId`, `workflowBelongsToTenant`, and schedule/trigger CRUD
  helpers.

### Verification

- `apps/api/src/integration/schedule.integration.test.ts` (6) +
  `trigger.integration.test.ts` (5), real Postgres + Redis: invalid cron
  rejected; create → Job Scheduler exists + `nextFireAt` set; **`fireSchedule`
  twice for the same planned tick → exactly one run** (2nd `deduped: true`);
  disable/enable/delete sync the Job Scheduler; missing/wrong HMAC → 401;
  valid → run (`triggeredBy: 'webhook'`); identical replay → same run;
  different body → new run; cross-tenant → 404. Full integration suite: 11
  files / 24 tests green.
- Live stack (rebuilt `api` image, migration applied): created a
  `* * * * *` schedule → it fired on the minute boundary
  (`lastFiredAt: 21:36:00.103Z`), one `SUCCEEDED` run with
  `triggeredBy: schedule`, `nextFireAt` advanced; `redis ZCARD bull:scheduler:repeat`
  went to 0 after `DELETE /schedules/:id`. Webhook: signed POST → run;
  same body again → same runId, `deduped: true`; bad signature → 401.
- `pnpm -r typecheck` / `pnpm -r lint` green.

### Rebuild note

`@dag/db` (new Prisma models) and `@dag/queue` are baked into the `api` image —
`docker compose build api` (and the `migrate` one-shot, which shares the
`build` stage: `docker compose build migrate` then `run --rm migrate`). Workers
don't touch these tables, so a worker rebuild isn't required for B2.

---

## 2026-09-04 — B1.2: condition builder in the editor

**Phase:** roadmap B1.2. The engine has understood edge conditions since B1.1,
but the web editor couldn't author or show them and dropped `condition` on every
`toGraph()` / `fromGraph()` round-trip. Now you build, edit, and remove a
condition from an inspector panel — no JSON.

### Changes

- **`apps/web/src/lib/condition.ts`** (new) — shared helpers: `OP_OPTIONS`
  (the 8-op `<select>` list), `summarizeCondition` → the on-canvas label
  (`{{ nodes.evaluate.output.accuracy }} gt 0.9` renders as `accuracy > 0.9`),
  `coerceRightValue` (raw input string → number / boolean / `in`-list array,
  same spirit as `sanitizeConfig`'s numeric coercion), and `serializeCondition`
  (trims `left`, coerces `right`, returns `null` for a blank `left` so an
  incomplete condition is never POSTed).
- **`apps/web/src/store/graphSlice.ts`** —
  - `toGraph()` now emits `edge.condition` (via `serializeCondition`);
    `graphToFlow()` restores it onto `edge.data.condition`. Round-trip safe.
  - New `updateEdgeCondition(id, condition | null)` action — read-only-guarded,
    recorded in undo history.
  - `selectNode` / `selectEdge` now clear each other, so the node config panel
    and the edge inspector are mutually exclusive.
  - Exported `DagEdgeData` (`{ condition?: Condition }`).
- **`apps/web/src/components/EdgeInspector.tsx`** (new) — the config panel's
  edge mode: `source → target` header, "Add condition" (prefills
  `{{ nodes.<source>.output.accuracy }} gt 0.9`), left / op / right controls,
  "Remove condition", and a "Delete edge" button (wires up the store's
  `removeEdge`, which had no UI). Respects `isReadOnly`.
- **`apps/web/src/components/ConfigPanel.tsx`** — renders `<EdgeInspector />`
  when an edge is selected and no node is.
- **`apps/web/src/App.tsx`** — `displayEdges` decorates each edge: conditional
  edges are **dashed** with the summary as a label; during a run a resolved edge
  goes **green** (source `SUCCEEDED`, target dispatched) or **grey** (target
  `SKIPPED`), read from `runSlice.nodeStatuses`; the selected-edge highlight
  layers on top. `validateGraphForSave` now rejects a half-filled condition with
  a readable message instead of letting the API 400.

### Verification

- `apps/web/src/store/graphSlice.test.ts` (new, 6 tests, first web unit tests) —
  plain edge emits no `condition`; `updateEdgeCondition` attaches + coerces
  (`"0.9"` → `0.9`); `fromGraph → toGraph` round-trip preserves it; `null`
  removes it; `in` splits `"alpha, 2, beta"` → `['alpha', 2, 'beta']`;
  read-only version is a no-op.
- `pnpm -r typecheck` green; `pnpm --filter @dag/web lint` green.
- Browser (Vite dev server, no API needed): selected an edge → inspector opens;
  Add condition → edge turns dashed with an `accuracy > 0.9` label; changed the
  operator → label updates to `accuracy ≥ 0.9`; Remove condition → edge back to
  solid, label gone. No console errors. Run-time green/grey colouring is wired
  from `nodeStatuses` but not exercised here (Docker stack was paused).
- Added a `web` entry to `.claude/launch.json` (Vite dev on :5173).

---

## 2026-09-03 — B1.1: conditional edges in the engine

**Phase:** roadmap B1.1. "If accuracy > 0.9 deploy, else retrain" — branches
that activate on runtime data. Engine-only; the editor UI is B1.2. Author
conditions by POSTing a graph.

### Changes

- **`packages/contracts/src/graph.ts`** — `EdgeDef.condition?` = a structured
  `{ left, op, right }` (`ConditionSchema`): `left` is a template string
  (`{{ nodes.evaluate.output.accuracy }}` or a literal), `op ∈ {eq, ne, gt,
  gte, lt, lte, in, contains}`, `right` a string / number / boolean / array.
  Structured, not an expression string — no `eval`, no parser, renders as
  three inputs. `decisions_log.md` has the "why".
- **`apps/api/src/condition-evaluator.ts`** (new) — `evaluateCondition` resolves
  `left` with the Phase-7 `walkAndResolve` (now exported), then applies `op`.
  Numeric ops coerce both sides (`0.83` vs `"0.83"`); `eq`/`ne` are loose
  cross-type; `in`/`contains` for membership. An unresolved ref throws
  `UnresolvedTemplateError`; an ill-typed compare throws `ConditionTypeError` —
  never a silent `false`.
- **`packages/queue/src/lua.ts`** — `markParentActive` / `hasActiveParent` on a
  Redis set `run:{runId}:activeParents:{childKey}` (7-day TTL). Join semantics:
  **"any active parent"** — a child runs if ≥1 incoming edge was active, is
  `SKIPPED` only if every edge was inactive.
- **`apps/api/src/services/orchestrator.service.ts`** — `onNodeSucceeded`'s
  child loop replaced by `propagateToChildren(…, parentActive)`: per edge, mark
  active parents, **decrement in-degree regardless**, then dispatch (has active
  parent) or `skipNode` (none — which recurses with `parentActive = false`).
  `abortRun` handles a condition that can't be evaluated: sweep pending nodes
  to `SKIPPED`, run → `FAILED`.

### Verification

- `condition-evaluator.test.ts` — 8 unit tests (every op, coercion, unresolved
  ref throws).
- `contracts.test.ts` — condition parses; unknown op rejected (20 tests total).
- `conditional-branch.integration.test.ts` — real Postgres/Redis/workers:
  `evaluate → deploy [acc gt 0.99]` / `evaluate → retrain [acc lte 0.99]`,
  both → `merge`. Result: **deploy SKIPPED, retrain SUCCEEDED, merge SUCCEEDED
  (diamond re-join), run SUCCEEDED**. Bad-ref variant → **run FAILED, all nodes
  terminal, no hang**.
- Full integration suite still green (7 files, 13 tests). `pnpm -r typecheck` /
  `lint` clean; unit suites green (api 43).

### Files

`packages/contracts/src/{graph.ts, index.ts}`,
`apps/api/src/{condition-evaluator.ts (new), condition-evaluator.test.ts (new),
context-resolver.ts, services/orchestrator.service.ts}`,
`packages/queue/src/lua.ts`,
`apps/api/src/integration/conditional-branch.integration.test.ts` (new),
`knowledge_base/decisions_log.md`, `KNOWN_LIMITATIONS.md`.

---

## 2026-09-03 — D1.3: version history and restore

**Phase:** roadmap D1.3. Browse a workflow's immutable version history, load an
old one read-only, and restore it (which appends N+1 — never mutates history).
Web-only: "restore" is just `POST /workflows/:id/versions` with the old graph,
the version list reuses D1.2's `getWorkflow` / `getWorkflowVersion`.

### Changes

- **`store/graphSlice.ts`** — `versions: VersionMeta[]` + `setVersions`,
  `isReadOnly` flag. `fromGraph` meta gains `readOnly?`; `setWorkflowMeta`
  gains `isReadOnly`. The dirty-marking mutations (`updateNodeConfig`,
  `updateNodeLabel`, `addNode`, `removeNode`, `removeEdge`, `onConnect`) bail
  early when `isReadOnly` — belt to the ReactFlow-prop braces.
- **`components/VersionMenu.tsx`** (new) — header dropdown showing `v4 latest`,
  `v3`, `v2`, `v1` with timestamps; the button shows a `read-only` badge when
  you're not on the latest.
- **`App.tsx`** —
  - `viewVersion(id)`: dirty-guard → `getWorkflowVersion` → `fromGraph` with
    `readOnly = (id !== versions[0].id)` → stop any run stream. `localStorage`
    is untouched (same workflow).
  - `restoreVersion()`: `saveWorkflowVersion(workflowId, toGraph())` → new
    version → clears read-only, `markSaved`, refetch versions.
  - `refreshVersions()` after every open / save / restore.
  - a warning banner while `isReadOnly` with **Restore this version** /
    **Back to latest**; `<ReactFlow nodesDraggable={!isReadOnly}
    nodesConnectable={!isReadOnly} deleteKeyCode={isReadOnly ? null : …}>`; Save
    button disabled.
- **`components/ConfigPanel.tsx`** — inputs `disabled` and the Delete-node
  button hidden while read-only.
- **`components/RunHistory.tsx`** — each run row shows the version it used
  (`v3`), from the `versionId → "v{n}"` map.

### Verification (browser, against the live stack)

- Workflow with v1–v3; opened → loads **v3** (latest), `VersionMenu` shows
  `v3 ▾`.
- Pick **v1** → canvas swaps to v1's 4-node graph, `v1 read-only ▾`, banner
  "Viewing version 1 — read-only…", Save disabled, nodes `selectable` but not
  `draggable`, config inputs disabled.
- **Restore this version** → notice "Restored — this is now version 4",
  `VersionMenu` → `v4 latest / v3 / v2 / v1`, banner gone, editable again.
  `GET .../versions` confirms **4** versions and **v1's graph is byte-for-byte
  unchanged**.
- `pnpm -r typecheck` / `lint` clean; all unit suites green.

### Files

`apps/web/src/{App.tsx, store/graphSlice.ts, components/{VersionMenu.tsx (new),
ConfigPanel.tsx, RunHistory.tsx}}`.

---

## 2026-09-03 — D1.2: workflow list + open/rename in the editor

**Phase:** roadmap D1.2. The editor stops being a single hardcoded
`'My Pipeline'` — you can list, open, rename, delete, and switch workflows,
and a reload resumes where you were. The roadmap calls this "the biggest
perceived-quality jump in the whole roadmap."

### API

- **`GET /workflows/:id/versions/:versionId`** (new) — one full version
  (`graph` + `topoOrder`), tenant-scoped. "Open a workflow" needs the graph and
  `GET /workflows/:id` deliberately stays lightweight. Repo helper
  `getWorkflowVersion` + service + route.
- **`request()` in `apps/web/src/api/client.ts`** — returns `undefined` for
  `204` (DELETE) instead of choking on the empty body.

### Web

- **`store/graphSlice.ts`** — `fromGraph(graph, meta)`, the inverse of
  `toGraph()`: rebuilds React Flow nodes/edges and resets `_nodeCounter` past
  the highest `node-N` key so a later `addNode` can't collide. Plus
  workflow-identity state (`workflowId`, `versionId`, `workflowName`) moved out
  of `App.tsx` local state into the store, with `newWorkflow`, `setWorkflowMeta`,
  `setWorkflowName`.
- **`components/WorkflowMenu.tsx`** (new) — header dropdown: `+ New workflow`,
  then the tenant's workflows from `GET /workflows` (name · versionCount ·
  relative lastRunAt), each with open / rename (`prompt`) / delete (`confirm`).
  Refetches on open and whenever the parent bumps `refreshKey`.
- **`App.tsx`** —
  - inline-editable workflow name in the header (blur / Enter commits; if the
    workflow is saved it also `PATCH`es; Escape reverts).
  - `openWorkflow(id)`: dirty-guard → `getWorkflow` → latest version →
    `getWorkflowVersion` → `fromGraph` → stop any run stream → remember the id
    in `localStorage`. A 404 (stale id for a deleted workflow) clears the
    stored id instead of wedging.
  - `handleNewWorkflow()`: dirty-guard → `newWorkflow()` → clear the stored id.
  - first mount resumes `localStorage['dag:lastWorkflowId']`.
  - `beforeunload` handler warns when `isDirty`.
  - first save sends the header name (not `'My Pipeline'`) and records ids in
    the store + `localStorage`.

### Verification (browser, against the live stack)

- Rename "Untitled workflow" → "Titanic pipeline", **Save** → button flips to
  "Saved", `POST /workflows` created it with that name, `localStorage` set.
- **Workflows ▾** lists it ("1 version · never run"); "+ New workflow" resets
  the canvas to the starter graph, name → "Untitled workflow", `localStorage`
  cleared, Save button back to "Save pipeline".
- Reopen "Titanic pipeline" from the menu → 4 nodes rebuilt via `fromGraph`,
  name + `localStorage` restored, Save shows "Saved" (clean).
- **Page reload** → resumes "Titanic pipeline" (graph, name, ids) from
  `localStorage`.
- Edit a node's Target Column (Save → "Save changes", dirty) then "+ New
  workflow" → `confirm("You have unsaved changes…")`; **decline** stays put,
  **accept** switches. `beforeunload` guard wired the same way.
- `pnpm -r typecheck` / `lint` clean; unit suites green; the
  `workflow-crud` integration test (now also covering `getWorkflowVersion`)
  passes.

### Files

`packages/db/src/{repositories.ts, index.ts}`,
`apps/api/src/{services/workflow.service.ts, routes/workflow.routes.ts}`,
`apps/web/src/{App.tsx, api/client.ts, store/graphSlice.ts,
components/WorkflowMenu.tsx}`.

---

## 2026-09-03 — D1.1: the workflow CRUD API

**Phase:** roadmap D1.1. The read/rename/delete side of workflow management —
no UI yet (D1.2). Testable with `curl` alone.

### Changes

- **`packages/db/prisma/schema.prisma`** + migration
  `20260903010421_workflow_soft_delete` — `Workflow.deletedAt DateTime?` (soft
  delete: runs reference immutable versions, so a hard delete would cascade
  away history or fail on the FK) and `@@index([tenantId, createdAt])` for the
  list query.
- **`packages/db/src/repositories.ts`** — `listWorkflows` (tenant-scoped,
  newest-first, cursor-paginated; `versionCount` + `lastRunAt` computed in ONE
  extra query — a `workflowVersion.findMany` that also pulls each version's
  latest run — not one per row), `getWorkflowWithVersions`,
  `listWorkflowVersions`, `renameWorkflow`, `softDeleteWorkflow`. Every one
  filters `deletedAt: null` and scopes by `tenantId`. `lastRunAt` is the most
  recent `Run.startedAt`.
- **`apps/api/src/services/workflow.service.ts`** — thin services over those
  (limit clamped 1–100, default 25; 404 via `NotFoundError` when a row is
  missing / soft-deleted / wrong tenant).
- **`apps/api/src/routes/workflow.routes.ts`** —
  `GET /workflows` (`?tenantId=&limit=&cursor=`),
  `GET /workflows/:id`, `GET /workflows/:id/versions`,
  `PATCH /workflows/:id` `{ name }`, `DELETE /workflows/:id` → 204.
  A `tenantOf(req)` shim reads `?tenantId=` (default `"default"`) — A3 swaps it
  for `req.tenantId` from a verified key.
- **`apps/api/src/integration/workflow-crud.integration.test.ts`** (new) —
  create ×3 → list order / `versionCount` / `lastRunAt` → cursor pagination →
  rename (no new version) → cross-tenant 404 → soft-delete (gone from list,
  404 on read, **run still readable by id**) → double-delete 404.
- **`apps/api/src/integration/fixtures.ts`** — `waitUntil` default 20s → 45s.
  The A1.2–A1.4 pipeline scripts do real scikit-learn work (~20s serial), which
  flaked the old cap when the whole integration suite ran back-to-back.

### Verification

- Full `curl` cycle on the live stack: create 3 → list (newest-first,
  `versionCount`, `lastRunAt` only on the one with a started run) → `limit=2` +
  `cursor` paginates → `PATCH` renames without adding a version → `DELETE` →
  204, gone from list, `GET` → 404, but `GET /runs/:id` for the deleted
  workflow's run → 200 SUCCEEDED. Empty name → 400, wrong tenant → 404,
  re-delete → 404.
- `pnpm -r typecheck` / `lint` clean; unit suites green (api 35); **all 6
  integration files pass (11 tests)** including the new one.

### Files

`packages/db/prisma/{schema.prisma, migrations/20260903010421_workflow_soft_delete/}`,
`packages/db/src/{repositories.ts, index.ts}`,
`apps/api/src/{services/workflow.service.ts, routes/workflow.routes.ts}`,
`apps/api/src/integration/{workflow-crud.integration.test.ts, fixtures.ts}`.

---

## 2026-09-03 — A5: clear the lint backlog + add CI

**Phase:** roadmap A5. Goal: `pnpm -r lint` is green so CI can catch
regressions.

### Changes

31 pre-existing ESLint errors fixed (was: `apps/worker` 4, `apps/api` 27 — the
rest of the estimated ~30 had been chipped away in earlier phases). No
behavioural change beyond one strictly-safer null guard.

- **`apps/worker/src/worker.ts`** — dropped unused imports (`prisma`,
  `findNodeRun`, `releaseConcurrencySlot`) and the unused `result` arg on the
  `'completed'` listener.
- **`apps/api/src/services/orchestrator.service.ts`** — the worst offender.
  `getGraphFromVersion(version: any)` → `WorkflowVersion`; `emitAndLog(payload:
  any)` → `Record<string, unknown>`; `onNodeSucceeded(output: any)` → `unknown`;
  `onNodeFailed(error: any)` → a new exported `NodeFailure` interface
  (`{ message; taxonomy? }`). Prisma-JSON writes now cast
  `… as unknown as Prisma.InputJsonValue` (the repositories.ts pattern) instead
  of `as any`. Removed the unused `UnresolvedTemplateError` import; renamed the
  unused `versionId` param to `_versionId`. Added `if (!version) throw new
  NotFoundError(...)` where a `null` `WorkflowVersion` would previously have hit
  a raw TypeError.
- **`packages/db/src/index.ts`** — re-exports `type { Prisma }` from the
  generated client, so consumers get `Prisma.InputJsonValue` without importing
  from `generated/`.
- **`apps/api/src/worker-events.ts`** — `returnvalue: any` → `unknown`.
- **`apps/api/src/routes/run.routes.ts`** — dropped unused `getRunEventsService`
  import.
- **`middleware/validate.ts`** (`import type`), **`services/sse.service.ts`**
  (`const`) — `eslint --fix`.
- **tests** — `context-resolver.test.ts` (8), `orchestrator.test.ts` (2),
  `sse.test.ts` (4): redundant inner `as any` casts removed (the fixtures are
  already `as unknown as Graph`); `sse.test.ts` got a `LogFrame` type for the
  `written` array so `.type` / `.logs` need no cast; one unused `forceFlush`
  destructure dropped.
- **`.github/workflows/ci.yml`** (new) — `pnpm -r typecheck && lint && test` on
  every PR and push to `main`. Corepack-pinned pnpm, Node 22, `prisma generate`
  before the checks (the client is gitignored). Concurrency-cancels superseded
  runs.

### Verification

- `pnpm -r lint` → exit 0, all 7 packages.
- `pnpm -r typecheck` clean; `pnpm -r test` → contracts 18 / graph-core 10 /
  worker 12 / api 35 green (queue / db / integration self-skip without
  services).
- `KNOWN_LIMITATIONS.md` §8 marked CLOSED.

### Files

`.github/workflows/ci.yml` (new), `apps/worker/src/worker.ts`,
`apps/api/src/{worker-events.ts, routes/run.routes.ts, middleware/validate.ts,
services/orchestrator.service.ts, services/sse.service.ts}`, three api test
files, `packages/db/src/index.ts`, `KNOWN_LIMITATIONS.md`.

---

## 2026-09-03 — A2: commit the migration history

**Phase:** roadmap A2. Goal: a fresh clone rebuilds the database
deterministically.

### Finding

The roadmap's premise was already stale — `packages/db/prisma/migrations/` is
**not** in `.gitignore`, and `20260821193005_init/migration.sql` +
`migration_lock.toml` are committed (landed in an earlier phase). So the core
deliverable existed; this phase verified it and closed the loop.

- `prisma migrate diff --from-migrations … --to-schema-datamodel …` →
  **"No difference detected"** (exit 0). The committed migration reproduces the
  current `schema.prisma` exactly — no drift.
- `prisma migrate deploy` against a throwaway virgin `postgres:16` → exit 0,
  applied `20260821193005_init`, created all six tables (`Tenant`, `Workflow`,
  `WorkflowVersion`, `Run`, `NodeRun`, `RunEvent`) + `_prisma_migrations`; a
  second `deploy` → "No pending migrations to apply."
- Full cold path: `docker compose down -v && up -d` — the `migrate` one-shot
  exits 0 and `api` comes up healthy on a fresh volume with zero manual steps.

### Note — the live dev DB was crufty

The long-running local stack's `dag_engine` had all six app tables but **no**
`_prisma_migrations` table (set up via `prisma db push` at some point), so
`prisma migrate status` reported `init` as unapplied and a direct
`migrate deploy` failed `P3005` (schema not empty). `down -v` + a clean
`migrate deploy` fixed it — and is exactly why `db push` must never touch a
DB that isn't a scratch DB.

### Changes

- **`.gitignore`** — added a comment by the Prisma `src/generated/` rule
  spelling out that `prisma/migrations/` is deliberately tracked, so it can't
  get re-ignored by accident.
- **`KNOWN_LIMITATIONS.md` §9** — marked CLOSED.

### Files

`.gitignore`, `KNOWN_LIMITATIONS.md` (migration files were already committed).

---

## 2026-09-03 — A1.5: an honest data source

**Phase:** roadmap A1.5 — last of the A1 arc. `kaggle.download` is gone. The
entry node is now `data.source`, which always runs with no credentials. Track
A's executor work is complete: the whole reference pipeline does real work.

### Changes

Renamed the node type `kaggle.download` → `data.source` (the discriminated
union ripples: contracts, executor registry, queue routing, web palette).

- **`packages/contracts/src/node-types.ts` / `index.ts`** —
  `KaggleDownloadConfigSchema` (`datasetSlug` + `outputDir`) → `DataSourceConfigSchema`
  (`csvPath?` local path, `url?` http(s)); both optional — with neither set the
  bundled `python/data/titanic.csv` is used. `NODE_TYPES`, the `NodeDefSchema`
  union member, and the exported `KaggleDownloadConfig` type renamed to match.
- **`apps/worker/src/executors.ts`** — `kaggleDownload` (shelled out to a
  `kaggle` CLI that isn't in the image) → `dataSource`: copies a local CSV
  (default: bundled) or `fetch`es one from an http(s) URL into the shared
  artifact volume, validates it parses as CSV (header + ≥1 data row), and emits
  `{ csvPath, rows, columns, bytes, checksum, sourceType, source }`. 4xx →
  `UnrecoverableError`, 5xx / network → retryable. 64 MB size cap. Idempotent on
  `result.json`. The unused `child_process` / `promisify` imports went with it.
- **`packages/queue/src/queues.ts`** — `queueForType` routes `data.source` to
  `queue:io`.
- **web** — `PALETTE_ITEMS` (`NodePalette`), `NODE_ACCENT` (`CustomNode`),
  `NODE_ICON` (`icons`), `NODE_CONFIG_FIELDS` (`ConfigPanel`), `REQUIRED_CONFIG`
  (`App`) all updated. Starter graph: node-1 is `data.source`
  (`csvPath: 'python/data/titanic.csv'`); node-2 preprocess now reads
  `csvPath: '{{ nodes.node-1.output.csvPath }}'` instead of a hardcoded path.
- **tests / fixtures** — `contracts.test.ts`, `api.test.ts`,
  `context-resolver.test.ts`, `orchestrator.test.ts` swapped to `data.source`.
  `hermeticPipelineGraph()`'s `extract` node is now `data.source` (it works
  hermetically — copies the bundled CSV), and the stale "why we substitute
  pandas.preprocess for kaggle" write-up is gone.
- **comments** — Kaggle-specific examples in `backoff.ts`, `errors.ts`,
  `events.ts`, `semaphore.ts` generalised. `grep -rn "kaggle" --include=*.ts`
  is now empty.

### Verification

- `pnpm -r typecheck` clean; contracts 18 / graph-core 10 / worker 12 / api 35
  unit tests green; contracts / queue / web lint clean (worker lint down one —
  the removed `catch (err: any)` — the remaining 4 are the pre-existing A5
  backlog in `worker.ts`).
- End-to-end on the live 4-worker stack: `data.source` → preprocess → train →
  evaluate all **SUCCEEDED**. `data.source` output: `sourceType "local"`, real
  `rows 891`, `columns [PassengerId … Embarked]`, `checksum sha256:…`; the CSV
  landed in `/data/artifacts/<runId>/source/data.csv` and preprocess read it
  through the template ref.
- `data.source` with no config → bundled titanic; with a bogus `csvPath` →
  `UnrecoverableError` (fails fast, no retries).

### Files

`packages/contracts/src/{node-types,index}.ts`, `apps/worker/src/executors.ts`,
`packages/queue/src/queues.ts`, `apps/web/src/components/{NodePalette,CustomNode,
icons,ConfigPanel}.tsx`, `apps/web/src/App.tsx`, `apps/web/src/store/graphSlice.ts`,
plus test/fixture and comment updates.

---

## 2026-09-03 — A1.4: real evaluation + a working quality gate

**Phase:** roadmap A1.4 — the payoff. `model.evaluate` now loads the trained
model and the held-out test split and computes genuine metrics; the
`minAccuracy` gate in `executors.ts` fails runs for a real reason.

### Changes

- **`apps/worker/python/evaluate.py`** — rewritten. When `weightsPath` /
  `testPath` are wired: `joblib.load` the model, `pd.read_parquet` the test
  split, align feature columns to `model.feature_names_in_`, and report
  `accuracy`, weighted `f1` / `precision` / `recall`, `confusionMatrix`,
  `labels`, `nTest`. If a ref is present but evaluation fails, the script exits
  non-zero (a wired-but-broken pipeline fails loudly). If neither ref is wired
  (an un-wired graph or the hermetic integration fixtures), it returns fixed
  reference metrics marked `"synthetic": true` so those pipelines still run
  green — the exact behaviour `fixtures.ts` documents.
- **`packages/contracts/src/node-types.ts`** — `ModelEvaluateConfigSchema` gains
  optional `weightsPath`, `testPath`, `targetColumn` (template-ref strings).
- **`apps/worker/src/executors.ts`** — `modelEvaluate` restructured:
  - `result.json` is written **before** the `minAccuracy` gate, so a rejected
    run still leaves the real metrics on disk.
  - the gate is applied on **every** execution, cache hit or not — a retry
    short-circuits the model load + scoring but can't sneak a sub-threshold
    model through.
  - gate error message now names the field: `… below the required minAccuracy 0.99`.
- **`apps/web/src/components/ConfigPanel.tsx`** — Model Ref / Test Data Ref /
  Target Column Ref inputs for `model.evaluate`; `minAccuracy` placeholder → 0.6.
- **`apps/web/src/store/graphSlice.ts`** — starter graph's Evaluate node wires
  `weightsPath: '{{ nodes.node-3.output.weightsPath }}'`,
  `testPath: '{{ nodes.node-2.output.testPath }}'`,
  `targetColumn: '{{ nodes.node-2.output.targetColumn }}'`, `minAccuracy: 0.6`.

### Verification

End-to-end on the live 4-worker stack (preprocess → train → evaluate → deploy,
all templates wired):

- **`minAccuracy: 0.6`** → run **SUCCEEDED**. evaluate output: real
  `accuracy 0.7486`, `f1 0.7302`, `confusionMatrix [[110,12],[33,24]]`,
  `synthetic: false`. deploy SUCCEEDED.
- **`minAccuracy: 0.99`** → evaluate **FAILED**
  (`Model accuracy 0.7486033519553073 is below the required minAccuracy 0.99`),
  deploy **SKIPPED**, run **FAILED** — a real failure for a real reason.
- **modelType change**: `randomforest` → accuracy 0.7486, cm `[[110,12],[33,24]]`;
  `logreg` → accuracy 0.6592, cm `[[118,4],[57,0]]`. Different metrics, different
  matrix.
- **retry short-circuit**: `POST /runs/:id/retry-failed` on the 0.99 run →
  worker log `model.evaluate: cache hit — re-checking gate` at `attempt: 1`,
  run FAILED again without re-loading the model or re-scoring.
- Fallback path (no refs) still returns `accuracy 0.923`, `synthetic: true`.
- `pnpm -r typecheck` clean; contracts 18 / worker 12 / api 35 unit tests green;
  contracts + web lint clean (the pre-existing `apps/worker` lint backlog is
  untouched — A5).

### Deferred

Surfacing the confusion matrix in the run-detail UI (roadmap "consider"): the
web run store doesn't hold node `output` yet, so this needs that plumbing first.
The matrix is already visible in the live log drawer.

### Files

`apps/worker/python/evaluate.py`, `apps/worker/src/executors.ts`,
`packages/contracts/src/node-types.ts`, `apps/web/src/components/ConfigPanel.tsx`,
`apps/web/src/store/graphSlice.ts`.

---

## 2026-09-03 — A1.3: real training

**Phase:** roadmap A1.3 — third of the A1 arc. `torch.train` now fits a real
scikit-learn estimator on the preprocessed split and logs a genuine
per-iteration train score. `model.evaluate` stays a stub for one more part
(A1.4), so the pipeline still finishes green.

### Changes

- **`apps/worker/python/train.py`** — rewritten. Same stdio protocol. Reads
  `trainPath` (the `train.parquet` from preprocess), `targetColumn`, `modelType`
  ("randomforest" default, or "logreg"), and `epochs` from the context.
  - **randomforest:** `warm_start=True`, `n_estimators` grown 1 → epochs, refit
    each step — a real score progression (bootstrap noise makes it
    non-monotonic). Deterministic (`random_state=42`) so the idempotency
    checksum is stable.
  - **logreg:** refit with a growing `max_iter` budget each step — a genuine
    convergence progression. The expected `ConvergenceWarning` is silenced so
    the log stays the score lines.
  - Model persisted with `joblib.dump` — a real pickle (~223 KB for RF on the
    Titanic split; `joblib.load` returns a fitted `RandomForestClassifier`),
    not the 11 bytes `STUBWEIGHTS`. Result carries `modelType`, `trainScore`,
    `scoreHistory`, `featureNames`, `nFeatures`, `nTrain`, and a `sha256` of
    the weights file.
  - Falls back to a deterministic `make_classification(400×8)` when no
    `trainPath` is wired, so un-updated graphs and the integration fixtures
    still train something real and stay green.
- **`packages/contracts/src/node-types.ts`** — `TorchTrainConfigSchema` gains
  optional `modelType` (`z.enum(['randomforest','logreg'])`), `trainPath`,
  `targetColumn`. Templates only survive if the key is on the schema
  (`z.object()` strips unknowns — the `registry.deploy` bug).
- **`apps/web/src/components/ConfigPanel.tsx`** — Model / Train Data Ref /
  Target Column Ref inputs for `torch.train`; weights placeholder → `model.joblib`.
- **`apps/web/src/store/graphSlice.ts`** — starter graph's Train node wires
  `trainPath: '{{ nodes.node-2.output.trainPath }}'`,
  `targetColumn: '{{ nodes.node-2.output.targetColumn }}'`,
  `modelType: 'randomforest'`, `outputWeightsPath: 'model.joblib'`.

### Verification

- `train.py` run directly on the A1.2 `train.parquet`:
  - randomforest, epochs 8 → `scoreHistory [0.8975, 0.8947, 0.9494, 0.9424,
    0.9733, 0.9691, 0.9803, 0.9761]` — **non-monotonic**; 178 KB joblib file;
    identical checksum across two runs.
  - logreg → `trainScore 0.68` vs RF `0.98` — **`modelType` changes the score**.
- End-to-end on the live 4-worker stack (templates resolved,
  `trainPath` threaded from preprocess): preprocess → train → evaluate all
  SUCCEEDED for both `randomforest` (`trainScore 0.982`) and `logreg`
  (`trainScore 0.684`, different checksum). SSE log shows real
  `[train] iter i/10 ... train_score=…` lines. In-container
  `joblib.load(model.joblib)` → `RandomForestClassifier n_estimators=10`.
- `pnpm -r typecheck` clean; contracts 18 / worker 12 / api 35 unit tests
  green; contracts + web lint clean.

### Note — bundled Dockerfile layer-ordering commit

This branch also carries `build(worker): install Python deps before copying app
code` (from the spun-off background task): the runtime stage now `COPY`s only
`requirements.txt` and runs `pip install` **before** `COPY --from=deploy /out ./`,
so editing worker source no longer busts the ~1-minute wheel-download layer.
Verified: `docker compose build worker` a second time reuses the pip layer
(`#34 … CACHED`).

### Files

`apps/worker/python/train.py`, `packages/contracts/src/node-types.ts`,
`apps/web/src/components/ConfigPanel.tsx`, `apps/web/src/store/graphSlice.ts`
(+ `infra/Dockerfile.worker` from the background task).

---

## 2026-09-03 — A1.2: real preprocessing on a bundled dataset

**Phase:** roadmap A1.2 — second of the A1 arc. The `pandas.preprocess` node now
does genuine work: it loads a CSV, drops mostly-empty and identifier-like
columns, median/mode-imputes, one-hot encodes, and writes a real train/test
parquet split. `torch.train` and `model.evaluate` stay stubs and simply ignore
the richer upstream output, so the pipeline still finishes green.

### Changes

- **`apps/worker/python/data/titanic.csv`** (new, ~62 KB) +
  **`data/make_titanic.py`** — a *synthetic* 891×12 passenger manifest,
  deterministically generated (`numpy` seed 42). Not the Kaggle file: same column
  shape and realistic missingness (Age ~21% null, Cabin ~76% null, Embarked a
  few), so preprocessing has real work to do while staying reproducible and
  credential-free. A1.5 adds an optional real source.
- **`apps/worker/python/preprocess.py`** — rewritten. Same stdio protocol (one
  JSON line in, log lines out, one `::RESULT::` line). Reads `csvPath` /
  `targetColumn` / `testSize` from the context (all optional; `csvPath` falls
  back to the bundled dataset). Real steps: drop columns with >40% nulls, drop
  near-unique object columns (Name, Ticket), median/mode impute, `pd.get_dummies`,
  `train_test_split(random_state=42)`, `to_parquet`. Result carries `rows`,
  `cols`, `nTrain`, `nTest`, `nFeatures`, `features`, and a content checksum
  (`sha256` of `hash_pandas_object(train_df)` — stable across parquet writer
  versions, moves iff the processed data moves).
- **`packages/contracts/src/node-types.ts`** — `PandasPreprocessConfigSchema`
  gains optional `csvPath` (string), `targetColumn` (string), `testSize`
  (`z.number().gt(0).lt(1)`). `z.object()` strips unknown keys, so a field only
  reaches the worker if it's on the schema.
- **`apps/web/src/components/ConfigPanel.tsx`** — `NODE_CONFIG_FIELDS` for
  `pandas.preprocess` gains CSV Path / Target Column / Test Size inputs.
- **`apps/web/src/store/graphSlice.ts`** — `testSize` added to
  `NUMERIC_CONFIG_KEYS` (else the `<input type=number>` string is sent as a
  string and rejected by Zod — the `minAccuracy` bug). Starter graph's Preprocess
  node now points at `python/data/titanic.csv` with `targetColumn: 'Survived'`,
  `testSize: 0.2`.

### Gotcha

`packages/contracts` is baked into **both** the `api` and `worker` images. The
first E2E showed the new config fields silently stripped — the running `api`
still had the old schema and `z.object()` dropped `csvPath` / `targetColumn` /
`testSize` before persisting the version. Rebuild **both**:
`docker compose -f infra/docker-compose.yml build api worker`.

### Verification

- `preprocess.py` run directly and end-to-end on the live 4-worker stack, three
  contexts (identical checksums locally and in-container — deterministic):
  - default `Survived` / 0.2 → 712 / 179 split, features `[PassengerId, Pclass,
    Age, SibSp, Parch, Fare, Sex_male, Embarked_Q, Embarked_S]`,
    checksum `…08368d5a`.
  - `targetColumn=Pclass` → `Survived` becomes a feature, checksum `…a6445109`.
  - `testSize=0.4` → 534 / 357 split, checksum `…6deb8a70`.
- Live SSE `NODE_LOG_BATCH` carries the real lines: `loaded 891 rows x 12 cols`,
  `dropped 1 high-null column(s): ['Cabin']`, `dropped 2 identifier-like
  column(s): ['Name', 'Ticket']`, `imputed 2 column(s) …`, `one-hot encoded …`,
  `split -> train 712 rows / test 179 rows`.
- Full pipeline still `SUCCEEDED` (preprocess / train / evaluate all SUCCEEDED).
- `pnpm -r typecheck` clean; contracts / graph-core / worker / api unit suites
  green; `pnpm --filter @dag/contracts --filter @dag/web lint` clean.

### Files

`apps/worker/python/data/titanic.csv` (new), `apps/worker/python/data/make_titanic.py`
(new), `apps/worker/python/preprocess.py`, `packages/contracts/src/node-types.ts`,
`apps/web/src/components/ConfigPanel.tsx`, `apps/web/src/store/graphSlice.ts`.

---

## 2026-09-03 — A1.1: a Python runtime that can hold real ML libraries

**Phase:** roadmap A1.1 — the first of the five-part A1 ("real ML executors")
arc. This part ships the *capability*, not the logic: the executor scripts
(`apps/worker/python/{preprocess,train,evaluate}.py`) are still the stdlib
stubs, so the pipeline behaves exactly as before. A1.2+ replace the scripts.

### Gap

`infra/Dockerfile.worker`'s runtime stage was `node:22-alpine` (musl) and
installed only the bare `python3` interpreter — the header comment even
explained why pandas/torch were *deliberately* left out. There are no musl
wheels for pandas / scikit-learn, so `pip install pandas` on that image tries
to compile from source and fails (or takes ~40 min). The image was
structurally incapable of running real ML, which blocks every later A1 part.

### Fix

- **New `apps/worker/python/requirements.txt`** — `pandas==2.2.3`,
  `scikit-learn==1.5.2`, `joblib==1.4.2`, `pyarrow==17.0.0`, pinned exactly for
  reproducible image builds. scikit-learn, not PyTorch: ~30 MB installed vs
  800 MB+ of torch wheels for the same tabular-demo value.
- **`infra/Dockerfile.worker`** — the whole `fetch → build → deploy → runtime`
  chain moved from `node:22-alpine` to `node:22-slim` (Debian / glibc). One
  libc across every stage on purpose: native modules compiled in `build` (the
  Prisma query engine, msgpackr-extract) are `COPY --from=deploy`'d verbatim
  into `runtime`, and a musl binary can't load in a glibc image.
  - `runtime` stage installs `python3 python3-venv python3-pip`, creates
    `/opt/venv`, and `pip install --no-cache-dir -r python/requirements.txt`
    into it. The venv sidesteps Debian's `externally-managed-environment`
    error that a bare `pip install` hits.
  - `ENV PATH="/opt/venv/bin:${PATH}"` so `python-bridge.ts`'s
    `spawn('python3', …)` resolves to the venv interpreter with **no code
    change**.
  - `build` stage gains `build-essential python3` so any native npm dep
    without a prebuilt Debian binary can still compile during `pnpm install`.
  - Header comment rewritten — the old text argued for omitting the deps; that
    rationale is now obsolete.

### Verification

- `docker compose -f infra/docker-compose.yml build worker` — clean; pip
  pulled prebuilt `manylinux` wheels for every package (no source builds).
- `docker compose … exec worker python3 -c "import pandas, sklearn, joblib,
  pyarrow"` — ok (pandas 2.2.3, sklearn 1.5.2); `command -v python3` →
  `/opt/venv/bin/python3`.
- Stub pipeline still green end-to-end: `POST /workflows` + `POST /runs` on the
  live 4-worker stack → run **SUCCEEDED**, all 4 NodeRuns SUCCEEDED, stub
  outputs (`accuracy 0.923`, `rows 100`) unchanged.
- `docker images infra-worker` — **1.31 GB**, under the ~1.5 GB target.

### Files

`infra/Dockerfile.worker`, `apps/worker/python/requirements.txt` (new).

---

## 2026-09-02 — Editor interaction & run-control fixes

Follow-up round after the redesign, all in `apps/web`. Shipped as PRs #2–#4
(#3 was accidentally merged into the feature branch instead of `main`; #4
re-targeted it, so all of this is on `main` as of merge commit `55147d6`).

### 1. Persistent highlight when an edge is clicked  (PR #2)

**Symptom:** clicking a connecting arrow lit it briefly, then the highlight
vanished the moment you clicked a node or the canvas.

**Cause:** it relied on React Flow's built-in selection, which clears on the next
click anywhere.

**Fix:**
- `graphSlice.ts` — new `selectedEdgeId` + `selectEdge` (click again to toggle
  off) and `removeEdge`; the id is cleared when its edge or an endpoint node is
  removed.
- `App.tsx` — `onEdgeClick` sets the highlight, `onPaneClick` clears it (and node
  selection). A `displayEdges` memo applies a terracotta stroke + animated
  marching-ants marker to the selected edge — a pure view concern, so it never
  marks the graph dirty.

### 2. Undo / redo for structural edits  (PR #3 → #4)

**Why:** accidentally deleting a node or edge (or a stray drag) had no recovery.

**Fix:** `graphSlice.ts` keeps `past` / `future` snapshot stacks (cap 50). A
`withHistory()` helper is merged into every structural action — `addNode`,
`removeNode`, `removeEdge`, `onConnect`; `undo` / `redo` swap the topology and
clear selection. `pushSnapshot(snap)` lets the view layer record a
caller-captured snapshot.

`App.tsx`:
- **Ctrl/Cmd+Z** = undo, **Ctrl/Cmd+Shift+Z** or **Ctrl+Y** = redo — ignored
  while a form field is focused, so text-undo still works in the config panel.
- Two header **↶ ↷** buttons (`IconUndo` / `IconRedo`), disabled when the stack
  is empty.
- Node drags snapshot on `onNodeDragStart` into a ref and only commit on
  `onNodeDragStop` if a position actually changed — a plain click never pollutes
  history or wipes the redo stack.
- A keyboard **Delete** removes the node and its connected edges in *separate*
  React Flow change batches, which would split one action into two undo steps.
  A single snapshot is taken in `onBeforeDelete` (before anything is applied) so
  one undo brings the node **and its edges** back together.

### 3. Run History: newest run on top  (folded into PR #3)

`RunHistory.tsx` rendered `[...runs].reverse()`, but `addRun` already prepends
new runs — so the list showed oldest-first. Dropped the `.reverse()`.

### 4. Can't start a run while one is in progress  (folded into PR #3)

**Symptom:** starting a second run mid-flight — the new one finished but the
previous stayed stuck on "RUNNING" in Run History.

**Cause:** `handleRun` only guarded the local `isRunning` flag, which is true
just for the `POST /runs` call, not the run's lifetime. The second run stole the
SSE stream and orphaned the first.

**Fix:** `App.tsx` derives `isRunActive` from the run store
(`activeRunId && runStatus === 'RUNNING'`) and uses it to disable the Run button
(label → "Running…") and hard-block `handleRun`. Safety valve: on a dead SSE
stream, `runSlice.stopListening()` now also clears `activeRunId` / `runStatus`
so the UI can never get permanently stuck; the user gets a notice pointing to
Run History.

### Verification

`pnpm -r typecheck` · `pnpm --filter @dag/web lint` · web build — all clean.
In-browser: edge highlight persists across node/pane clicks; delete node (panel
and Delete key) → one undo restores node + edges; edge delete + drag undo/redo;
Run button locks to "Running…" for the whole run, second run then records
cleanly, both rows terminal with newest on top.

---

## 2026-09-02 — Frontend redesign (de-AI-ify the UI)

Goal: the editor read as "AI-generated" — emoji icons everywhere, a spiky mark
lifted from another brand, solid-colour alert bars. This pass makes it look and
feel like a deliberately designed product: **professional, but with a bit of
personality.**

### 1. Custom icon set — every emoji removed

New file **[`apps/web/src/components/icons.tsx`](../apps/web/src/components/icons.tsx)** —
a family of line icons on a 24×24 grid, 1.75px stroke, round caps, `currentColor`.
Replaces emoji in:

| Was | Now |
|---|---|
| 📥 🐼 🔥 📊 🚀 (palette + canvas nodes) | `IconDownload` / `IconTransform` / `IconTrain` / `IconEvaluate` / `IconDeploy` |
| `▶ Run Pipeline`, `⏳ Starting…` | `IconPlay` / `IconSpinner` + "Run pipeline" |
| `🗑 Delete Node` | `IconTrash` + "Delete node" |
| `✕` close buttons | `IconClose` in a `.btn-ghost` |
| `⚠` / `✓` in the notice banner | `IconAlert` / `IconCheck` |
| `▶` in Run History empty state / retry | plain text / `IconRetry` |

### 2. New logo

The header mark was an Anthropic-style radial spike. Replaced with **`LogoMark`** —
a source node fanning out into two children (the smallest possible picture of a
DAG): filled terracotta source dot, two ink child dots, rounded connector strokes.
Wordmark is now **Nexus**`Flow` with "Flow" in the brand terracotta, over a small
"Visual DAG Orchestrator" caption.

### 3. Design-system pass — [`index.css`](../apps/web/src/index.css)

- **Per-node-type accent tokens** (`--node-download`, `--node-preprocess`, …) — one
  source of truth shared by the palette tile, the canvas node, and the config
  panel header, instead of three copies of the same hex.
- **Soft semantic tints** (`--color-*-soft`) — the notice banner is now a subtle
  tinted strip with a hairline border and an icon, not a full-bleed red/green bar.
- Reusable classes: `.palette-card` (hover-lift + accent-tinted icon chip),
  `.dag-node` / `.dag-node__icon` / `.dag-node__del`, `.input-dark` (focus ring),
  `.btn-ghost`, `.animate-in` (slide-fade entrance for panels/banners).
- `@keyframes spin` for the in-flight button spinner; refined React Flow edges
  (hover/selected → terracotta), controls, handles.

### 4. Component polish

- **NodePalette** — "BLOCKS" header, icon in a tinted rounded square, tighter
  cards, non-italic hint copy.
- **CustomNode** — icon chip + label + type on one row, hover-lift, selection glow
  uses the node's own accent via `color-mix`, cleaner corner delete control.
- **ConfigPanel** — icon-chip header, `.input-dark` fields with focus rings,
  slide-in animation, `IconTrash` delete.
- **RunHistory** — clock-icon trigger, ghost close button, run rows show a
  status **dot + label** (`SUCCEEDED · live`) instead of a solid pill.
- **LogDrawer** — a "terminal" header (three traffic-light dots) + node label.
- **App shell** — status pill is now a dot + word ("Running" / "Succeeded"); the
  canvas is a rounded inset surface sized by flexbox (fixes the earlier
  `width:100% + margin` overflow that made React Flow warn about container size);
  `fitView` re-runs from a `ResizeObserver` once the canvas has a real box, so the
  starter graph is always framed and never clipped.
- **Fonts** already loaded (Fraunces / Inter / JetBrains Mono) are now actually
  used consistently.

### Verification

`pnpm -r typecheck` clean · `pnpm --filter @dag/web lint` clean (removed a stale
`react-hooks/exhaustive-deps` disable that referenced an unconfigured rule) ·
web build clean · manual E2E in-browser: Save → Run → **Succeeded**, live logs,
Gantt, config panel, run history all verified with the new visuals.

---

## 2026-09-02 — Bug-fix & product-polish pass

Goal: turn the "built but buggy" editor into something that works end-to-end and
looks finished. The headline bug was **Save always failing**; several smaller
correctness and UX issues were fixed in the same pass.

### 1. Save button returned HTTP 500 (the big one)

**Symptom:** clicking *Save* in the editor always failed. `POST /workflows`
returned `{"error":"Internal server error"}`.

**Root cause:** the web client posts a fixed `tenantId: "default"`, but the
database had no `Tenant` row with that id. `Workflow.tenantId` is a foreign key
to `Tenant.id`, so every insert failed with a Prisma `P2003`
(`Workflow_tenantId_fkey`) violation, which the error handler maps to a generic
500.

**Fix:** `packages/db/src/repositories.ts` — `createWorkflow()` now upserts the
tenant inside the same transaction before creating the workflow
(`tx.tenant.upsert(...)`). A freshly-migrated database now needs no manual seed
step, and any `tenantId` the caller supplies "just works". The running dev
database was also seeded with the `default` tenant directly so the fix takes
effect without waiting on an image rebuild.

**Requires:** rebuild of the `api` image to pick up the repository change
(`docker compose -f infra/docker-compose.yml build api worker` then
`... up -d --scale worker=4`). Done as part of this pass.

### 2. `model.evaluate` save rejected when `minAccuracy` was set

**Symptom:** saving a graph with an Evaluate node whose *Min Accuracy* field was
filled returned `400 — "Expected number, received string"`.

**Root cause:** `<input type="number">` still yields a **string**. The API's
`ModelEvaluateConfigSchema.minAccuracy` is `z.number()` (not `z.coerce.number()`)
so it rejected `"0.8"`. Empty optional text fields were likewise sent as `""` and
rejected by `z.string().min(1).optional()`.

**Fix:** `apps/web/src/store/graphSlice.ts` — new `sanitizeConfig()` runs in
`toGraph()` before serialising: it drops empty / null / undefined config entries
and coerces the known numeric fields (`epochs`, `minAccuracy`) to real numbers.
`apps/web/src/components/ConfigPanel.tsx` keeps values as raw strings *while
editing* (so partial input like `0.` isn't mangled) and lets the sanitiser do the
final coercion.

### 3. API error messages were unreadable

**Symptom:** any failed save showed `Save failed: Error: API 400: {"error":...}`
— the raw stringified exception.

**Fix:** `apps/web/src/api/client.ts` — new `ApiError` class carries `status` and
the parsed JSON `body`, plus `toDisplayMessage()` which renders Zod issues as a
bullet list (`node 3 › minAccuracy: …`), cycle paths as
`a → b → a`, network failure as "Could not reach the API…", and 5xx as a
check-your-services hint. `App.tsx` uses this for both Save and Run.

### 4. `alert()` popups replaced with an inline banner

`App.tsx` — Save/Run success and failure now surface in a single dismissible
banner under the header (red for errors, green auto-dismissing after 4 s for
success). No more blocking `window.alert`.

### 5. Starter pipeline on the canvas

**Why:** the editor opened to a blank canvas — a poor first impression.

**Fix:** `graphSlice.ts` now seeds the reference ML pipeline from
`PROJECT_GUIDE.md` §1 — **Extract → Preprocess → Train → Evaluate** — pre-wired
with valid config and marked *not dirty*. A visitor can hit *Save* then
*Run Pipeline* immediately and watch a green run.

> Deploy was intentionally left **out of the starter graph** (still in the
> palette). See item 9.

### 6. `registry.deploy` always failed the run

**Symptom:** any pipeline ending in a Deploy node finished `FAILED` with
`registry.deploy: weightsPath "undefined" not found`.

**Root cause:** the deploy executor reads `ctx.input.weightsPath`, but
`RegistryDeployConfigSchema` had no field to carry that reference, so Zod stripped
it and the worker never received a path.

**Fix (two parts):**
- `packages/contracts/src/node-types.ts` — added optional
  `weightsPath` to `RegistryDeployConfigSchema` (a
  `{{ nodes.<train>.output.weightsPath }}` template ref, resolved by the
  control-plane context-resolver).
- `apps/worker/src/executors.ts` — `registryDeploy` no longer hard-fails when no
  weights path is resolved; it logs a warning and writes a deploy receipt with a
  `null` checksum. A mock deploy step should not red-flag an otherwise successful
  run.
- `ConfigPanel.tsx` — added the optional *Weights Ref* field for the Deploy node.

**Requires:** rebuild of the `worker` image (done).

### 7. Run History showed "Invalid Date"

**Root cause:** the `Run` table has no `createdAt` column, but the client type
claimed one and rendered `new Date(run.createdAt)`.

**Fix:** `RunHistory.tsx` — `formatRunTime()` falls back
`startedAt → createdAt → "Just now"` and guards `NaN`. `client.ts` — `createdAt`
marked optional on `RunRecord`.

### 8. Live-run robustness

- `client.ts` — `openRunEventStream` now closes the `EventSource` on a terminal
  run event instead of leaving the browser reconnecting forever, and only
  reports `onerror` when the stream is actually dead (`readyState === CLOSED`).
- `runSlice.ts` — `NODE_LOG` / `NODE_LOG_BATCH` default a missing `ts` to
  `Date.now()` (was rendering "Invalid Date" in the log drawer). New `upsertRun`
  action replaces a run in place from current store state; `RunHistory` uses it
  instead of a stale-closure `setRuns(runs.map(...))`.

### 9. Config panel UX

`ConfigPanel.tsx` — edits now apply to the canvas store immediately (which flips
`isDirty`), so the confusing per-node *Save Config* button is gone; the single
header *Save Changes* is the only save. The panel collapses entirely when no node
is selected so the canvas gets full width; it slides back in on selection.

### 10. Visual / "finished product" polish

- `index.html` — real web fonts (Fraunces / Inter / JetBrains Mono via Google
  Fonts); title/brand set to **NexusFlow — Visual DAG Orchestrator**.
- `index.css` — `box-sizing: border-box` reset, visible `:focus-visible` rings,
  slim theme-matched scrollbars, button hover/active/disabled states with
  shadow + press feedback.
- `App.tsx` — header shows the wordmark + tagline; nav reduced to a single
  active *Editor* tab (dead `#` links removed); canvas grid dots made visible;
  React Flow attribution hidden; `fitView` re-runs on mount (next frame) and on
  window resize so the starter graph is never clipped by late flex layout.
- Save button label is now `Save Pipeline` → `Save Changes` → `Saved ✓` instead
  of showing "Saved" before anything was ever saved.
- `main.tsx` / `components/ErrorBoundary.tsx` — a render error now shows a
  recoverable panel with a *Reload editor* button instead of a white screen.
- `GanttChart.tsx` / `LogDrawer.tsx` — show human node **labels**
  ("Train model") instead of internal ids ("node-3").

### Verification

- `pnpm -r typecheck` — clean.
- `pnpm --filter @dag/web build` — clean.
- Unit suites: contracts 18 ✓, graph-core 10 ✓, api 35 ✓ (2 integration
  skipped), worker 12 ✓.
- Manual E2E against the live Docker stack (api + 4 workers + Postgres + Redis):
  Save → Run → **SUCCEEDED**, live SSE logs, Gantt timing, run-history date all
  verified in the browser.

### Known limitations left untouched (see `KNOWN_LIMITATIONS.md`)

- `kaggle.download` still shells out to a `kaggle` CLI that isn't in the worker
  image; it recovers via retry in the mock path but real Kaggle downloads need
  the CLI + credentials.
- Executors are still mock ML (stdlib Python + `time.sleep`), not real
  pandas/torch.
- No auth / multi-tenant isolation; `tenantId` is still a trusted header.
