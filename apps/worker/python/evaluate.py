#!/usr/bin/env python3
"""evaluate.py — Model evaluation stub."""
import sys, json, os, pathlib

def main():
    ctx = json.loads(sys.stdin.readline())
    output_dir = ctx.get("outputDir", ".")
    pathlib.Path(output_dir).mkdir(parents=True, exist_ok=True)
    weights_path = ctx.get("weightsPath", "")
    print(f"[evaluate] Evaluating model at {weights_path}", flush=True)
    result = {
        "accuracy": 0.923,
        "f1": 0.911,
        "weightsPath": weights_path,
        "outputDir": output_dir,
    }
    print(f"::RESULT:: {json.dumps(result)}", flush=True)

if __name__ == "__main__":
    main()
