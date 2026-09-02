#!/usr/bin/env python3
"""
preprocess.py — real Pandas preprocessing on a tabular dataset.

Protocol (unchanged — the Node bridge depends on it):
  - Reads one JSON line of context from stdin.
  - Streams human-readable log lines to stdout.
  - Prints exactly one `::RESULT:: {json}` line as the final output.
  - Exits 0 on success, non-zero on failure (stderr captured by the bridge).

Context fields (all optional except outputDir, which the executor always sets):
  csvPath       Path to the input CSV. Relative paths are resolved against the
                worker's python/ dir; falls back to the bundled
                data/titanic.csv so a graph that sets nothing still runs.
  targetColumn  Label column, held out of feature encoding (default "Survived").
  testSize      Held-out fraction, 0 < t < 1 (default 0.2).
  outputDir     Directory to write train.parquet / test.parquet into.

Real work: drop mostly-empty columns, drop identifier-like string columns,
median/mode impute the rest, one-hot encode the categoricals, then split.
The row/column counts, feature list, and checksum in the result all move when
the data or the config changes — nothing here is hardcoded.
"""

import sys
import os
import json
import hashlib

import pandas as pd
from sklearn.model_selection import train_test_split

# A column with more than this fraction of nulls is dropped rather than imputed.
NULL_FRACTION_DROP = 0.4
# An object column with cardinality above this fraction of the row count is
# treated as an identifier (name, ticket, id) and dropped before encoding.
HIGH_CARD_FRACTION = 0.5


def _resolve_csv(csv_path):
    """Find the input CSV, trying a few sensible bases, then the bundled file."""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_python_root = os.path.dirname(script_dir)
    candidates = []
    if csv_path:
        candidates += [
            csv_path,
            os.path.join(os.getcwd(), csv_path),
            os.path.join(repo_python_root, csv_path),
            os.path.join(script_dir, csv_path),
        ]
    candidates.append(os.path.join(script_dir, "data", "titanic.csv"))
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    raise FileNotFoundError(
        f"preprocess: could not locate input CSV (tried: {candidates})"
    )


def main():
    ctx = json.loads(sys.stdin.readline())

    csv_path = _resolve_csv(ctx.get("csvPath"))
    target = ctx.get("targetColumn") or "Survived"
    test_size = float(ctx.get("testSize") or 0.2)
    if not 0.0 < test_size < 1.0:
        raise ValueError(f"testSize must be between 0 and 1 (exclusive), got {test_size}")

    output_dir = ctx["outputDir"]
    os.makedirs(output_dir, exist_ok=True)

    df = pd.read_csv(csv_path)
    n_rows, n_cols = df.shape
    print(
        f"[preprocess] loaded {n_rows} rows x {n_cols} cols from {os.path.basename(csv_path)}",
        flush=True,
    )

    # 1. drop columns that are mostly empty
    null_frac = df.isna().mean()
    high_null = sorted(null_frac[null_frac > NULL_FRACTION_DROP].index.tolist())
    if high_null:
        df = df.drop(columns=high_null)
        print(f"[preprocess] dropped {len(high_null)} high-null column(s): {high_null}", flush=True)

    # 2. drop identifier-like object columns (near-unique strings) — never the target
    id_like = sorted(
        c
        for c in df.columns
        if c != target
        and df[c].dtype == object
        and df[c].nunique(dropna=True) > HIGH_CARD_FRACTION * len(df)
    )
    if id_like:
        df = df.drop(columns=id_like)
        print(f"[preprocess] dropped {len(id_like)} identifier-like column(s): {id_like}", flush=True)

    has_target = target in df.columns
    if not has_target:
        print(
            f"[preprocess] WARNING: target column '{target}' not found — "
            f"encoding every remaining column as a feature",
            flush=True,
        )

    feature_cols = [c for c in df.columns if c != target] if has_target else list(df.columns)
    features = df[feature_cols].copy()

    # 3. impute — median for numerics, mode for categoricals
    num_cols = features.select_dtypes(include="number").columns.tolist()
    cat_cols = features.select_dtypes(exclude="number").columns.tolist()
    imputed = 0
    for c in num_cols:
        if features[c].isna().any():
            features[c] = features[c].fillna(features[c].median())
            imputed += 1
    for c in cat_cols:
        if features[c].isna().any():
            mode = features[c].mode(dropna=True)
            features[c] = features[c].fillna(mode.iloc[0] if len(mode) else "unknown")
            imputed += 1
    print(
        f"[preprocess] imputed {imputed} column(s) "
        f"({len(num_cols)} numeric, {len(cat_cols)} categorical)",
        flush=True,
    )

    # 4. one-hot encode the categoricals
    encoded = pd.get_dummies(features, columns=cat_cols, drop_first=True)
    if has_target:
        encoded[target] = df[target].to_numpy()
    n_dummies = encoded.shape[1] - len(num_cols) - (1 if has_target else 0)
    print(
        f"[preprocess] one-hot encoded {len(cat_cols)} categorical column(s) "
        f"into {n_dummies} dummy column(s); {encoded.shape[1]} columns total",
        flush=True,
    )

    # 5. train / test split
    stratify = None
    if has_target and encoded[target].nunique(dropna=True) <= 20:
        stratify = encoded[target]
    train_df, test_df = train_test_split(
        encoded, test_size=test_size, random_state=42, stratify=stratify
    )
    print(
        f"[preprocess] split -> train {len(train_df)} rows / test {len(test_df)} rows "
        f"(testSize={test_size})",
        flush=True,
    )

    train_path = os.path.join(output_dir, "train.parquet")
    test_path = os.path.join(output_dir, "test.parquet")
    train_df.to_parquet(train_path, index=False)
    test_df.to_parquet(test_path, index=False)

    # Checksum the train split's *content*, not the parquet bytes (which can vary
    # by writer version). This is what makes the idempotency short-circuit in
    # executors.ts meaningful — it moves iff the processed data moves.
    digest = hashlib.sha256(
        pd.util.hash_pandas_object(train_df, index=True).to_numpy().tobytes()
    ).hexdigest()

    result = {
        "trainPath": train_path,
        "testPath": test_path,
        "targetColumn": target if has_target else None,
        "rows": int(n_rows),
        "cols": int(n_cols),
        "nTrain": int(len(train_df)),
        "nTest": int(len(test_df)),
        "nFeatures": int(encoded.shape[1] - (1 if has_target else 0)),
        "features": [c for c in encoded.columns if c != target],
        "checksum": f"sha256:{digest}",
        "outputDir": output_dir,
    }
    print("::RESULT:: " + json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
