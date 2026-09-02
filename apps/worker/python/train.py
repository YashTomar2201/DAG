#!/usr/bin/env python3
"""
train.py — real scikit-learn training step.

Protocol (unchanged — the Node bridge depends on it):
  - Reads one JSON line of context from stdin.
  - Streams a progress line per iteration to stdout.
  - Prints exactly one `::RESULT:: {json}` line as the final output.
  - Exits 0 on success, non-zero on failure.

Context fields (all optional except outputDir / weightsPath, which the executor
always sets):
  trainPath     Path to the train.parquet written by preprocess. If missing, a
                small deterministic synthetic dataset is used so an un-wired
                graph still trains something real.
  targetColumn  Label column in the parquet (default: the last column).
  modelType     "randomforest" (default) or "logreg".
  epochs        Iteration budget — number of trees for randomforest, solver
                iterations for logreg.
  weightsPath   Where to dump the fitted model (joblib).

Real work: load the split, fit the model incrementally, log a genuine
train-set score each iteration, and persist the model with joblib. The score
progression is real (bootstrap / solver noise), not a synthetic curve.
"""

import sys
import os
import json
import hashlib
import warnings

import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression

# Expected: the logreg path deliberately fits with a tiny max_iter budget each
# iteration to produce a genuine convergence progression, which trips lbfgs's
# "failed to converge" warning every step. Silence it so the run log stays the
# per-iteration score lines and nothing else.
warnings.filterwarnings("ignore", category=ConvergenceWarning)


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return f"sha256:{h.hexdigest()}"


def _load_xy(ctx):
    """Return (X, y, source_label). Falls back to a synthetic set if needed."""
    train_path = ctx.get("trainPath")
    target = ctx.get("targetColumn")
    if train_path and os.path.isfile(train_path):
        df = pd.read_parquet(train_path)
        if not target or target not in df.columns:
            target = df.columns[-1]
        X = df.drop(columns=[target])
        y = df[target]
        return X, y, f"{os.path.basename(train_path)} ({len(df)} rows)"

    # Fallback: deterministic synthetic classification problem.
    from sklearn.datasets import make_classification

    Xa, ya = make_classification(
        n_samples=400, n_features=8, n_informative=5, n_redundant=1,
        n_classes=2, random_state=42,
    )
    cols = [f"f{i}" for i in range(Xa.shape[1])]
    return pd.DataFrame(Xa, columns=cols), pd.Series(ya, name="target"), "synthetic make_classification(400x8)"


def main():
    ctx = json.loads(sys.stdin.readline())

    output_dir = ctx.get("outputDir", ".")
    os.makedirs(output_dir, exist_ok=True)
    weights_path = ctx.get("weightsPath") or os.path.join(output_dir, "model.joblib")
    epochs = max(1, int(ctx.get("epochs") or 10))
    model_type = (ctx.get("modelType") or "randomforest").lower()

    X_train, y_train, source = _load_xy(ctx)
    print(
        f"[train] {model_type}: {X_train.shape[1]} features, {len(X_train)} rows from {source}",
        flush=True,
    )

    scores = []
    if model_type == "logreg":
        # Genuine per-iteration progress: refit with a growing solver budget.
        model = LogisticRegression(max_iter=1, warm_start=True, solver="lbfgs")
        for i in range(1, epochs + 1):
            model.max_iter = i
            model.fit(X_train, y_train)
            s = float(model.score(X_train, y_train))
            scores.append(s)
            print(f"[train] iter {i}/{epochs} max_iter={i} train_score={s:.4f}", flush=True)
    else:
        model_type = "randomforest"
        # warm_start + growing n_estimators gives a real per-step score.
        model = RandomForestClassifier(
            n_estimators=1, warm_start=True, random_state=42, n_jobs=1
        )
        for i in range(1, epochs + 1):
            model.set_params(n_estimators=i)
            model.fit(X_train, y_train)
            s = float(model.score(X_train, y_train))
            scores.append(s)
            print(f"[train] iter {i}/{epochs} trees={i} train_score={s:.4f}", flush=True)

    import joblib

    joblib.dump(model, weights_path)
    train_score = scores[-1] if scores else float(model.score(X_train, y_train))
    print(
        f"[train] done - final train_score={train_score:.4f}, "
        f"saved {os.path.getsize(weights_path)} bytes to {os.path.basename(weights_path)}",
        flush=True,
    )

    result = {
        "weightsPath": weights_path,
        "modelType": model_type,
        "epochs": epochs,
        "trainScore": train_score,
        "scoreHistory": [round(s, 4) for s in scores],
        "featureNames": list(X_train.columns),
        "nFeatures": int(X_train.shape[1]),
        "nTrain": int(len(X_train)),
        "checksum": _sha256_file(weights_path),
        "outputDir": output_dir,
    }
    print("::RESULT:: " + json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
