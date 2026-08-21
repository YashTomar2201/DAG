#!/usr/bin/env python3
"""
preprocess.py — Pandas preprocessing step.

Protocol:
  - Reads JSON context from stdin (one line).
  - Writes any log lines to stdout (they are streamed to the run log).
  - Prints exactly one `::RESULT:: {json}` line as the final output.
  - Exits 0 on success, non-zero on failure (stderr captured by the bridge).

Idempotency: The Node.js bridge checks for result.json before calling this
script. If this script is called, it always writes the full output; partial
writes are handled by the atomic tmp→rename in executors.ts.
"""

import sys
import json
import os
import pathlib

def main():
    # ── Read input from stdin ──────────────────────────────────────────────
    raw = sys.stdin.readline()
    ctx = json.loads(raw)

    output_dir = ctx.get("outputDir", ".")
    pathlib.Path(output_dir).mkdir(parents=True, exist_ok=True)

    # ── Locate input CSV ───────────────────────────────────────────────────
    input_dir = ctx.get("outputDir") or ctx.get("dataDir", ".")
    csv_path = ctx.get("csvPath") or ctx.get("metadataPath")

    # For integration testing without a real dataset, look for any CSV
    csv_files = []
    if csv_path and os.path.exists(csv_path):
        csv_files = [csv_path]
    else:
        for root, _, files in os.walk(input_dir if os.path.isdir(input_dir) else "."):
            for f in files:
                if f.endswith(".csv"):
                    csv_files.append(os.path.join(root, f))
            break  # non-recursive for demo

    print(f"[preprocess] Found {len(csv_files)} CSV file(s)", flush=True)

    # ── Write a sample metadata.csv ────────────────────────────────────────
    metadata_path = os.path.join(output_dir, "metadata.csv")
    with open(metadata_path, "w") as f:
        f.write("col_a,col_b,col_c\n")
        for i in range(100):
            f.write(f"{i},{i*2},{i*3}\n")

    print(f"[preprocess] Wrote metadata.csv to {metadata_path}", flush=True)

    checksum = "sha256:placeholder"
    result = {
        "metadataPath": metadata_path,
        "rows": 100,
        "columns": ["col_a", "col_b", "col_c"],
        "checksum": checksum,
        "outputDir": output_dir,
    }

    # ── Emit result sentinel ───────────────────────────────────────────────
    print(f"::RESULT:: {json.dumps(result)}", flush=True)

if __name__ == "__main__":
    main()
