#!/usr/bin/env python3
"""
make_titanic.py — regenerate data/titanic.csv (deterministic synthetic dataset).

This is NOT the Kaggle Titanic file. It is a synthetic passenger manifest with
the same column shape and realistic-looking distributions and missingness, so
preprocess.py has genuine work to do (drop a high-null column, impute Age /
Embarked, one-hot encode the categoricals) while staying 100% reproducible and
credential-free. A1.5 adds an optional real data source.

Run: python3 apps/worker/python/data/make_titanic.py
"""

import numpy as np
import pandas as pd

N = 891
rng = np.random.default_rng(42)

pclass = rng.choice([1, 2, 3], size=N, p=[0.24, 0.21, 0.55])
sex = rng.choice(["male", "female"], size=N, p=[0.65, 0.35])

# Survival correlated with sex and class (women and 1st class more likely).
base = 0.05 + 0.55 * (sex == "female") + 0.20 * (pclass == 1) + 0.10 * (pclass == 2)
survived = (rng.random(N) < np.clip(base, 0.02, 0.95)).astype(int)

age = rng.normal(29, 13, size=N).clip(0.42, 80).round(1)
age[rng.random(N) < 0.20] = np.nan  # ~20% missing, like the real file

sibsp = rng.choice([0, 1, 2, 3, 4, 5], size=N, p=[0.68, 0.23, 0.05, 0.02, 0.01, 0.01])
parch = rng.choice([0, 1, 2, 3, 4], size=N, p=[0.76, 0.13, 0.08, 0.02, 0.01])

fare_mean = np.where(pclass == 1, 84.0, np.where(pclass == 2, 20.0, 13.0))
fare = (rng.lognormal(mean=np.log(fare_mean), sigma=0.5)).round(4)

embarked = rng.choice(["S", "C", "Q"], size=N, p=[0.72, 0.19, 0.09]).astype(object)
embarked[rng.random(N) < 0.003] = np.nan  # a couple missing

# High-null column: preprocess should drop this outright.
cabin_letter = rng.choice(list("ABCDEF"), size=N)
cabin = np.array(
    [f"{c}{rng.integers(1, 148)}" for c in cabin_letter], dtype=object
)
cabin[rng.random(N) < 0.77] = np.nan  # ~77% missing

titles = rng.choice(["Mr", "Mrs", "Miss", "Master", "Dr"], size=N,
                    p=[0.58, 0.15, 0.20, 0.05, 0.02])
name = [f"Synth{ i:04d}, {t}. Passenger" for i, t in enumerate(titles, 1)]
ticket = [f"TS{int(x):06d}" for x in rng.integers(1000, 999999, size=N)]

df = pd.DataFrame({
    "PassengerId": np.arange(1, N + 1),
    "Survived": survived,
    "Pclass": pclass,
    "Name": name,
    "Sex": sex,
    "Age": age,
    "SibSp": sibsp,
    "Parch": parch,
    "Ticket": ticket,
    "Fare": fare,
    "Cabin": cabin,
    "Embarked": embarked,
})

out = __file__.rsplit("/", 1)[0].rsplit("\\", 1)[0] + "/titanic.csv"
df.to_csv(out, index=False)
print(f"wrote {out}: {len(df)} rows x {len(df.columns)} cols")
