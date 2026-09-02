# Updates Log

A running record of fixes and polish applied to the DAG Engine **after** the
initial 14-phase build. Each entry: what changed, which files, and why.

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
