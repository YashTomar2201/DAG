# Roadmap — taking the DAG Engine from demo to product

A phase-by-phase guide to everything left to do, in dependency order, with the
concrete steps for each. Written as a companion to
[`build-dag-engine.md`](../build-dag-engine.md) (which covered Phases 0–14) and
[`KNOWN_LIMITATIONS.md`](../KNOWN_LIMITATIONS.md) (which names the gaps this
document closes).

**Read this first:** the orchestration core — dispatch, in-degree scheduling,
compare-and-swap state transitions, idempotency, SSE replay — is finished and
correct. Nothing below rewrites it. Every phase either (a) puts real work on top
of it, (b) adds a scheduling capability it was designed to accept, or (c) makes
the deployment story true.

---

## 0. How to work through this

The loop that's been working, keep using it:

```bash
git checkout main && git pull --ff-only origin main
git checkout -b <type>/<short-name>
# ... make the change ...
pnpm -r typecheck && pnpm -r lint && pnpm -r test
# ... verify in the browser / against the live stack ...
git commit && git push -u origin <branch>
# open PR, merge, delete branch
```

**Rules that keep this from going sideways:**

1. **One phase per PR.** These phases are deliberately sized to be reviewable.
2. **Never edit `apps/api` or `apps/worker` without rebuilding their images.**
   They run from baked Docker images:
   ```bash
   docker compose -f infra/docker-compose.yml build api worker
   docker compose -f infra/docker-compose.yml up -d --scale worker=4 api worker
   ```
   `apps/web` runs from Vite locally and hot-reloads — no rebuild needed.
3. **Add a test for the invariant, not the implementation.** The existing suites
   (`packages/*/src/*.test.ts`, `apps/api/src/integration/*`) test *properties*
   ("a node never runs twice", "a cycle is rejected"). Match that style.
4. **Log every phase in [`updates.md`](./updates.md)** with symptom / cause / fix.
5. **Update `KNOWN_LIMITATIONS.md`** — delete the section a phase closes. That
   file's honesty is an asset; keeping it current is part of the work.

### Dependency order

```
Track A (credibility)  A1 ─ A2 ─ A3 ─ A4 ─ A5      ← do this track first, in order
                        │
Track B (engine)        └─ B1 ─ B2 ─ B3 ─ B4 ─ B5
                                    │
Track C (production)                └─ C1 ─ C2 ─ C3 ─ C4
Track D (product)       D1 ─ D2 ─ D3               ← can run in parallel with B
```

**A1 gates everything.** Until the executors do real work, every other phase is
polish on a system that doesn't do anything.

---

# Track A — Make it credible

The goal of this track: a reviewer who opens any file finds what the README
promised. Right now they don't.

## A1 — Real ML executors

> **Goal:** the pipeline actually processes a dataset, trains a real model, and
> reports real metrics that change when the data or config changes.
>
> **Why:** this is the single biggest gap. `train.py` never opens the dataset —
> it sleeps and writes the literal bytes `STUBWEIGHTS`. `evaluate.py` returns a
> hardcoded `0.923` every time. The engine is dataset-blind because no node
> consumes data. Everything else in this roadmap is decoration until this is fixed.
>
> **Effort:** large — the biggest single phase here. Budget 2–3 sessions.

### Files

```
apps/worker/python/requirements.txt      (new)
apps/worker/python/preprocess.py         (rewrite)
apps/worker/python/train.py              (rewrite)
apps/worker/python/evaluate.py           (rewrite)
apps/worker/src/executors.ts             (kaggleDownload: add a real fallback)
infra/Dockerfile.worker                  (install the deps; switch base image)
packages/contracts/src/node-types.ts     (widen configs: targetColumn, testSize, modelType)
apps/web/src/components/ConfigPanel.tsx  (surface the new fields)
```

### Steps

**1. Pick a dataset that ships with the repo.** Do *not* start with Kaggle —
credentials and network turn a deterministic demo into a flaky one. Use a small
CSV committed to `apps/worker/python/data/` (Titanic ~60 KB, or generate one with
`sklearn.datasets`). Kaggle download becomes an *optional* source in step 6.

**2. Add `apps/worker/python/requirements.txt`:**

```
pandas==2.2.*
scikit-learn==1.5.*
joblib==1.4.*
```

Start with scikit-learn, **not** PyTorch. Rationale: `sklearn` is ~30 MB and
trains a real model on tabular data in under a second; `torch` is 800 MB+ of
wheels for the same demo value. Keep the node type named `torch.train` if you
want (it's just a string) or rename it — see the note in step 7.

**3. Fix `infra/Dockerfile.worker`.** The runtime stage is `node:22-alpine`,
which has no wheels for pandas/sklearn — you'd be compiling from source. Switch
the runtime stage to Debian slim:

```dockerfile
FROM node:22-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=deploy /out ./
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -r python/requirements.txt
ENV PATH="/opt/venv/bin:$PATH"
CMD ["node_modules/.bin/tsx", "src/index.ts"]
```

The venv avoids Debian's `externally-managed-environment` error. `PATH` is set so
`python-bridge.ts`'s `spawn('python3', ...)` picks up the venv interpreter with
no code change.

**4. Rewrite `preprocess.py`.** Keep the stdio protocol exactly as-is (read one
JSON line from stdin, print log lines, end with `::RESULT:: {json}`) — the bridge
depends on it:

```python
ctx        = json.loads(sys.stdin.readline())
csv_path   = ctx["csvPath"]                    # from config or upstream output
target     = ctx.get("targetColumn", "Survived")
output_dir = ctx["outputDir"]

df = pd.read_csv(csv_path)
print(f"[preprocess] loaded {len(df)} rows x {len(df.columns)} cols", flush=True)

# real work: drop high-null cols, median/mode impute, one-hot encode categoricals
# ... then split and persist
train_df.to_parquet(f"{output_dir}/train.parquet")
test_df.to_parquet(f"{output_dir}/test.parquet")

print("::RESULT:: " + json.dumps({
    "trainPath": ..., "testPath": ..., "targetColumn": target,
    "rows": len(df), "features": list(X.columns),
    "checksum": hashlib.sha256(open(train_path,'rb').read()).hexdigest(),
}), flush=True)
```

The `checksum` matters: it's what makes the idempotency short-circuit in
`executors.ts` meaningful instead of decorative.

**5. Rewrite `train.py`.** Read `trainPath` from the upstream output, fit a real
model, print **real** per-iteration progress, save with `joblib`:

```python
model = {
  "logreg":       LogisticRegression(max_iter=epochs),
  "randomforest": RandomForestClassifier(n_estimators=epochs),
}[ctx.get("modelType", "randomforest")]

for i, chunk in enumerate(iterations):     # or use warm_start for real epoch logs
    ...
    print(f"[train] iter {i}/{n} train_score={score:.4f}", flush=True)

joblib.dump(model, weights_path)
print("::RESULT:: " + json.dumps({
    "weightsPath": weights_path, "modelType": ..., "trainScore": ...,
    "featureNames": ..., "checksum": sha256_of(weights_path),
}), flush=True)
```

Keep printing a line per iteration — the live log drawer in the UI is one of the
best parts of the demo and it should be showing real numbers.

**6. Rewrite `evaluate.py`.** Load the model and the *held-out* test split,
predict, compute real metrics:

```python
model = joblib.load(ctx["weightsPath"])
test  = pd.read_parquet(ctx["testPath"])
pred  = model.predict(test.drop(columns=[target]))
print("::RESULT:: " + json.dumps({
    "accuracy": float(accuracy_score(y, pred)),
    "f1":       float(f1_score(y, pred, average="weighted")),
    "confusionMatrix": confusion_matrix(y, pred).tolist(),
    "n_test": len(test),
}), flush=True)
```

Now the existing `minAccuracy` gate in `executors.ts` (`modelEvaluate` throws
`UnrecoverableError` when `output.accuracy < config.minAccuracy`) becomes a real
quality gate instead of theatre. Set `minAccuracy: 0.95` in the UI and watch the
run legitimately fail — that's a *great* demo moment.

**7. Fix `kaggle.download`.** Two options, pick one:
- **Simple:** rename the node type to `data.source` and have it copy/validate a
  local or URL-fetched CSV. Honest and always works.
- **Faithful:** keep the Kaggle CLI shell-out, add `kaggle` to
  `requirements.txt`, and make it fall back to the bundled CSV with a clear
  warning log when `KAGGLE_USERNAME`/`KAGGLE_KEY` aren't set.

Either way, **stop shipping a step that shells out to a binary that isn't
installed.** If you rename the type, update `NODE_TYPES`, the executor registry
(TypeScript will force you to — that's the discriminated union doing its job),
`queueForType`, and the web palette.

**8. Widen the config schemas** in `packages/contracts/src/node-types.ts` so the
new knobs are user-editable: `targetColumn`, `testSize`, `modelType`,
`csvPath`. Add matching fields to `NODE_CONFIG_FIELDS` in `ConfigPanel.tsx`. If
you add a numeric field, add its key to `NUMERIC_CONFIG_KEYS` in
`apps/web/src/store/graphSlice.ts` or it'll be sent as a string and rejected.

**9. Wire the data through with templates.** The context-resolver already
supports this — set the starter graph's configs to:

```
preprocess.csvPath   = "python/data/titanic.csv"
train.trainPath      = "{{ nodes.node-2.output.trainPath }}"
evaluate.weightsPath = "{{ nodes.node-3.output.weightsPath }}"
evaluate.testPath    = "{{ nodes.node-2.output.testPath }}"
```

Any field you want to carry a template **must exist on the Zod config schema** —
`z.object()` silently strips unknown keys, which is exactly the bug that made
`registry.deploy` permanently broken.

### Done when

- [ ] Changing `targetColumn` or `modelType` in the UI produces a **different**
      accuracy on the next run.
- [ ] The log drawer shows real, non-monotonic training scores.
- [ ] Setting `minAccuracy: 0.99` fails the run; `0.5` passes it.
- [ ] Re-running the same version short-circuits on the artifact cache and
      finishes noticeably faster.
- [ ] `docker compose build worker` succeeds and the image is < 1.5 GB.

---

## A2 — Commit the migration history

> **Goal:** a fresh clone can build the database deterministically.
>
> **Why:** `packages/db/prisma/migrations/` is in `.gitignore`. The Docker
> `migrate` service runs `prisma migrate deploy`, which **requires** committed
> migration files — so today it's either a no-op or the schema is being
> reconstructed by accident. "Reproducible schema" is currently asserted, not true.
>
> **Effort:** small — one session.

### Steps

1. Remove `packages/db/prisma/migrations/` from `.gitignore`.
2. Against a **clean** database:
   ```bash
   docker compose -f infra/docker-compose.yml down -v
   docker compose -f infra/docker-compose.yml up -d postgres
   pnpm --filter @dag/db exec prisma migrate dev --name init
   ```
3. Commit the generated `migrations/` directory **and** `migration_lock.toml`.
4. Verify the full cold path:
   ```bash
   docker compose -f infra/docker-compose.yml down -v
   docker compose -f infra/docker-compose.yml up -d --build --scale worker=4
   ```
   The `migrate` one-shot must exit 0 and the API must come up healthy.
5. From here on: schema changes go `migrate dev` locally → commit → `migrate
   deploy` in CI. Never `db push` against anything but a scratch DB.

### Done when

- [ ] `down -v` then `up --build` produces a working stack with zero manual steps.
- [ ] `git ls-files packages/db/prisma/migrations` is non-empty.

---

## A3 — Authentication and endpoint protection

> **Goal:** `tenantId` comes from a verified credential, not a request body field
> anyone can type.
>
> **Why:** today any caller can pass any `tenantId`, run any workflow, and read
> `/metrics` (which leaks queue depth and worker counts). This is the difference
> between "demo" and "would be irresponsible to deploy."
>
> **Effort:** medium — one to two sessions.

### Files

```
packages/db/prisma/schema.prisma      (ApiKey model)
apps/api/src/middleware/auth.ts       (new)
apps/api/src/app.ts                   (mount it)
apps/api/src/routes/*.routes.ts       (read req.tenantId, drop body tenantId)
apps/web/src/api/client.ts            (send the header)
```

### Steps

**1. Add an `ApiKey` model** — store a hash, never the key:

```prisma
model ApiKey {
  id        String   @id @default(cuid())
  tenantId  String
  name      String
  hash      String   @unique   // sha256 of the raw key
  createdAt DateTime @default(now())
  revokedAt DateTime?
  tenant    Tenant   @relation(fields: [tenantId], references: [id])
}
```

**2. Write `apps/api/src/middleware/auth.ts`:**

```ts
export async function requireApiKey(req, res, next) {
  const raw = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!raw) return next(new UnauthorizedError('Missing API key'));
  const hash = createHash('sha256').update(raw).digest('hex');
  const key = await prisma.apiKey.findFirst({ where: { hash, revokedAt: null } });
  if (!key) return next(new UnauthorizedError('Invalid API key'));
  req.tenantId = key.tenantId;          // augment Express.Request in a .d.ts
  next();
}
```

Add an `UnauthorizedError` to `apps/api/src/errors.ts` and a `401` branch in
`middleware/errorHandler.ts` — follow the existing pattern exactly.

**3. Stop trusting the body.** Delete `tenantId` from `CreateWorkflowBody` in
`workflow.routes.ts` and pass `req.tenantId` into `createWorkflowService`. Every
read path (`getRunService`, `createVersionService`) must filter by the
authenticated tenant, not just look up by id — otherwise a leaked run id is a
cross-tenant read.

**4. Protect `/metrics`** with a separate shared secret
(`METRICS_TOKEN` env var), because Prometheus scrapes with a static bearer token,
not an API key. Better still, bind it to an internal-only port.

**5. Frontend.** Add `VITE_API_KEY` to `apps/web/.env.local` and send
`Authorization: Bearer ${key}` from `request()` in `client.ts`.
`openRunEventStream` is the catch — **`EventSource` cannot send custom headers.**
Two options:
- pass a short-lived signed token as a query param: `/runs/:id/events?token=...`
- or swap `EventSource` for `fetch()` + `ReadableStream` and parse SSE manually
  (more code, but keeps auth uniform and you control reconnection).

**6. Seed a dev key** in a `packages/db/prisma/seed.ts` so `docker compose up`
still gives a working demo out of the box.

### Done when

- [ ] `curl -X POST localhost:3001/workflows` with no header → `401`.
- [ ] A key for tenant A cannot read tenant B's run by id → `404`.
- [ ] `GET /metrics` without the metrics token → `401`.
- [ ] The editor still works end-to-end, live SSE included.

---

## A4 — An honest scaling benchmark

> **Goal:** the README's headline claim matches the data.
>
> **Why:** `benchmarks/phase-12-scale-test.md` shows 1→4 workers = **1.12×**
> throughput, with p95 latency getting **4× worse** (908 ms → 4097 ms). That's
> four processes fighting over one machine's CPU, which the doc admits in §7 —
> but the README still opens with "the horizontal-scaling claim, observable
> directly." One skeptical reader with the benchmark file open undoes the pitch.
>
> **Effort:** medium — mostly infrastructure fiddling, one session plus cloud time.

### Steps

**Option 1 — prove it (better).**

1. Provision 3 small cloud VMs: one running `postgres` + `redis` + `api`, two
   running workers only.
2. On the worker hosts, point at the shared infra — this needs **no code change**:
   ```bash
   DATABASE_URL=postgresql://dag:...@<infra-host>:5432/dag_engine \
   REDIS_URL=redis://<infra-host>:6379 \
   docker compose -f infra/docker-compose.yml up -d worker --scale worker=2
   ```
3. Make the workload **I/O-bound, not CPU-bound.** The current scale-test spawns
   a Python process per node, so it measures process-spawn contention. Add a
   `--io-bound` mode to `apps/api/scripts/scale-test.ts` that uses a node type
   whose executor sleeps on a network call. That's what real pipelines look like.
4. Re-run at 1 / 2 / 4 / 8 workers across hosts, regenerate the benchmark table.
5. Update the README with the real numbers and a one-line note on where it
   stops being linear and why (Postgres connection pool, Redis round-trips).

**Option 2 — re-frame it (cheaper, still honest).**

Rewrite the README claim to what's actually demonstrated: *"correct, race-free
dispatch across N worker processes pulling from a shared queue — verified by the
integration suite and the scale harness. Multi-machine throughput scaling is
untested; the current numbers reflect CPU contention on a single dev host."*
Keep the benchmark file and link to it.

**Do one of these.** Leaving the mismatch is the worst outcome.

### Done when

- [ ] The README's scaling claim and `benchmarks/*.md` tell the same story.
- [ ] `KNOWN_LIMITATIONS.md` §7 is deleted (Option 1) or rewritten (Option 2).

---

## A5 — Clear the lint backlog

> **Goal:** `pnpm -r lint` is green so CI can catch regressions.
>
> **Why:** ~30 pre-existing errors in `apps/api` and `apps/worker` (mostly
> `@typescript-eslint/no-explicit-any`) mean lint failures are background noise —
> a real new error hides among them.
>
> **Effort:** small–medium, tedious but mechanical. One session.

### Steps

1. `pnpm -r lint 2>&1 | tee /tmp/lint.txt` and group by rule.
2. Fix the `any`s with real types. The orchestrator is the worst offender —
   `getGraphFromVersion(version: any)` should take
   `Prisma.WorkflowVersionGetPayload<{}>`; `emitAndLog(..., payload: any)` should
   take `Record<string, unknown>`; `onNodeSucceeded(runId, nodeKey, output: any)`
   should take `unknown` and narrow.
3. Delete unused imports rather than adding disable comments.
4. Where an `any` is genuinely unavoidable (Prisma `InputJsonValue` casts), use a
   **targeted** `// eslint-disable-next-line` with a one-line reason.
5. Add a CI workflow (`.github/workflows/ci.yml`) running
   `pnpm -r typecheck && pnpm -r lint && pnpm -r test` on every PR, so it can
   never drift again.

### Done when

- [ ] `pnpm -r lint` exits 0.
- [ ] CI runs on PRs and is required to pass before merge.

---

# Track B — Engine features

These are the capabilities the "alternative to Airflow / Step Functions" framing
implies but that don't exist yet. Each one is a genuinely interesting design
problem, and each fits the existing architecture without rewriting it.

## B1 — Conditional edges

> **Goal:** "if accuracy > 0.9 deploy, otherwise retrain" — branches that
> activate based on runtime data.
>
> **Why:** every node currently runs if its parents succeeded. That's a
> *dependency* graph, not a *control-flow* graph. Conditionals are the single
> most-requested workflow feature and the cheapest big win here.
>
> **Effort:** medium. One to two sessions.

### Files

```
packages/contracts/src/graph.ts          (EdgeDef.condition)
apps/api/src/condition-evaluator.ts      (new)
apps/api/src/services/orchestrator.service.ts  (onNodeSucceeded)
apps/web/src/components/ConfigPanel.tsx  (edge inspector)
apps/web/src/App.tsx                     (render conditional edges differently)
```

### Steps

**1. Extend `EdgeDefSchema`:**

```ts
export const EdgeDefSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  condition: z.object({
    left:  z.string(),                                   // "{{ nodes.eval.output.accuracy }}"
    op:    z.enum(['eq','ne','gt','gte','lt','lte','in','contains']),
    right: z.union([z.string(), z.number(), z.boolean(), z.array(z.unknown())]),
  }).optional(),
});
```

Keep it a **structured object, not an expression string.** No `eval`, no
expression parser, no injection surface, and the UI can render it as three
inputs. This is the right trade for a portfolio project.

**2. Write `condition-evaluator.ts`.** Reuse `resolveNodeInputs`'s existing
`walkAndResolve` to turn `left` into a value, then apply `op`. Return `boolean`.
Unresolved reference → throw, same as the context-resolver does (never silently
false — a silent false skips a branch and looks like a bug in the user's graph).

**3. This is the subtle part — teach `onNodeSucceeded` about false branches.**
Today it decrements in-degree for every child. Now:

```ts
for (const childKey of children) {
  const edge = graph.edges.find(e => e.from === nodeKey && e.to === childKey)!;
  const active = !edge.condition || evaluateCondition(edge.condition, nodeRunMap, nodeKey);

  // Decrement regardless — the child's in-degree must reach zero either way,
  // or a skipped branch leaves the whole downstream subgraph hanging forever.
  const ready = await decrementInDegree(runId, childKey);

  if (!active) {
    await markBranchSkipped(runId, childKey, graph);   // BFS, same shape as onNodeFailed
    continue;
  }
  if (ready) await dispatchNode(runId, childKey, graph, version.id);
}
```

**The trap:** a node with two parents where one branch is skipped. If you skip
the *child* outright you break diamond joins. Decide the semantics and write it
down in `decisions_log.md`:
- **"any active parent"** (recommended) — the child runs if at least one incoming
  edge was active; skip it only when *every* parent edge evaluated false.
- **"all parents"** — stricter, simpler, but breaks the common
  if/else-then-rejoin pattern.

Implement "any active parent" by tracking a Redis set
`run:{id}:activeParents:{childKey}` alongside the in-degree hash, and only
skipping when in-degree hits zero with that set empty.

**4. UI.** Click an edge → the config panel shows the condition builder (you
already have persistent edge selection from PR #2 — this is what it was for).
Render conditional edges dashed with the condition as an edge label, and colour
them once a run resolves them.

**5. Tests.** Add `apps/api/src/integration/conditional-branch.integration.test.ts`
covering: true branch runs / false branch skipped; diamond re-join; unresolved
reference fails the run cleanly.

### Done when

- [ ] A graph with `accuracy > 0.9 → deploy` and `accuracy <= 0.9 → retrain`
      takes exactly one branch, and the other reports `SKIPPED`.
- [ ] A diamond (A→B→D, A→C→D with C's edge false) still runs D.
- [ ] The run reaches a terminal state — no hangs.

---

## B2 — Scheduled and event-triggered runs

> **Goal:** "run this every day at 02:00 UTC" and "run this when a webhook fires."
>
> **Why:** runs can only be started by an explicit `POST /runs`. A workflow engine
> nobody has to babysit is the entire point of the category.
>
> **Effort:** medium. One to two sessions.

### Steps

**1. Schema:**

```prisma
model Schedule {
  id                String   @id @default(cuid())
  workflowVersionId String
  cron              String            // "0 2 * * *"
  timezone          String   @default("UTC")
  enabled           Boolean  @default(true)
  lastFiredAt       DateTime?
  nextFireAt        DateTime?
  workflowVersion   WorkflowVersion @relation(...)
  @@index([enabled, nextFireAt])
}
```

**2. Use BullMQ's repeatable jobs, not a bespoke loop.** You already run Redis
and BullMQ; a `Queue` with `repeat: { pattern: cron, tz }` gives you persistence,
survival across API restarts, and no duplicate fires from multiple API replicas —
all things a hand-rolled `setInterval` gets wrong. Add a `scheduler` queue and a
small worker in the API process that calls `startRun`.

**3. Idempotency is the safety net.** Derive the key from the fire time:
`idempotencyKey = ${scheduleId}:${plannedFireTimeISO}`. `createRun` already
returns the existing run when the key matches, so a scheduler restart mid-fire
can never double-start. This is why that field exists — use it.

**4. Webhook triggers:** `POST /triggers/:token` → validate an HMAC signature →
look up the registered `workflowVersionId` → `startRun` with
`idempotencyKey = sha256(rawBody)`. Reject replays for free.

**5. Routes:** `POST/GET/PATCH/DELETE /workflows/:id/schedules`.
**UI:** a "Schedules" tab; show `nextFireAt` and last outcome.

### Done when

- [ ] A `* * * * *` schedule fires once a minute, exactly once, with the API
      restarted mid-window.
- [ ] Deleting a schedule removes the BullMQ repeatable job.
- [ ] The same webhook body posted twice creates one run.

---

## B3 — Dynamic fan-out (map / reduce)

> **Goal:** a node's output determines how many downstream nodes run — "process
> each of the 100 chunks in parallel, then merge."
>
> **Why:** this is *the* data-pipeline pattern, and the biggest reason someone
> reaches for a workflow engine over a bash script. It's also the largest
> surface-area change here — schema, orchestrator, UI, and events all move.
>
> **Effort:** large. Two to three sessions. Do B1 first — you'll reuse the
> branch-skipping machinery.

### Steps

**1. Schema:**

```prisma
model Run {
  parentRunId String?
  fanOutIndex Int?
  parent      Run?  @relation("RunTree", fields: [parentRunId], references: [id])
  children    Run[] @relation("RunTree")
}
```

**2. Node types:** add `flow.map` (declares `overSource:
"{{ nodes.split.output.chunks }}"` and a `subgraph` of node keys) and
`flow.reduce` (a join that waits for all children).

**3. Orchestrator — the spawn path.** In `onNodeSucceeded`, when the completed
node is a `flow.map`:
- read the array from its output (cap the length — a 100k-element array must be
  rejected, not attempted);
- for each element `i`: `createRun(versionId, 'fanout', subgraphKeys, key)` with
  `parentRunId` and `fanOutIndex = i`, seed its in-degrees, dispatch its roots;
- do **not** decrement the reduce node's in-degree yet.

**4. The join.** When a child run reaches a terminal state, check
`SELECT count(*) FROM "Run" WHERE parentRunId = ? AND status NOT IN (terminal)`.
When it's zero, aggregate the children's outputs into the reduce node's input and
decrement its in-degree through the normal atomic path. Do the count-and-decrement
in a **transaction or a Lua script** — N children finishing simultaneously is
exactly the race the rest of the system is careful about, and this is the easiest
place to reintroduce it.

**5. Events + UI.** `RUN_SPAWNED` / `RUN_CHILD_COMPLETED`. Render the map node
with a progress pill (`23 / 100`) rather than trying to draw 100 nodes on the
canvas. Clicking it drills into a child-run list.

**6. Cancellation and failure must cascade** to child runs — wire this into
`cancelRunService` and `onNodeFailed` at the same time, not later.

### Done when

- [ ] A 10-element fan-out produces 10 child runs that execute in parallel across
      workers (different `workerId`s in the timeline).
- [ ] The reduce node runs exactly once, after all 10.
- [ ] One child failing fails the parent run and skips the reduce node.
- [ ] Cancelling the parent cancels all children.

---

## B4 — Cancellation that actually stops work

> **Goal:** cancel stops in-flight jobs, not just queued ones.
>
> **Why:** `cancelRunService` already removes waiting/delayed jobs from all three
> queues (better than the stale "Phase 6 will add" comment above it suggests) —
> but a job a worker has **already picked up** keeps running to completion. Cancel
> a 4-hour training job and it keeps burning the GPU for 4 hours.
>
> **Effort:** small–medium. One session.

### Steps

1. On cancel, set a Redis flag: `SET run:{runId}:cancelled 1 EX 86400`.
2. In `apps/worker/src/worker.ts`, check it before dispatching to the executor
   and bail early with a `CANCELLED` transition.
3. For long executors, pass an `AbortSignal` through `ExecutorContext`. The
   heartbeat interval in `startHeartbeat` already ticks every 15 s — piggyback the
   cancel check on it and abort the signal.
4. In `python-bridge.ts`, wire the signal to the same process-group kill the
   timeout watchdog already uses: `process.kill(-child.pid, 'SIGKILL')`.
5. Delete the misleading "Phase 6 will implement" comments in `run.service.ts` —
   they describe code that's already there.

### Done when

- [ ] Cancelling a run with a node mid-execution kills the Python process within
      ~15 s.
- [ ] The `NodeRun` lands on `CANCELLED`, not `FAILED`.

---

## B5 — Make `retryPolicy` real

> **Goal:** per-node retry configuration.
>
> **Why:** `RetryPolicySchema` (attempts / baseDelay / cap) is defined in
> `packages/contracts/src/node-types.ts` and referenced on `NodeDefBaseSchema` —
> and used **nowhere**. `grep -rn retryPolicy` returns exactly one hit: its own
> definition. Every node silently uses the global `attempts: 3` from
> `queues.ts`. Dead schema is worse than no schema; it implies a feature that
> doesn't exist.
>
> **Effort:** small. One session.

### Steps

1. In `dispatchNode`, pass the node's policy into the job options:
   ```ts
   await queue.add(node.type, payload, {
     jobId,
     attempts: node.retryPolicy?.attempts ?? 3,
     backoff: { type: 'exponentialJitter', delay: node.retryPolicy?.baseDelay ?? 2000 },
   });
   ```
2. Thread `cap` into `exponentialJitter` in `apps/worker/src/backoff.ts` (it
   currently has no ceiling).
3. Add the three fields to the config panel under an "Advanced" disclosure.
4. Distinguish retryable from terminal failures consistently. The pattern already
   exists (`UnrecoverableError` in `python-bridge.ts` for `SyntaxError` /
   `ModuleNotFoundError`, and in `kaggleDownload` for `403`) — extend it and
   surface the classification in `NodeRun.error.taxonomy` so the UI can say
   *"failed permanently"* vs *"failed after 3 attempts."*

### Done when

- [ ] A node with `attempts: 1` fails immediately; `attempts: 5` retries 4 times.
- [ ] The UI shows attempt count and whether the error was retryable.

---

# Track C — Production hardening

## C1 — Object storage for artifacts

> **Goal:** artifacts survive workers being on different physical machines.
>
> **Why:** workers share a Docker named volume (`artifact_data` at
> `/data/artifacts`). That works on one host. On Kubernetes, `preprocess` on node
> A writes a file that `train` on node B simply cannot see — and it fails in a
> confusing way, not a loud one. This blocks C3 entirely.
>
> **Effort:** medium. One to two sessions.

### Steps

1. Add MinIO to `infra/docker-compose.yml` (S3-compatible, runs locally, so the
   dev experience doesn't need a cloud account).
2. Create `apps/worker/src/artifact-store.ts` with a narrow interface —
   `put(key, stream)`, `get(key)`, `exists(key)`, `presignedUrl(key)` — and two
   implementations: `FsArtifactStore` (current behaviour) and `S3ArtifactStore`.
   Select via `ARTIFACT_BACKEND=fs|s3`. Keeping `fs` working means tests don't
   need MinIO.
3. Refactor the five executors to go through the interface. The idempotency
   checks (`fs.existsSync(resultPath)`) become `await store.exists(key)` — same
   logic, different backend.
4. For Python, the simplest correct approach: the **Node executor** downloads
   inputs to a temp dir before spawning and uploads outputs after. Python stays
   backend-agnostic and testable in isolation. Don't put boto3 in the scripts.
5. Store the S3 key (not a local path) in `NodeRun.output` so the UI can render a
   presigned download link.

### Done when

- [ ] `ARTIFACT_BACKEND=s3` runs the full pipeline against MinIO.
- [ ] `ARTIFACT_BACKEND=fs` still passes the existing integration suite.
- [ ] The run detail view offers a download link per artifact.

---

## C2 — Real multi-tenant isolation

> **Goal:** a bug in one service function cannot leak another tenant's data.
>
> **Why:** `tenantId` is a column. There's no row-level security, Redis keys
> (`run:{runId}:indegree`) aren't namespaced, and the per-run concurrency
> semaphore isn't tenant-scoped — so one tenant's fan-out can consume the whole
> cluster's capacity. Requires A3 (an authenticated tenant) first.
>
> **Effort:** medium–large. Two sessions.

### Steps

1. **Postgres RLS.** Enable on `Workflow`, `Run`, `NodeRun`, `RunEvent`:
   ```sql
   ALTER TABLE "Workflow" ENABLE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON "Workflow"
     USING ("tenantId" = current_setting('app.tenant_id', true));
   ```
   Set `app.tenant_id` per transaction via Prisma middleware. Costs one extra
   round-trip per transaction — measure it, and note the number in
   `decisions_log.md`.
2. **Namespace Redis keys:** `{tenantId}:run:{runId}:indegree`. Touches
   `packages/queue/src/lua.ts` and `semaphore.ts`.
3. **Per-tenant concurrency quota:** a second semaphore keyed by tenant, checked
   in `dispatchNode` before enqueueing. Over quota → leave the node `PENDING` and
   retry on the next parent completion (or a periodic sweep).
4. **Test the isolation, don't assume it.** Add an integration test that
   deliberately queries with the wrong tenant context and asserts zero rows.

### Done when

- [ ] A raw `SELECT * FROM "Run"` under tenant A's session returns only A's rows.
- [ ] Tenant A saturating its quota does not delay tenant B's runs.
- [ ] `KNOWN_LIMITATIONS.md` §1 can be deleted.

---

## C3 — Kubernetes + queue-driven autoscaling

> **Goal:** workers scale automatically with queue depth, across real machines.
>
> **Why:** this is what makes the "distributed, horizontally scalable" claim
> genuinely true, and it's the deployment story that makes the project look like
> infrastructure rather than a demo. Needs C1 (shared artifact storage) first.
>
> **Effort:** large. Two to three sessions, mostly YAML and debugging.

### Steps

1. Write `infra/k8s/`: `Deployment` for api and worker, `StatefulSet` (or managed
   services) for postgres and redis, `Service` + `Ingress`, `ConfigMap` +
   `Secret`, and a `Job` for migrations with an init-container gate.
2. Install [KEDA](https://keda.sh) and add a `ScaledObject` targeting Redis list
   length:
   ```yaml
   triggers:
     - type: redis
       metadata: { listName: "bull:cpu:wait", listLength: "20" }
   ```
   `minReplicaCount: 1`, `maxReplicaCount: 20`.
3. **Graceful shutdown already works** — `worker.close()` on SIGTERM drains
   in-flight jobs. Set `terminationGracePeriodSeconds` above your longest node
   timeout, or KEDA will kill mid-training jobs on scale-down.
4. Add `/health/live` and `/health/ready` (readiness must check Postgres *and*
   Redis, not just "process is up").
5. Re-run the A4 benchmark here. This is where you get the real scaling curve.

### Done when

- [ ] `kubectl apply -k infra/k8s` brings up a working cluster.
- [ ] Submitting 500 runs scales workers 1 → 10 automatically, then back down.
- [ ] Scale-down never kills a running node.

---

## C4 — Observability

> **Goal:** you can answer "why was it slow at 3am" without SSH.
>
> **Why:** `apps/api/src/metrics.ts` already emits the right metrics
> (`dag_node_duration_seconds`, `dag_node_runs_by_status`, queue depth). Nothing
> consumes them. The instrumentation is done; the payoff isn't collected.
>
> **Effort:** small–medium. One session.

### Steps

1. Add Prometheus + Grafana to compose (and a `ServiceMonitor` for k8s).
2. Commit a provisioned dashboard JSON in `infra/grafana/`: throughput, queue
   depth by type, p50/p95/p99 node duration by node type, success/failure rate,
   active workers.
3. Add alert rules: queue depth > N for > 5 min; failure rate > 10%; no completed
   nodes in 15 min while queue is non-empty (a stuck cluster).
4. Add OpenTelemetry tracing with the run id as trace id — one trace spanning
   API dispatch → queue wait → worker execution → Python subprocess is a genuinely
   impressive thing to show, and the run id already threads through everything.
5. Screenshot the dashboard into the README.

### Done when

- [ ] A load run produces a dashboard that visibly tells the story.
- [ ] Killing all workers fires the stuck-cluster alert.

---

# Track D — Product and UX

Can be done in parallel with Track B. Individually small; collectively they're
the difference between "a demo" and "an app."

## D1 — Workflow management

> **Why:** the editor handles exactly one workflow, named `'My Pipeline'`
> (hardcoded in `handleSave`), with no way to list, open, rename, or delete.
> Reload the page and your work is gone.
>
> **Effort:** medium. One to two sessions.

### Steps

1. **API:** `GET /workflows` (paginated, tenant-scoped), `GET /workflows/:id`
   (with versions), `PATCH /workflows/:id` (rename), `DELETE /workflows/:id`
   (soft delete — `deletedAt`, because runs reference versions),
   `GET /workflows/:id/versions`.
2. **Web:** a workflow list view; name field in the header (inline edit, not a
   prompt); "New workflow"; open loads the graph via `fromGraph()` — the inverse
   of the existing `toGraph()`, which you'll need to write.
3. **Version history:** a dropdown to view/restore an earlier version. The data
   is already there and immutable — this is nearly free and demos beautifully.
4. Persist the current workflow id in `localStorage` so a reload resumes.

### Done when

- [ ] Create, name, save, close, reopen, and edit a workflow across a page reload.
- [ ] Restoring version 3 while version 7 is current creates version 8.

## D2 — Server-backed run history

> **Why:** `RunHistory` reconstructs the list from whatever the current tab
> happened to observe (see the note at the top of `RunHistory.tsx`). Reload and
> your history is empty — but the runs are all in Postgres.
>
> **Effort:** small. Half a session.

### Steps

1. Add `GET /workflows/:id/runs?limit=&cursor=` returning runs newest-first with
   summary counts. Add `@@index([workflowVersionId, startedAt])` to support it.
2. Replace the client-side `runs` array with a fetch on panel open; keep the
   Zustand store as a live-update cache layered on top.
3. Add filters (status, date) and a link to the full run detail.
4. Delete the stale "there is no such endpoint" comment block from
   `RunHistory.tsx` once it's true.

### Done when

- [ ] Reload the page → run history still lists every past run.
- [ ] Pagination works past 50 runs.

## D3 — Editor polish

> **Effort:** small, incremental. Do these opportunistically.

- **Live validation panel** — run `validateGraphForSave` continuously and show a
  dismissible list of problems (missing config, orphan nodes, unreachable nodes)
  instead of only erroring on save.
- **Minimap** for large graphs (`<MiniMap />` from React Flow, ~3 lines).
- **Auto-layout** button — `dagre` or `elkjs` to tidy a messy graph. High
  wow-per-line-of-code.
- **Copy/paste and duplicate** nodes (Ctrl+C/V/D) — hook into the undo history
  you already built.
- **Node search** (Ctrl+K) for large graphs.
- **Export/import JSON** — the graph contract is already the file format.
- **Run comparison** — two runs side by side in the Gantt view.
- **Empty state** — when the canvas is cleared, offer "start from a template."

---

# Suggested order

If you want a single linear list:

| # | Phase | Why here |
|---|---|---|
| 1 | **A1** Real executors | Everything else is decoration until this is done |
| 2 | **A2** Migrations | Tiny; unblocks reliable cold starts for all later work |
| 3 | **A5** Lint + CI | Cheap; makes every subsequent PR safer |
| 4 | **A3** Auth | Gates C2; also the most common interview question |
| 5 | **D1** Workflow management | Biggest perceived-quality jump per hour |
| 6 | **B1** Conditional edges | Best feature-to-effort ratio in the whole list |
| 7 | **A4** Honest benchmark | Do it once B1/A1 make the workload realistic |
| 8 | **B5** Retry policy | Small; removes a dead schema |
| 9 | **B4** Hard cancel | Small; pairs naturally with B5 |
| 10 | **D2** Server run history | Small; completes the D1 story |
| 11 | **B2** Scheduling | The "it runs itself" moment |
| 12 | **C1** Object storage | Blocks C3 |
| 13 | **B3** Dynamic fan-out | Biggest engine feature; do it when the base is solid |
| 14 | **C2** Tenant isolation | Needs A3 |
| 15 | **C3** Kubernetes + KEDA | Needs C1 |
| 16 | **C4** Observability | Best done once there's real load to observe |
| — | **D3** Editor polish | Sprinkle throughout |

**If you only do three:** A1, D1, B1. Real work, a real app around it, and one
feature that proves the engine is extensible.

---

## Keeping the docs honest

After each phase:

1. Append to [`updates.md`](./updates.md) — symptom, cause, fix, files.
2. Delete or rewrite the matching `KNOWN_LIMITATIONS.md` section.
3. Record any non-obvious trade-off in [`decisions_log.md`](./decisions_log.md).
4. Update the README if a headline claim changed.

The self-audit in `KNOWN_LIMITATIONS.md` is one of this project's best signals —
being able to name your own gaps reads as senior. Losing that by letting it go
stale would cost more than any single feature adds.
