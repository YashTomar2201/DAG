# Python Executor Scripts

> **Note (Phase 12):** despite this directory's presence in PROJECT_GUIDE.md §3's
> repository layout diagram, the scripts the worker actually spawns live at
> **`apps/worker/python/`**, not here. `python-bridge.ts` resolves the script
> directory as `path.resolve(process.cwd(), 'python')`, and `process.cwd()` is
> `apps/worker` whenever the worker runs — via `pnpm --filter @dag/worker dev`,
> `pnpm --filter @dag/worker exec tsx src/index.ts` (what the Phase 12
> integration tests spawn), and the `apps/worker` Docker image's `WORKDIR` in
> Phase 13. This directory is kept only as a pointer; see
> `knowledge_base/decisions_log.md` ("Phase 12 — python/ vs
> apps/worker/python/ location drift") for the full write-up. Do not add
> scripts here — add them to `apps/worker/python/`.

Scripts spawned by `apps/worker` via `child_process.spawn` for the reference ML pipeline.

| Script | Node type | Invoked by |
|--------|-----------|------------|
| `preprocess.py` | `pandas.preprocess` | Phase 8 |
| `train.py` | `torch.train` | Phase 8 |
| `evaluate.py` | `model.evaluate` | Phase 8 |

## Contract

- Worker writes the resolved `NodeRun.input` as JSON to **stdin**.
- Script streams progress lines to **stdout** (captured as log events).
- Final output line must be `::RESULT:: <json>` — the worker parses this as the node's output.
- Non-zero exit code → error; worker attaches the last 50 lines of stderr to `NodeRun.error`.
- Timeout: enforced by the worker via `child_process` `killSignal`; scripts must tolerate `SIGTERM`.

Scripts implemented in Phase 8.
