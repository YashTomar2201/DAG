# Updates Log

A running record of fixes and polish applied to the DAG Engine **after** the
initial 14-phase build. Each entry: what changed, which files, and why.

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
