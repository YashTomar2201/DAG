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

## 2. No Scheduled or Time-Triggered Runs

**What exists:** Runs are started only via `POST /workflows/:id/runs` — an explicit HTTP call
from the browser or an API consumer.

**What is missing:** Cron-style scheduling ("run this workflow every day at 02:00 UTC"), event-
triggered dispatch ("run when a file appears in S3"), or sensor polling ("run when a Kaggle dataset
version changes").

**To close it:**
- Add a `Schedule` model (`{ workflowId, cron: string, timezone: string, enabled: bool }`).
- Run a scheduler process (or an API-side `cron` job using `node-cron`) that wakes up, queries
  due schedules, calls `startRun`, and records the next fire time.
- For event triggers, integrate a webhook ingestion endpoint that validates a signature, matches
  a registered trigger, and calls `startRun`.
- Both need idempotency keys derived from the scheduled fire time / event ID to prevent double-
  starts on crash-and-restart of the scheduler process.

---

## 3. No Dynamic Fan-Out (Static Graphs Only)

**What exists:** The graph topology is fixed at version-creation time. Every node and edge is
known before the run starts.

**What is missing:** The ability for a node's output to determine how many downstream nodes run
— e.g., "process each row in the dataset in parallel, with one worker per chunk." This pattern
(map/reduce, scatter-gather, dynamic parallelism) is central to data pipeline use cases.

**To close it:**
- Extend `NodeRun` with a `parentRunId` / `fanOutIndex` so a single graph node can spawn a
  sub-run of N clones of its downstream subgraph, one per output element.
- The spawning node's completion handler would: (1) read `output.chunks[]`, (2) `createRun` N
  child runs, (3) seed their in-degree counters, (4) dispatch them.
- A collector/join node type would wait for all N child runs to reach a terminal state and merge
  their outputs before the parent run's downstream nodes are unlocked.
- This is a large surface-area change: it affects the schema (`Run.parentRunId`), the
  orchestrator (`startRun` with a fan-out context), the UI (rendering nested run trees), and the
  SSE event stream (hierarchical run events).

---

## 4. Artifact Storage Is a Shared Volume, Not Object Storage

**What exists:** Workers write large outputs (datasets, model weights) to a shared Docker named
volume (`artifact_data` mounted at `/data/artifacts` in every worker container). This works
correctly for any deployment on a single host or in a Compose cluster where all replicas share
the same physical volume.

**What is missing:** On Kubernetes (where workers run on different *nodes*, not just different
containers on one node) or across cloud regions, a host-local or Compose-local volume is not
accessible from all workers. `preprocess` on Node A writing a file that `train` on Node B needs
to read would fail silently — Node B simply would not have the file.

**To close it:**
- Replace the shared volume with an object-storage backend (S3, GCS, Azure Blob) as the artifact
  store. Workers call `s3.putObject` on write and `s3.getObject` on read, with the artifact path
  stored as the S3 key in `NodeRun.output`.
- The `ARTIFACT_DIR` env var abstraction already exists — only the read/write implementation in
  the executors and `python-bridge.ts` would change.
- For a Kubernetes deployment: use a `PersistentVolumeClaim` with a `ReadWriteMany` storage class
  (NFS, EFS, or a CSI driver) as a cheaper intermediate step, though object storage is the correct
  long-term answer for elasticity.

---

## 5. No Conditional Branching

**What exists:** Every node in a `GraphSchema` runs if its parents succeed; failure propagates
all descendants to `SKIPPED`. There is no mechanism to run different branches based on a parent
node's output value.

**What is missing:** "If model accuracy > 0.95, deploy. Otherwise, trigger a retraining branch"
— a conditional edge that only activates based on runtime data.

**To close it:**
- Add an optional `condition` field on `EdgeDef`: a JSONPath expression or a simple comparison
  evaluated against the parent's `output` at dispatch time.
- Extend `dispatchNode`: after template resolution, evaluate each outgoing edge's condition. Only
  decrement in-degree for children whose edge condition is true; mark children of a false branch
  as `SKIPPED` immediately.
- Zod schema validation at version-creation time cannot statically verify that conditions are
  satisfiable (that's undecidable in general), but it can validate that condition expressions are
  syntactically valid and reference fields that exist on the parent node's declared output schema.

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
