# Known Limitations

This document is an honest audit of what this system does *not* do, and what the real cost of
closing each gap would be. Being able to name your own limitations and sketch the fix is more
valuable than pretending they don't exist.

---

## 1. Multi-Tenancy Is Namespace-Only, Not Isolated

**What exists:** Every `Workflow`, `Run`, and `NodeRun` row carries a `tenantId` column, and the
API reads `tenantId` from a request header that is passed through as-is.

**What is missing:**
- No authentication or token verification — any caller can pass any `tenantId`.
- No row-level security (RLS) in Postgres — a bug in one API service function could query across
  tenants.
- Redis keys (`run:{runId}:indegree`, `run:{runId}:dispatched`) are keyed by `runId` alone, not
  `tenantId`. Two tenants sharing a Redis instance get no namespace separation at the broker layer.
- The per-run concurrency semaphore (`run:{id}:slots`) is likewise not tenant-scoped, so one
  tenant's fan-out can consume the entire cluster's capacity budget.

**To close it:**
- Add JWT/API-key authentication middleware that sets `req.tenantId` from a verified token, not
  from a raw header.
- Enable Postgres RLS on `NodeRun`, `Run`, and `Workflow` so a leaked `tenantId` cannot read
  another tenant's data even if the application layer fails.
- Namespace Redis keys as `{tenantId}:{runId}:indegree` (or use Redis ACLs to restrict key
  patterns per tenant).
- Add a per-tenant concurrency quota (a second semaphore, or a tenant-level BullMQ rate limiter)
  so one large tenant cannot starve others.

---

## 2. Scheduled + Webhook-Triggered Runs — ✅ CLOSED (roadmap B2)

**Done:**
- **Cron schedules.** A `Schedule` row (`{ workflowId, cron, timezone, enabled,
  lastRunId, lastFiredAt, nextFireAt }`) is mirrored by a BullMQ **Job
  Scheduler** on the `scheduler` queue (Redis-backed, survives API restarts, one
  fire per tick across replicas). The API process runs a `Worker` that turns
  each tick into `startRun` with
  `idempotencyKey = schedule:<id>:<plannedFireISO>`, so a crash-and-restart
  mid-tick can't double-start. `reconcileSchedules()` on boot re-asserts every
  enabled row's Job Scheduler. Routes: `GET|POST /workflows/:id/schedules`,
  `PATCH|DELETE /schedules/:id`.
- **Webhook triggers.** A `Trigger` row (`{ token, secret, enabled, … }`);
  `POST /triggers/:token` with `X-Signature-256: sha256=<hmac-of-raw-body>`
  starts a run of the latest version. `idempotencyKey =
  webhook:<triggerId>:<sha256(body)>`, so an identical replay returns the first
  run. Bad/missing signature → 401; unknown or disabled token → 404 (no oracle).
  Routes: `GET|POST /workflows/:id/triggers`, `PATCH|DELETE /triggers/:id`.
- `Run.triggeredBy` now records `'api'` / `'schedule'` / `'webhook'`.

Verified by `apps/api/src/integration/{schedule,trigger}.integration.test.ts`
and a live-stack smoke (schedule fired on the minute; webhook replay de-duped;
`DELETE /schedules/:id` cleared the Redis Job Scheduler).

**Still open:** file/S3-arrival and dataset-version sensors (polling triggers)
are not built — the webhook path is the extension point for them.

---

## 3. Dynamic Fan-Out — ✅ CLOSED (roadmap B3.1–B3.5)

**Done (roadmap B3.1 – B3.4):**
- Run tree: `Run.parentRunId` / `fanOutIndex` self-relation + `[parentRunId, status]` index;
  `GET /runs/:id` returns a `children` count summary, `GET /runs/:id/children` pages children.
- `flow.map` node type (`{ overSource, subgraph, maxFanOut }`). When it succeeds, the
  orchestrator spawns one child run per element of the resolved `overSource` array, each running
  `subgraph` with the element seeded as `{{ nodes.<map>.output.item }}`. Children execute in
  parallel across the worker fleet. The downstream node fires **exactly once**, after every child
  is terminal, via an atomic Redis join claim, and receives
  `map.output.fanOut = { childCount, succeeded, failed, cancelled }`. Spawn is idempotent
  (`${parentRunId}:${mapKey}:${i}`), so a crash mid-spawn never double-creates children.
- `flow.reduce` node type (`{ over, mode: concat|sum|mean, field? }`). At the join, every child's
  sink output is collected (ordered by `fanOutIndex`) into a results file on the artifact volume
  and its path exposed as `map.output.resultsPath` — the array never touches `map.output`, so it
  is cap-safe for any N. `concat` flattens by reference; `sum`/`mean` fold a numeric dot-path
  field.
- Failure & cancellation cascade: `FlowMapConfig.failureThreshold` (default 0 = fail-fast — the
  first failed child cancels its siblings and fails the parent, skipping the downstream reduce
  node; set N to tolerate up to N failures and join on a partial result). `POST /runs/:id/cancel`
  cascades to the whole child-run subtree and (roadmap B4) sets a Redis flag so a worker already
  running a node aborts its Python child within ~15 s — the NodeRun lands `CANCELLED`, not
  `FAILED`. `POST /runs/:id/retry-failed` re-spawns **only** the failed/cancelled children of each
  `flow.map` node, in place. Verified by
  `apps/api/src/integration/{fan-out,fan-out-reduce,fan-out-failure,hard-cancel}.integration.test.ts`.

- UI (B3.5): the `flow.map` node renders a `done / total` progress pill + bar (live over SSE
  `RUN_SPAWNED` / `RUN_CHILD_COMPLETED`); selecting it opens a paginated child-run list with a
  click-to-expand `GanttChart` per child. A 1000-element fan-out is still one canvas node.

**Nice-to-have not built:** nested fan-out (`flow.map` inside a subgraph — the cancel traversal is
already recursive for it), and `flow.reduce mode: 'custom'` (a user aggregation script).

---

## 4. Artifact Storage Is a Shared Volume, Not Object Storage — ✅ CLOSED (roadmap C1.1 + C1.2)

**What existed:** Workers wrote large outputs (datasets, model weights) to a shared Docker named
volume (`artifact_data` mounted at `/data/artifacts` in every worker container). That worked on a
single host or a Compose cluster where all replicas share the same physical volume, but not on
Kubernetes (workers on different *nodes*) or across cloud regions — `preprocess` on Node A writing
a file that `train` on Node B needs to read would fail silently.

**Done:**
- **C1.1** — extracted `apps/worker/src/artifact-store.ts`'s `ArtifactStore` interface
  (`put`/`get`/`exists`/`localPath`/`withOutputDir`). Every executor's reads/writes/idempotency
  checks go through it instead of raw `fs`. `FsArtifactStore` reproduces the old shared-volume
  behaviour exactly.
- **C1.2** — added `S3ArtifactStore` (`@aws-sdk/client-s3`), selected via `ARTIFACT_BACKEND=s3`,
  plus a MinIO service (`infra/docker-compose.s3.yml`, an opt-in overlay — the base
  `docker-compose.yml` still defaults to `fs`, so no test needs MinIO). Every path-shaped output
  field (`csvPath`, `trainPath`, `weightsPath`, `outputDir`, ...) is now a **store key**
  (`{runId}/{nodeKey}/file`) under *both* backends — not a resolved local path — so an executor's
  output means the same thing regardless of which worker or backend produced it. Python itself
  stays backend-agnostic: `withOutputDir()` hands it a real local directory (a temp dir for S3,
  the persistent volume for fs) and uploads/rewrites its return value into keys afterward;
  `resolveIfStored()` downloads an upstream key back to a local path immediately before a script
  needs to read it.
- `GET /runs/:id/nodes/:nodeKey/artifacts/:field/download` resolves a key to a working download:
  a 15-minute presigned S3 URL (redirect) under `s3`, a direct file stream under `fs`. Wired into
  the canvas's node inspector (`ConfigPanel`'s "Artifacts" section) once a node succeeds.
- **Known follow-up, not fixed here:** `flow.map`/`flow.reduce`'s fan-out join
  (`orchestrator.service.ts`) still writes its `results.json` straight to `ARTIFACT_DIR` on local
  disk rather than through the store — fan-out only works under `ARTIFACT_BACKEND=fs`. It fails
  loudly (`UnrecoverableError: results file not found`), not silently, under `s3`.
- **Lifecycle:** neither backend expires anything — every artifact from every run accumulates
  forever. Cheap on a local volume, real money on S3. No TTL/lifecycle policy exists yet; a
  bucket lifecycle rule (e.g. expire objects under `*/deploy-receipt.json` after 90 days) or a
  periodic sweep job keyed off `Run.finishedAt` would close this.

Verified: the full reference pipeline (`data.source → pandas.preprocess → torch.train →
model.evaluate → registry.deploy`) run live against real MinIO, with objects confirmed landing at
their expected keys and the download route round-tripping a real file; the fs-backend integration
suite (15 files / 45 tests) green unchanged; `S3ArtifactStore` unit-tested against a mocked
`S3Client` (no MinIO needed in CI).

---

## 5. Conditional Branching — ✅ CLOSED (roadmap B1.1 + B1.2)

**Done (roadmap B1.1):** `EdgeDef` carries an optional `condition`
(`{ left, op, right }` — see `packages/contracts/src/graph.ts`). `left` is
resolved as a Phase-7 template against completed parent outputs; `op` is one of
`eq ne gt gte lt lte in contains`. The orchestrator (`propagateToChildren` in
`orchestrator.service.ts`) evaluates each outgoing edge on parent completion:
an active edge marks the child's parent active in Redis
(`run:{id}:activeParents:{child}`), the in-degree still decrements for every
edge, and a child that reaches in-degree 0 with no active parent is `SKIPPED`
(cascading downstream). Join semantics are "any active parent" so an if/else
diamond re-joins. An unresolvable condition aborts the run
(`FAILED` + pending nodes `SKIPPED`), never a silent `false`. Verified by
`apps/api/src/integration/conditional-branch.integration.test.ts` and
`condition-evaluator.test.ts`.

**Editor (roadmap B1.2):** selecting an edge opens an inspector
(`apps/web/src/components/EdgeInspector.tsx`) with source→target header and
left / op / right controls; "Add condition" prefills a working
`{{ nodes.<source>.output.accuracy }} gt 0.9`. `toGraph()` / `fromGraph()` now
preserve `condition` on round-trip (`serializeCondition` in
`apps/web/src/lib/condition.ts` coerces the `right` input and drops a blank
condition). Conditional edges render dashed with the condition as a label;
during a run a resolved edge is coloured green (taken) or grey (skipped) from
the run store's node statuses. Covered by `apps/web/src/store/graphSlice.test.ts`.

**Remaining nuance:** one edge carries one `{ left, op, right }` — no compound
`A && B` on a single edge (model it as two edges in series or a router node, as
noted in the B1.1 decision log).

---

## 6. Worker Executors Are Mock ML — ✅ CLOSED (roadmap A1.1–A1.5)

The reference pipeline now does real work end to end. Kept here (rather than
deleted) so the section numbers below don't shift.

- **A1.1** — worker image carries real ML libraries (`node:22-slim` + a venv with
  `pandas` / `scikit-learn` / `joblib` / `pyarrow`).
- **A1.2** — `preprocess.py` loads a bundled dataset, drops high-null / identifier
  columns, imputes, one-hot encodes, writes a real `train_test_split` parquet
  pair with a content checksum.
- **A1.3** — `train.py` fits a real `randomforest` / `logreg`, logs a genuine
  per-iteration score, persists the model via `joblib`.
- **A1.4** — `evaluate.py` scores the held-out split (accuracy / f1 / precision /
  recall / confusion matrix); the `minAccuracy` gate fails runs for a real
  reason (`0.99` fails, `0.6` passes) and is re-checked on retry without
  re-scoring.
- **A1.5** — `kaggle.download` is gone. The entry node is `data.source`: it
  copies a local CSV (default: the bundled `python/data/titanic.csv`) or
  `fetch`es one from an http(s) URL, validates it, and emits real row/column
  counts. No CLI, no credentials, always runs.

Full write-ups in [`knowledge_base/updates.md`](knowledge_base/updates.md).

---

## 7. No Horizontal Scaling Proven Across Multiple Machines

**What exists:** `docker compose up --scale worker=4` starts four worker containers on the *same
Docker host* sharing the same CPU. The scale test confirms the dispatch/queue architecture is
correct, but the throughput numbers reflect CPU-bound process-spawn contention on a 12-core dev
machine, not true multi-machine scaling.

**What is missing:** A test or deployment that puts worker containers on genuinely separate
machines, so increasing worker count actually adds CPU capacity rather than competing for it.

**To close it:**
- Deploy the Compose cluster to a cloud provider (three separate EC2/GCE instances: one for
  api + postgres + redis, N for workers). The `docker-compose.yml` requires only one environment-
  variable change (`REDIS_URL` / `DATABASE_URL` pointing at the shared infra host).
- For production scale: port the cluster to Kubernetes with a `Deployment` for workers and a
  Kubernetes HPA (Horizontal Pod Autoscaler) targeting `queue:cpu` depth via a KEDA scaler. KEDA
  reads BullMQ's `queue.getWaitingCount()` via a Redis metric and scales the worker `Deployment`
  replica count automatically.

---

## 8. The Lint Backlog — ✅ CLOSED (roadmap A5)

`pnpm -r lint` exits 0 across all seven packages. The 31 pre-existing errors
(unused imports, and `@typescript-eslint/no-explicit-any` in the orchestrator /
SSE / worker-event code) were fixed with real types: `getGraphFromVersion` takes
`WorkflowVersion`, `emitAndLog` takes `Record<string, unknown>`,
`onNodeSucceeded` takes `unknown`, `onNodeFailed` takes a `NodeFailure`
interface, and the Prisma-JSON writes cast `… as unknown as Prisma.InputJsonValue`
(the pattern already used in `packages/db/src/repositories.ts`). `@dag/db` now
re-exports the `Prisma` type namespace so consumers don't reach into
`generated/`.

CI (`.github/workflows/ci.yml`) runs `pnpm -r typecheck && pnpm -r lint &&
pnpm -r test` on every PR and push to `main`, so the backlog can't silently
grow back.

---

## 9. Committed Prisma Migration History — ✅ CLOSED (roadmap A2)

`packages/db/prisma/migrations/20260821193005_init/migration.sql` and
`migration_lock.toml` are committed and **not** `.gitignore`d. `prisma migrate
diff` reports no drift between that migration and `schema.prisma`, and `prisma
migrate deploy` against a virgin PostgreSQL applies it cleanly (exit 0, all six
tables + `_prisma_migrations` bookkeeping), then no-ops on re-run. The Docker
`migrate` one-shot runs exactly that command before `api` starts.

From here on: schema changes go `pnpm --filter @dag/db db:migrate:dev` locally →
commit the new migration folder → `db:migrate:deploy` in CI. Never `db push`
against anything but a scratch DB — it mutates the schema without recording a
migration, which is how a running DB can drift out of sync with the history.

---

## 10. No Access Control on the `/metrics` Endpoint

**What exists:** `GET /metrics` is public — any caller can read internal throughput, queue
depth, and worker count data.

**What is missing:** Authentication on the scrape endpoint. In a real deployment, exposing queue
depth and worker counts to unauthenticated callers leaks information about cluster capacity and
current load.

**To close it:** Add a shared-secret bearer token check on the `/metrics` route (Prometheus
supports configuring a `bearer_token` in its scrape config), or restrict the endpoint to an
internal network interface only (not the public-facing port). The latter is the simpler fix for
a Kubernetes deployment where the Prometheus scraper already runs on the internal cluster network.
