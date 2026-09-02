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

1. **One phase per PR.** Phases are sized to fit a single working session. Where
   a piece of work is genuinely bigger than that, it's split into numbered parts
   (`A1.1`, `A1.2`, …). **Every part is independently shippable**: it leaves
   `main` green, the pipeline runnable, and the app usable. None of them is
   "part 1 of 3 that doesn't compile yet." If you only ever finish the first part
   of a split phase, the project is still better than it was.
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
Track A (credibility)  A1.1─A1.2─A1.3─A1.4─A1.5 ─ A2 ─ A3 ─ A4 ─ A5
                        │                          │
Track B (engine)        └─ B1.1─B1.2 ─ B2 ─ B4 ─ B5│
                              │                    │
                              └─ B3.1─B3.2─B3.3─B3.4─B3.5
                                                   │
Track C (production)        C1.1─C1.2 ─ C2.1─C2.2─C2.3 ─ C3.1─C3.2─C3.3 ─ C4
                                  │                        │
                                  └────────────────────────┘  (C1 gates C3)
Track D (product)      D1.1─D1.2─D1.3 ─ D2 ─ D3   ← can run in parallel with B
```

**A1 gates everything.** Until the executors do real work, every other phase is
polish on a system that doesn't do anything. But note that A1 is now five small
parts — you get real preprocessing shipped after part 2, and you can interleave
other tracks between the parts if you want variety.

### Session sizing at a glance

| Size | Meaning | Phases |
|---|---|---|
| **S** | Under a session; mostly mechanical | A2, B4, B5, D2, C1.1, C2.2, C2.3, B1.2, D1.3, A1.1 |
| **M** | One focused session | A1.2, A1.3, A1.4, A1.5, A3, A4, A5, B1.1, B2, B3.1, B3.2, B3.3, B3.4, B3.5, C1.2, C2.1, C3.1, C3.2, C3.3, C4, D1.1, D1.2 |
| **L** | Doesn't exist any more — everything got split | — |

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

Split into five parts. Each one ships on its own: after **A1.1** the image can
hold real libraries, after **A1.2** one node does real work, and so on. The
pipeline stays green throughout, because a node still running a stub simply
ignores the richer outputs upstream now produces.

| Part | What ships | Size |
|---|---|---|
| A1.1 | A Python runtime that can actually hold pandas/sklearn | S |
| A1.2 | Real preprocessing on a bundled dataset | M |
| A1.3 | Real training | M |
| A1.4 | Real evaluation + a working quality gate | M |
| A1.5 | An honest data source (fix `kaggle.download`) | M |

---

### A1.1 — A Python runtime that can hold real libraries

> **Size:** S. Do this first and alone — it's the part most likely to eat an
> afternoon in Docker build errors, and you do **not** want that tangled up with
> logic changes.

**Files:** `infra/Dockerfile.worker`, `apps/worker/python/requirements.txt` (new)

**Steps**

1. Add `apps/worker/python/requirements.txt`:
   ```
   pandas==2.2.*
   scikit-learn==1.5.*
   joblib==1.4.*
   pyarrow==17.*
   ```
   Start with scikit-learn, **not** PyTorch. `sklearn` is ~30 MB and trains a real
   model on tabular data in under a second; `torch` is 800 MB+ of wheels for the
   same demo value. (The node type is named `torch.train`, but that's just a
   string — see A1.5 for renaming.)

2. **Fix the base image.** The runtime stage is `node:22-alpine`, which is musl —
   there are no prebuilt pandas/sklearn wheels for it, so pip would try to compile
   from source and fail (or take 40 minutes). Switch the runtime stage to Debian slim:
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
   The venv avoids Debian's `externally-managed-environment` error. Setting `PATH`
   means `python-bridge.ts`'s `spawn('python3', ...)` picks up the venv
   interpreter with **no code change**.

3. Update the long comment at the top of `Dockerfile.worker` — it currently
   explains why the deps are deliberately *not* installed. That reasoning is now
   obsolete.

4. Rebuild and confirm nothing regressed:
   ```bash
   docker compose -f infra/docker-compose.yml build worker
   docker compose -f infra/docker-compose.yml up -d --scale worker=4 worker
   docker compose -f infra/docker-compose.yml exec worker \
     python3 -c "import pandas, sklearn, joblib; print('ok', pandas.__version__)"
   ```

**Done when**

- [ ] `import pandas, sklearn` succeeds inside the worker container.
- [ ] The existing stub pipeline still runs green end-to-end.
- [ ] The image is under ~1.5 GB (`docker images | grep worker`).

---

### A1.2 — Real preprocessing on a bundled dataset

> **Size:** M. After this, one node does genuine work and the outputs it emits
> become real. Train/evaluate stay stubs and simply ignore them, so the pipeline
> still finishes green.

**Files:** `apps/worker/python/data/titanic.csv` (new), `apps/worker/python/preprocess.py`,
`packages/contracts/src/node-types.ts`, `apps/web/src/components/ConfigPanel.tsx`,
`apps/web/src/store/graphSlice.ts`

**Steps**

1. **Commit a small dataset** to `apps/worker/python/data/`. Do *not* start with
   Kaggle — credentials and network turn a deterministic demo into a flaky one.
   Titanic (~60 KB) or something generated with `sklearn.datasets` is ideal.
   Kaggle becomes an optional *source* in A1.5.

2. **Rewrite `preprocess.py`.** Keep the stdio protocol exactly as-is — read one
   JSON line from stdin, print log lines, end with `::RESULT:: {json}`. The bridge
   depends on it:
   ```python
   ctx        = json.loads(sys.stdin.readline())
   csv_path   = ctx["csvPath"]
   target     = ctx.get("targetColumn", "Survived")
   test_size  = float(ctx.get("testSize", 0.2))
   output_dir = ctx["outputDir"]

   df = pd.read_csv(csv_path)
   print(f"[preprocess] loaded {len(df)} rows x {len(df.columns)} cols", flush=True)

   # real work: drop high-null columns, median/mode impute, one-hot encode
   # categoricals, then split
   train_df, test_df = train_test_split(df, test_size=test_size, random_state=42)
   train_df.to_parquet(f"{output_dir}/train.parquet")
   test_df.to_parquet(f"{output_dir}/test.parquet")

   print("::RESULT:: " + json.dumps({
       "trainPath": ..., "testPath": ..., "targetColumn": target,
       "rows": len(df), "features": list(X.columns),
       "checksum": sha256_of(train_path),
   }), flush=True)
   ```
   The `checksum` matters — it's what makes the idempotency short-circuit in
   `executors.ts` meaningful instead of decorative.

3. **Widen `PandasPreprocessConfigSchema`** with `csvPath`, `targetColumn`,
   `testSize`. Add matching entries to `NODE_CONFIG_FIELDS` in `ConfigPanel.tsx`.

4. **Numeric field gotcha:** add `testSize` to `NUMERIC_CONFIG_KEYS` in
   `apps/web/src/store/graphSlice.ts`, or it'll be sent as a string and rejected
   by Zod — the exact bug fixed for `minAccuracy` earlier.

5. Point the starter graph's preprocess node at `python/data/titanic.csv`.

**Done when**

- [ ] The log drawer shows the real row/column count of the CSV.
- [ ] Changing `targetColumn` or `testSize` changes the numbers in the output.
- [ ] The full pipeline still ends `SUCCEEDED` (train/evaluate still stubs).

---

### A1.3 — Real training

> **Size:** M. Evaluate stays a stub for one more part.

**Files:** `apps/worker/python/train.py`, `packages/contracts/src/node-types.ts`,
`apps/web/src/components/ConfigPanel.tsx`, `apps/web/src/store/graphSlice.ts`

**Steps**

1. **Rewrite `train.py`** to read `trainPath` from the upstream output, fit a real
   model, print **real** per-iteration progress, and save with `joblib`:
   ```python
   model = {
     "logreg":       LogisticRegression(max_iter=epochs),
     "randomforest": RandomForestClassifier(n_estimators=epochs, warm_start=True),
   }[ctx.get("modelType", "randomforest")]

   for i in range(1, epochs + 1):
       model.n_estimators = i          # warm_start gives genuine per-step logs
       model.fit(X_train, y_train)
       print(f"[train] iter {i}/{epochs} train_score={model.score(X_train, y_train):.4f}",
             flush=True)

   joblib.dump(model, weights_path)
   print("::RESULT:: " + json.dumps({
       "weightsPath": weights_path, "modelType": ..., "trainScore": ...,
       "featureNames": ..., "checksum": sha256_of(weights_path),
   }), flush=True)
   ```
   Keep printing a line per iteration — the live log drawer is one of the best
   parts of the demo and it should be showing real numbers.

2. **Widen `TorchTrainConfigSchema`** with `modelType` and `trainPath`. Add the
   fields to the config panel.

3. **Wire the template** in the starter graph:
   `trainPath = "{{ nodes.<preprocess-key>.output.trainPath }}"`.

   > Any field you want to carry a template **must exist on the Zod config
   > schema** — `z.object()` silently strips unknown keys, which is exactly the
   > bug that left `registry.deploy` permanently broken.

**Done when**

- [ ] The weights file is a real joblib pickle, not 11 bytes of `STUBWEIGHTS`.
- [ ] Switching `modelType` produces a different `trainScore`.
- [ ] Training scores in the log are non-monotonic (i.e. real, not `1/(i+1)`).

---

### A1.4 — Real evaluation and a working quality gate

> **Size:** M. This is the payoff — after this part the demo is honest.

**Files:** `apps/worker/python/evaluate.py`, `packages/contracts/src/node-types.ts`,
`apps/web/src/components/ConfigPanel.tsx`

**Steps**

1. **Rewrite `evaluate.py`** to load the model and the *held-out* test split:
   ```python
   model = joblib.load(ctx["weightsPath"])
   test  = pd.read_parquet(ctx["testPath"])
   y     = test[ctx["targetColumn"]]
   pred  = model.predict(test.drop(columns=[ctx["targetColumn"]]))
   print("::RESULT:: " + json.dumps({
       "accuracy": float(accuracy_score(y, pred)),
       "f1":       float(f1_score(y, pred, average="weighted")),
       "confusionMatrix": confusion_matrix(y, pred).tolist(),
       "n_test": len(test),
   }), flush=True)
   ```

2. **Add `weightsPath` and `testPath`** to `ModelEvaluateConfigSchema` and wire
   the templates in the starter graph.

3. The existing `minAccuracy` gate in `executors.ts` — which throws
   `UnrecoverableError` when `output.accuracy < config.minAccuracy` — now becomes
   a real quality gate instead of theatre.

4. Consider surfacing the confusion matrix in the run detail view. Small effort,
   very visible payoff.

**Done when**

- [ ] Accuracy changes when you change `modelType` or `targetColumn`.
- [ ] `minAccuracy: 0.99` legitimately fails the run; `0.5` passes.
      *(This is a great demo moment — a pipeline that fails for a real reason.)*
- [ ] Re-running the same version short-circuits on the artifact cache and
      finishes noticeably faster.

---

### A1.5 — An honest data source

> **Size:** M. Separate because it touches `NODE_TYPES` — the discriminated
> union — which ripples into the executor registry, `queueForType`, and the web
> palette. TypeScript will walk you through every site, but it deserves its own PR.

**Files:** `packages/contracts/src/node-types.ts`, `apps/worker/src/executors.ts`,
`packages/queue/src/queues.ts`, `apps/web/src/components/{NodePalette,CustomNode,ConfigPanel}.tsx`,
`apps/web/src/components/icons.tsx`

**The problem:** `kaggle.download` shells out to a `kaggle` binary that isn't
installed in the image. Stop shipping a step that can't work.

**Pick one:**

- **Simple (recommended).** Rename the type to `data.source` and have the
  executor validate/copy a local CSV or fetch one from a URL. Honest, always
  works, zero credentials.
- **Faithful.** Keep the Kaggle CLI shell-out, add `kaggle` to
  `requirements.txt`, and fall back to the bundled CSV with a clear warning log
  when `KAGGLE_USERNAME` / `KAGGLE_KEY` aren't set.

**If you rename:** update `NODE_TYPES`, the `ExecutorRegistry` (the compile error
is the discriminated union doing its job), `queueForType`, `NODE_ICON` /
`NODE_ACCENT` / `PALETTE_ITEMS` in the web app, and the starter graph in
`graphSlice.ts`.

**Done when**

- [ ] The first node does something real and deterministic with no external creds.
- [ ] `grep -rn "kaggle" --include=*.ts` has no dangling references.
- [ ] `KNOWN_LIMITATIONS.md` §6 can be rewritten or deleted.

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

Two parts: the engine (testable entirely through the API) and the UI.

| Part | What ships | Size |
|---|---|---|
| B1.1 | Conditions evaluated by the orchestrator | M |
| B1.2 | Condition builder in the edge inspector | S |

---

### B1.1 — Conditions in the engine

> **Size:** M. Shippable without any UI — you author conditions by POSTing a
> graph and verify with the integration suite.

**Files:** `packages/contracts/src/graph.ts`,
`apps/api/src/condition-evaluator.ts` (new),
`apps/api/src/services/orchestrator.service.ts`, `packages/queue/src/lua.ts`

**Steps**

1. **Extend `EdgeDefSchema`:**
   ```ts
   export const EdgeDefSchema = z.object({
     from: z.string().min(1),
     to: z.string().min(1),
     condition: z.object({
       left:  z.string(),      // "{{ nodes.eval.output.accuracy }}"
       op:    z.enum(['eq','ne','gt','gte','lt','lte','in','contains']),
       right: z.union([z.string(), z.number(), z.boolean(), z.array(z.unknown())]),
     }).optional(),
   });
   ```
   Keep it a **structured object, not an expression string.** No `eval`, no
   expression parser, no injection surface, and the UI can render it as three
   inputs. Right trade for this project.

2. **Write `condition-evaluator.ts`.** Reuse the context-resolver's existing
   `walkAndResolve` to turn `left` into a value, then apply `op`. An unresolved
   reference must **throw**, exactly as `resolveNodeInputs` does — never silently
   evaluate to false, because a silently skipped branch looks like a bug in the
   user's graph rather than a bug in their config.

3. **Decide the join semantics and write it down** in `decisions_log.md` before
   coding. This is the part that bites:
   - **"any active parent"** (recommended) — a child runs if at least one incoming
     edge was active; it's skipped only when *every* parent edge evaluated false.
     Supports the common if/else-then-rejoin diamond.
   - **"all parents"** — stricter and simpler, but breaks diamonds.

4. **Teach `onNodeSucceeded` about false branches.** Today it decrements
   in-degree for every child. Now:
   ```ts
   for (const childKey of children) {
     const edge = graph.edges.find(e => e.from === nodeKey && e.to === childKey)!;
     const active = !edge.condition
       || evaluateCondition(edge.condition, nodeRunMap, nodeKey);

     if (active) await markParentActive(runId, childKey);   // Redis SADD

     // Decrement REGARDLESS of the result — the child's in-degree must reach
     // zero either way, or a skipped branch leaves the whole downstream
     // subgraph hanging forever.
     const ready = await decrementInDegree(runId, childKey);

     if (ready) {
       if (await hasActiveParent(runId, childKey)) {
         await dispatchNode(runId, childKey, graph, version.id);
       } else {
         await markBranchSkipped(runId, childKey, graph);  // BFS, same shape as onNodeFailed
       }
     }
   }
   ```
   Implement "any active parent" with a Redis set
   `run:{id}:activeParents:{childKey}` alongside the in-degree hash. Give it the
   same TTL as the other run keys in `seedInDegrees`.

5. **Tests** — `apps/api/src/integration/conditional-branch.integration.test.ts`:
   true branch runs / false branch skipped; diamond re-join with one false edge;
   unresolved reference fails the run cleanly; a run with a skipped branch still
   reaches a terminal state.

**Done when**

- [ ] A graph with `accuracy > 0.9 → deploy` and `accuracy <= 0.9 → retrain`
      takes exactly one branch; the other reports `SKIPPED`.
- [ ] A diamond (A→B→D, A→C→D with C's edge false) still runs D.
- [ ] Every such run reaches a terminal state — no hangs.

---

### B1.2 — Condition builder in the UI

> **Size:** S. This is what the persistent edge selection from PR #2 was for.

**Files:** `apps/web/src/components/ConfigPanel.tsx`, `apps/web/src/App.tsx`,
`apps/web/src/store/graphSlice.ts`

**Steps**

1. When `selectedEdgeId` is set (and no node is selected), render an **edge
   inspector** in the config panel instead of the node form: a source→target
   header, three inputs (left / op / right), and a "Remove condition" button.
   Add `updateEdgeCondition(id, condition)` to the graph store.
2. Render conditional edges **dashed** with the condition as an edge label.
3. During a run, colour a resolved edge green (taken) or grey (skipped) using the
   node statuses already in the run store.
4. Add a "delete edge" button here too — `removeEdge` already exists in the store
   but has no UI.

**Done when**

- [ ] You can add, edit, and remove a condition without touching JSON.
- [ ] Conditional edges are visually distinct from unconditional ones.

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
> reaches for a workflow engine over a bash script.
>
> **Do B1 first** — you'll reuse the branch-skipping machinery and the
> "decrement regardless" discipline.

The largest feature here, split into five parts. B3.1 is purely additive;
B3.2 gives you working fan-out with a summary join; B3.3 adds real output
merging; B3.4 makes failure and cancellation correct; B3.5 is the UI.

| Part | What ships | Size |
|---|---|---|
| B3.1 | Run-tree schema + read paths (no behaviour change) | M |
| B3.2 | Spawn N child runs and join on a summary | M |
| B3.3 | Real output aggregation (`flow.reduce`) | M |
| B3.4 | Failure and cancellation cascade | M |
| B3.5 | Fan-out UI (progress pill + drill-in) | M |

---

### B3.1 — Run-tree schema and read paths

> **Size:** M. Purely additive — nothing behaves differently yet, which makes it
> a safe, boring PR to get the schema landed.

**Steps**

1. Extend `Run` in `schema.prisma`:
   ```prisma
   model Run {
     parentRunId String?
     fanOutIndex Int?
     parent      Run?  @relation("RunTree", fields: [parentRunId], references: [id])
     children    Run[] @relation("RunTree")
     @@index([parentRunId, status])
   }
   ```
2. `prisma migrate dev --name run-tree` (needs **A2** done first).
3. `GET /runs/:id` returns a `children` summary — `{ total, succeeded, failed, running }`
   — computed with a `groupBy`, not by loading every child row.
4. Add `GET /runs/:id/children?limit=&cursor=` for the drill-in view B3.5 needs.

**Done when**

- [ ] Migration applies cleanly on a fresh DB.
- [ ] Existing runs still work; `children` is an empty summary for all of them.

---

### B3.2 — Spawn child runs and join on a summary

> **Size:** M. After this, fan-out genuinely works — you just can't merge the
> children's *outputs* yet (that's B3.3). The downstream node receives a count
> summary, which is already useful.

**Steps**

1. **Add a `flow.map` node type** with config
   `{ overSource: "{{ nodes.split.output.chunks }}", subgraph: string[], maxFanOut?: number }`.
   Its executor validates the resolved array and echoes it — the interesting work
   is in the orchestrator, not the worker.

2. **Guard the size.** Reject an array longer than `maxFanOut` (default ~1000)
   with an `UnrecoverableError`. A 100k-element array must be refused loudly, not
   attempted.

3. **Spawn, in `onNodeSucceeded`,** when the completed node is a `flow.map`:
   for each element `i`, `createRun(versionId, 'fanout', subgraphKeys, idemKey)`
   with `parentRunId` and `fanOutIndex = i`; seed its in-degrees; dispatch its
   roots. Do **not** decrement the downstream node's in-degree yet.
   Use `idempotencyKey = ${parentRunId}:${mapNodeKey}:${i}` so a crash mid-spawn
   can't double-create children on replay.

4. **The join — this is the race.** When a child run reaches a terminal state,
   check whether any siblings remain:
   ```sql
   SELECT count(*) FROM "Run"
   WHERE "parentRunId" = $1 AND status NOT IN ('SUCCEEDED','FAILED','SKIPPED','CANCELLED')
   ```
   When it's zero, decrement the downstream node's in-degree through the normal
   atomic path with a summary payload `{ childCount, succeeded, failed }`.

   **Do the count-and-decrement in a transaction or a Lua script.** N children
   finishing simultaneously is exactly the race the rest of this system is careful
   about, and this is the single easiest place to reintroduce it. A plain
   read-then-write here means the join node fires twice — or never.

**Done when**

- [ ] A 10-element fan-out produces 10 child runs executing in parallel
      (different `workerId`s in the timeline).
- [ ] The downstream node runs **exactly once**, after all 10.
- [ ] Killing the API mid-spawn and restarting doesn't duplicate children.

---

### B3.3 — Real output aggregation

> **Size:** M.

**Steps**

1. Add a `flow.reduce` node type that declares how to merge — `concat`, `sum`,
   `mean`, or `custom` with a script path.
2. On join, collect the children's terminal node outputs into an ordered array
   (ordered by `fanOutIndex`, not completion time) and pass it as the reduce
   node's resolved input.
3. **Respect the 64 KB output cap.** `assertOutputSize` already exists — 100
   children each returning 10 KB is 1 MB and must not go inline. Aggregate
   *references* (artifact keys), not payloads, and let the reduce executor read
   them. This is the same discipline the rest of the system already follows.
4. Extend the context resolver so `{{ nodes.map.output.results[*].accuracy }}`
   (or a simpler `results` array reference) resolves — or keep it simple and pass
   the whole array as one value.

**Done when**

- [ ] A reduce node computes a real aggregate over all children's outputs.
- [ ] 100 children with large outputs don't blow the size cap.

---

### B3.4 — Failure and cancellation cascade

> **Size:** M. Ship this before calling B3 done — without it, a failed child
> leaves the parent hanging, which is worse than not having fan-out.

**Steps**

1. **Child failure → parent failure.** Decide and document the policy: fail-fast
   (first child failure fails the parent and cancels siblings) vs.
   tolerate-partial (`failureThreshold` in the map config). Fail-fast is the
   better default; make the threshold opt-in.
2. On parent failure, mark the reduce node and everything downstream `SKIPPED`
   via the same BFS `onNodeFailed` already uses.
3. **Cancel cascades down.** Extend `cancelRunService` to find child runs by
   `parentRunId` and cancel each recursively (they're one level deep today, but
   write it as a traversal — nested fan-out is a natural follow-up).
4. `retryFailedNodesService` needs to understand fan-out too: retrying a failed
   map node should re-spawn only the children that failed, not all N.

**Done when**

- [ ] One child failing fails the parent run and skips the reduce node.
- [ ] Cancelling the parent cancels all children within ~15 s (pairs with **B4**).
- [ ] Retry re-runs only the failed children.

---

### B3.5 — Fan-out in the UI

> **Size:** M.

**Steps**

1. Emit `RUN_SPAWNED` and `RUN_CHILD_COMPLETED` events; add them to the SSE event
   type list in `apps/web/src/api/client.ts` and to `applyEvent` in `runSlice`.
2. **Do not try to draw 100 nodes on the canvas.** Render the map node with a
   progress pill — `23 / 100` with a thin progress bar and a live count of
   failures. Reuse the status-dot vocabulary already in `CustomNode`.
3. Clicking the map node opens a child-run list (paginated via
   `GET /runs/:id/children`), each row linking to its own timeline.
4. Extend the Gantt chart to show child runs as a grouped/collapsible band.

**Done when**

- [ ] A 100-element fan-out renders as one node with live progress, not 100 nodes.
- [ ] You can drill into any child run and see its node timeline.

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
> confusing way, not a loud one. **This blocks C3 entirely.**

| Part | What ships | Size |
|---|---|---|
| C1.1 | An artifact-store interface, filesystem-backed (no behaviour change) | S |
| C1.2 | S3/MinIO backend + download links | M |

---

### C1.1 — Extract the artifact-store interface

> **Size:** S. Pure refactor — behaviour identical, tests unchanged. Landing this
> alone means C1.2 is a small, focused diff instead of a sprawling one.

**Steps**

1. Create `apps/worker/src/artifact-store.ts` with a narrow interface:
   ```ts
   export interface ArtifactStore {
     put(key: string, body: Buffer | Readable): Promise<void>;
     get(key: string): Promise<Readable>;
     exists(key: string): Promise<boolean>;
     localPath(key: string): Promise<string>;   // downloads to a temp dir if remote
     presignedUrl?(key: string): Promise<string>;
   }
   ```
2. Implement `FsArtifactStore` with exactly the current semantics — including the
   atomic `tmp → rename` write that `atomicWriteJson` already does.
3. Refactor the five executors in `executors.ts` to go through it. The idempotency
   checks (`fs.existsSync(resultPath)`) become `await store.exists(key)` — same
   logic, different call.
4. Select via `ARTIFACT_BACKEND=fs` (the only option so far) in `env.ts`.

**Done when**

- [ ] No executor calls `fs` directly any more.
- [ ] The existing integration suite passes unchanged.

---

### C1.2 — S3 / MinIO backend

> **Size:** M.

**Steps**

1. Add MinIO to `infra/docker-compose.yml` — S3-compatible and runs locally, so
   the dev experience needs no cloud account.
2. Implement `S3ArtifactStore` with `@aws-sdk/client-s3`. Select with
   `ARTIFACT_BACKEND=s3`. **Keep `fs` working** so tests don't need MinIO.
3. **Python stays backend-agnostic.** The Node executor downloads inputs to a temp
   dir before spawning and uploads outputs after — via `localPath()` and `put()`.
   Don't put boto3 in the scripts; it makes them untestable in isolation and
   duplicates credential handling.
4. Store the S3 key (not a local path) in `NodeRun.output`, so the UI can render a
   presigned download link per artifact.
5. Add a lifecycle/TTL note to `decisions_log.md` — artifacts accumulate forever
   today, which is fine locally and expensive in S3.

**Done when**

- [ ] `ARTIFACT_BACKEND=s3` runs the full pipeline against MinIO.
- [ ] `ARTIFACT_BACKEND=fs` still passes the existing integration suite.
- [ ] The run detail view offers a working download link per artifact.
- [ ] `KNOWN_LIMITATIONS.md` §4 can be deleted.

## C2 — Real multi-tenant isolation

> **Goal:** a bug in one service function cannot leak another tenant's data.
>
> **Why:** `tenantId` is a column. There's no row-level security, Redis keys
> (`run:{runId}:indegree`) aren't namespaced, and the concurrency semaphore isn't
> tenant-scoped — so one tenant's fan-out can consume the whole cluster's
> capacity. **Requires A3** (an authenticated tenant) first.

| Part | What ships | Size |
|---|---|---|
| C2.1 | Postgres row-level security | M |
| C2.2 | Tenant-namespaced Redis keys | S |
| C2.3 | Per-tenant concurrency quota | S |

---

### C2.1 — Postgres row-level security

> **Size:** M. The careful one — get it wrong and reads silently return nothing.

**Steps**

1. Migration enabling RLS on `Workflow`, `Run`, `NodeRun`, `RunEvent`:
   ```sql
   ALTER TABLE "Workflow" ENABLE ROW LEVEL SECURITY;
   CREATE POLICY tenant_isolation ON "Workflow"
     USING ("tenantId" = current_setting('app.tenant_id', true));
   ```
   `Run` / `NodeRun` / `RunEvent` have no `tenantId` column — either denormalise
   one onto them (simpler, faster) or write the policy as a join through
   `WorkflowVersion → Workflow`. **Denormalise.** Recursive policies are slow and
   hard to debug.

2. Set `app.tenant_id` per transaction via Prisma middleware
   (`$executeRaw` a `SET LOCAL` at transaction start). It costs one extra
   round-trip per transaction — **measure it** and record the number in
   `decisions_log.md`.

3. **The worker is the trap.** Workers connect with the same DB role but have no
   HTTP request context. Either give them a bypass role (`BYPASSRLS`) with a
   clearly documented justification, or thread `tenantId` through the job payload
   and set it in `processJob`. The second is more correct; do that.

4. **Test the isolation, don't assume it.** Add an integration test that
   deliberately queries with the wrong tenant context and asserts zero rows.

**Done when**

- [ ] A raw `SELECT * FROM "Run"` under tenant A's session returns only A's rows.
- [ ] The full pipeline still runs (workers can still write NodeRuns).
- [ ] The RLS overhead is measured and written down.

---

### C2.2 — Tenant-namespaced Redis keys

> **Size:** S.

**Steps**

1. Change key construction in `packages/queue/src/lua.ts` and `semaphore.ts`:
   `run:{runId}:indegree` → `{tenantId}:run:{runId}:indegree`.
2. Thread `tenantId` into `seedInDegrees` / `decrementInDegree` — both are already
   called from places that have the run in hand.
3. Note the migration hazard: in-flight runs at deploy time have keys under the
   old scheme. Either drain before deploying or read both prefixes for one release.

**Done when**

- [ ] `redis-cli KEYS '*'` shows every run key prefixed by tenant.
- [ ] `KNOWN_LIMITATIONS.md` §1's Redis bullet can be deleted.

---

### C2.3 — Per-tenant concurrency quota

> **Size:** S.

**Steps**

1. Add a `concurrencyLimit` column to `Tenant` (default e.g. 20).
2. In `dispatchNode`, acquire a tenant-scoped semaphore slot before enqueueing.
   The per-run semaphore in `packages/queue/src/semaphore.ts` is the pattern —
   copy its shape, key it by tenant.
3. Over quota → leave the node `PENDING` and let it be picked up by the next
   parent completion, plus a periodic sweep for the case where no parent will
   complete again.
4. Release the slot in both `onNodeSucceeded` and `onNodeFailed`. **Leaking slots
   here deadlocks the tenant** — add a TTL on the semaphore entries as a backstop.

**Done when**

- [ ] Tenant A saturating its quota does not delay tenant B's runs.
- [ ] Killing a worker mid-job doesn't permanently leak a slot.

## C3 — Kubernetes + queue-driven autoscaling

> **Goal:** workers scale automatically with queue depth, across real machines.
>
> **Why:** this is what makes the "distributed, horizontally scalable" claim
> genuinely true, and it's the deployment story that makes the project look like
> infrastructure rather than a demo. **Needs C1** (shared artifact storage) first,
> or nodes on different machines can't read each other's files.

| Part | What ships | Size |
|---|---|---|
| C3.1 | Manifests, running at fixed replicas | M |
| C3.2 | Health probes + graceful shutdown | M |
| C3.3 | KEDA autoscaling + the real benchmark | M |

---

### C3.1 — Manifests at fixed replicas

> **Size:** M. Get it *running* before you get it *elastic*.

**Steps**

1. Write `infra/k8s/`: `Deployment` for api and worker, `StatefulSet` (or managed
   services) for postgres and redis, `Service` + `Ingress`, `ConfigMap` +
   `Secret`, and a `Job` for migrations.
2. **Gate the API on migrations** with an init-container that waits for the
   migration Job, or the API starts against an empty schema and crash-loops
   confusingly.
3. Fixed `replicas: 2` for workers. No autoscaling yet.
4. Test locally on `kind` or `k3d` before touching a cloud account — it's faster
   and free.

**Done when**

- [ ] `kubectl apply -k infra/k8s` brings up a working cluster.
- [ ] A pipeline runs end-to-end with workers on different nodes.

---

### C3.2 — Health probes and graceful shutdown

> **Size:** M. Do this before autoscaling, or scale-down will kill running jobs.

**Steps**

1. Add `/health/live` (process is up) and `/health/ready` (**Postgres *and* Redis
   both reachable**) to the API. Wire them as `livenessProbe` / `readinessProbe`.
2. Workers need a probe too — a file-touch or a tiny HTTP server reporting
   BullMQ connection state.
3. **Graceful shutdown already works** — `worker.close()` on SIGTERM stops
   accepting new jobs and lets in-flight ones finish. Set
   `terminationGracePeriodSeconds` **above your longest node timeout**, or
   Kubernetes SIGKILLs a training job mid-run.
4. Add a `PodDisruptionBudget` so a node drain can't take every worker at once.

**Done when**

- [ ] `kubectl delete pod <worker>` during a run doesn't fail the run.
- [ ] A pod with Redis unreachable reports not-ready and stops taking traffic.

---

### C3.3 — KEDA autoscaling and the real benchmark

> **Size:** M. The payoff.

**Steps**

1. Install [KEDA](https://keda.sh) and add a `ScaledObject` on Redis list length:
   ```yaml
   triggers:
     - type: redis
       metadata: { listName: "bull:cpu:wait", listLength: "20" }
   ```
   `minReplicaCount: 1`, `maxReplicaCount: 20`, and a `cooldownPeriod` longer than
   your longest job.
2. Verify scale-up *and* scale-down, and that scale-down never kills running work
   (this is what C3.2 bought you).
3. **Re-run the A4 benchmark here.** This is where you finally get a real
   horizontal-scaling curve on genuinely separate machines — the number the README
   has been claiming. Regenerate `benchmarks/` and update the README with it.

**Done when**

- [ ] Submitting 500 runs scales workers 1 → 10 automatically, then back down.
- [ ] Scale-down never kills a running node.
- [ ] `benchmarks/` contains a multi-machine curve and the README quotes it.
- [ ] `KNOWN_LIMITATIONS.md` §7 can be deleted.

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

| Part | What ships | Size |
|---|---|---|
| D1.1 | The CRUD API | M |
| D1.2 | Workflow list + open/rename in the editor | M |
| D1.3 | Version history and restore | S |

---

### D1.1 — The CRUD API

> **Size:** M. Testable with `curl` alone; no UI work in this PR.

**Steps**

1. `GET /workflows` — paginated, tenant-scoped, newest first, with a `versionCount`
   and `lastRunAt` per row (`groupBy`, not N+1 queries).
2. `GET /workflows/:id` — includes its versions.
3. `PATCH /workflows/:id` — rename.
4. `DELETE /workflows/:id` — **soft delete.** Add `deletedAt` to the model; runs
   reference versions, so a hard delete either cascades away history or fails on
   the FK. Filter `deletedAt: null` in every list query.
5. `GET /workflows/:id/versions` — for D1.3.
6. Add `@@index([tenantId, createdAt])` to `Workflow` to keep the list query fast.

**Done when**

- [ ] Full create → list → rename → delete cycle works via `curl`.
- [ ] Deleted workflows disappear from the list but their runs remain readable.

---

### D1.2 — Workflow list and open/rename in the editor

> **Size:** M. The biggest perceived-quality jump in the whole roadmap.

**Steps**

1. **Write `fromGraph()`** in `graphSlice.ts` — the inverse of the existing
   `toGraph()`. It rebuilds React Flow nodes/edges from the stored contract shape,
   and must reset `_nodeCounter` above the highest existing `node-N` id or the
   next added node will collide.
2. A workflow list view (or a dropdown in the header) using `GET /workflows`.
3. Inline-editable name in the header — not a `prompt()`. Replaces the hardcoded
   `'My Pipeline'`.
4. "New workflow" resets the canvas to the starter graph and clears
   `workflowId` / `versionId`.
5. Persist the current `workflowId` in `localStorage` so a reload resumes where
   you were.
6. **Guard unsaved changes** — `isDirty` already exists; use it for a confirm
   prompt on switching workflows and a `beforeunload` handler.

**Done when**

- [ ] Create, name, save, close, reopen, and edit a workflow across a page reload.
- [ ] Switching away with unsaved changes warns first.

---

### D1.3 — Version history and restore

> **Size:** S. The data is already there and immutable — this is nearly free and
> demos beautifully.

**Steps**

1. A version dropdown in the header: `v7 (current)`, `v6`, `v5`… with timestamps.
2. Selecting an old version loads it read-only, with a "Restore this version"
   button.
3. Restoring creates version N+1 from the old graph — **never mutates history.**
   That immutability is a real design property; don't break it for convenience.
4. Show which version each run in Run History used.

**Done when**

- [ ] Restoring version 3 while version 7 is current creates version 8.
- [ ] Old versions are visibly read-only until restored.

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

One session per row. Stop wherever you like — every row leaves the project in a
better, working state than the row before it.

| # | Session | Size | Why here |
|---|---|---|---|
| 1 | **A1.1** Python runtime | S | De-risks the Docker build before any logic changes |
| 2 | **A1.2** Real preprocessing | M | First node doing genuine work |
| 3 | **A1.3** Real training | M | Weights stop being an 11-byte string literal |
| 4 | **A1.4** Real evaluation | M | **The payoff** — the demo becomes honest |
| 5 | **A2** Migrations | S | Tiny; unblocks reliable cold starts for everything later |
| 6 | **A5** Lint + CI | M | Cheap; makes every subsequent PR safer |
| 7 | **A1.5** Honest data source | M | Removes the last step that can't actually run |
| 8 | **D1.1** Workflow CRUD API | M | Foundation for the biggest UX jump |
| 9 | **D1.2** Workflow list + open | M | Highest perceived-quality gain per hour |
| 10 | **D1.3** Version history | S | Nearly free — the data is already immutable |
| 11 | **B1.1** Conditions in the engine | M | Best feature-to-effort ratio in the list |
| 12 | **B1.2** Condition builder UI | S | What the persistent edge selection was for |
| 13 | **A3** Auth | M | Gates C2; also the most common interview question |
| 14 | **A4** Honest benchmark | M | Do it once A1 makes the workload realistic |
| 15 | **B5** Retry policy | S | Removes a dead schema |
| 16 | **B4** Hard cancel | S | Pairs naturally with B5 |
| 17 | **D2** Server run history | S | Completes the D1 story |
| 18 | **B2** Scheduling | M | The "it runs itself" moment |
| 19 | **C1.1** Artifact-store interface | S | Pure refactor; makes C1.2 a small diff |
| 20 | **C1.2** S3 / MinIO backend | M | Blocks C3 |
| 21 | **B3.1** Run-tree schema | M | Additive; safe PR to land the schema |
| 22 | **B3.2** Spawn + summary join | M | Fan-out genuinely works from here |
| 23 | **B3.3** Output aggregation | M | Real map/reduce |
| 24 | **B3.4** Failure + cancel cascade | M | Ship before calling B3 done |
| 25 | **B3.5** Fan-out UI | M | Makes it visible |
| 26 | **C2.1** Postgres RLS | M | Needs A3 |
| 27 | **C2.2** Redis namespacing | S | Small follow-on |
| 28 | **C2.3** Tenant quotas | S | Small follow-on |
| 29 | **C3.1** K8s manifests | M | Needs C1 |
| 30 | **C3.2** Probes + shutdown | M | Must precede autoscaling |
| 31 | **C3.3** KEDA + real benchmark | M | The scaling curve the README wants |
| 32 | **C4** Observability | M | Best once there's real load to observe |
| — | **D3** Editor polish | S | Sprinkle throughout, whenever you want a short one |

### Natural stopping points

- **After #4 (A1.4):** the demo is honest. Real data, real model, real metrics,
  a quality gate that fails for a real reason. If you do nothing else, do this.
- **After #12 (B1.2):** it's a real product — save/open workflows, version
  history, and conditional branching. This is a strong portfolio state.
- **After #25 (B3.5):** it's a real workflow *engine*, feature-comparable to the
  tools it says it's an alternative to.
- **After #32:** it's infrastructure.

**If you only have three sessions:** A1.1, A1.2, A1.3. Getting the pipeline to
genuinely process data beats every other item on this list.

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
