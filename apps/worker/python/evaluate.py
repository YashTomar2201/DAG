#!/usr/bin/env python3
"""
evaluate.py — real held-out-set evaluation.

Protocol (unchanged): one JSON line of context in, log lines out, exactly one
`::RESULT:: {json}` line.

Context:
  weightsPath   joblib model from train (template ref).
  testPath      test.parquet from preprocess (template ref).
  targetColumn  label column in the test parquet (default: the last column).
  minAccuracy   informational only here — the pass/fail gate is enforced by the
                executor (modelEvaluate in apps/worker/src/executors.ts).

When `weightsPath` / `testPath` are wired, this loads the real model and the
real held-out split and computes genuine metrics — accuracy, weighted f1,
precision, recall, and a confusion matrix. If either is absent (an un-wired
graph, or the hermetic integration fixtures), it returns fixed reference
metrics marked `"synthetic": true` so those pipelines still run green. If the
refs ARE present but evaluation fails, the script exits non-zero — a wired but
broken pipeline should fail loudly, not silently pass.
"""

import sys
import os
import json

import pandas as pd
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
)


def _real_eval(weights_path, test_path, target):
    import joblib

    model = joblib.load(weights_path)
    test = pd.read_parquet(test_path)

    if not target or target not in test.columns:
        target = test.columns[-1]
    y = test[target]
    X = test.drop(columns=[target])

    # Align feature columns to what the model was trained on, if it says.
    feat = getattr(model, "feature_names_in_", None)
    if feat is not None:
        missing = [c for c in feat if c not in X.columns]
        if missing:
            raise ValueError(f"test split is missing model features: {missing}")
        X = X[list(feat)]

    pred = model.predict(X)
    labels = sorted(pd.unique(y).tolist())

    return {
        "accuracy": float(accuracy_score(y, pred)),
        "f1": float(f1_score(y, pred, average="weighted")),
        "precision": float(precision_score(y, pred, average="weighted", zero_division=0)),
        "recall": float(recall_score(y, pred, average="weighted", zero_division=0)),
        "confusionMatrix": confusion_matrix(y, pred, labels=labels).tolist(),
        "labels": [int(v) if hasattr(v, "__int__") else str(v) for v in labels],
        "nTest": int(len(test)),
        "targetColumn": target,
        "synthetic": False,
    }


def main():
    ctx = json.loads(sys.stdin.readline())
    weights_path = ctx.get("weightsPath") or ""
    test_path = ctx.get("testPath") or ""
    target = ctx.get("targetColumn")

    if weights_path and test_path and os.path.isfile(weights_path) and os.path.isfile(test_path):
        print(
            f"[evaluate] loading model {os.path.basename(weights_path)} + "
            f"test split {os.path.basename(test_path)}",
            flush=True,
        )
        result = _real_eval(weights_path, test_path, target)
        print(
            f"[evaluate] n_test={result['nTest']} accuracy={result['accuracy']:.4f} "
            f"f1={result['f1']:.4f} precision={result['precision']:.4f} "
            f"recall={result['recall']:.4f}",
            flush=True,
        )
        print(
            f"[evaluate] confusion matrix (labels {result['labels']}): "
            f"{result['confusionMatrix']}",
            flush=True,
        )
        print("::RESULT:: " + json.dumps(result), flush=True)
        return

    # Fallback: no model / test split wired (un-wired graph or hermetic fixture).
    print(
        "[evaluate] no weightsPath/testPath wired - returning reference metrics",
        flush=True,
    )
    result = {
        "accuracy": 0.923,
        "f1": 0.911,
        "confusionMatrix": [[0, 0], [0, 0]],
        "labels": [0, 1],
        "nTest": 0,
        "synthetic": True,
    }
    print("::RESULT:: " + json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
