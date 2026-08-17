# Python Executor Scripts

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
