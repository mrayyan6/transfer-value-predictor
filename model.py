"""Train the value models, one set per league.

Two models per league: a plain Linear Regression and a Random Forest. Both
predict log(market value) because values are wildly skewed (a handful of
players worth 100m+, most under 15m), and a straight line through raw euros
gets dragged around by the superstars.

The numbers that matter for the site are the out of fold predictions: every
player is predicted by a model that never saw that player in training. If I
used in-sample predictions the forest would just memorise everyone's value
and nobody would ever look over or undervalued.

    python model.py          train, evaluate, save to models/ and reports/
"""

from __future__ import annotations

import json
from pathlib import Path

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestRegressor
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import KFold
from sklearn.pipeline import Pipeline, make_pipeline
from sklearn.preprocessing import FunctionTransformer, OneHotEncoder, StandardScaler

from data_loader import LEAGUES, load_players

ROOT = Path(__file__).resolve().parent
MODELS = ROOT / "models"
REPORTS = ROOT / "reports"

NUMERIC = [
    "age",
    "minutes_played",
    "goals",
    "assists",
    "shots_on_target",
    "key_passes",
    "tackles",
    "team_ppg",
]
CATEGORICAL = ["position"]
FEATURES = NUMERIC + CATEGORICAL
POSITIONS = ["Defender", "Midfielder", "Forward"]

SEED = 7
FOLDS = 5


def slug(league: str) -> str:
    return league.lower().replace(" ", "_")


def linear_pipeline() -> Pipeline:
    # Value rises into the mid twenties and then falls off, which a straight
    # line in age can't do. Adding age squared gives it the curve.
    pre = ColumnTransformer(
        [
            ("num", StandardScaler(), NUMERIC),
            ("age_sq", make_pipeline(FunctionTransformer(np.square, feature_names_out="one-to-one"), StandardScaler()), ["age"]),
            ("pos", OneHotEncoder(categories=[POSITIONS], drop="first"), CATEGORICAL),
        ]
    )
    return Pipeline([("prep", pre), ("reg", LinearRegression())])


def forest_pipeline() -> Pipeline:
    # Trees don't need scaling. Kept fairly small on purpose: the whole
    # forest gets exported to JSON and runs in the browser.
    pre = ColumnTransformer(
        [
            ("num", "passthrough", NUMERIC),
            ("pos", OneHotEncoder(categories=[POSITIONS]), CATEGORICAL),
        ]
    )
    forest = RandomForestRegressor(
        n_estimators=120,
        min_samples_leaf=3,
        max_features=0.6,
        random_state=SEED,
        n_jobs=-1,
    )
    return Pipeline([("prep", pre), ("reg", forest)])


BUILDERS = {"linear": linear_pipeline, "forest": forest_pipeline}


def metrics(actual_m: np.ndarray, predicted_m: np.ndarray) -> dict:
    return {
        "rmse_m": round(float(np.sqrt(mean_squared_error(actual_m, predicted_m))), 2),
        "mae_m": round(float(mean_absolute_error(actual_m, predicted_m)), 2),
        "r2": round(float(r2_score(actual_m, predicted_m)), 3),
        "r2_log": round(float(r2_score(np.log(actual_m), np.log(predicted_m))), 3),
        "n": int(len(actual_m)),
    }


def cross_validate(df: pd.DataFrame, kind: str) -> tuple[np.ndarray, pd.Series]:
    """Out of fold predictions (in euros millions) plus permutation importance
    measured on the held out folds, so neither number is flattered by
    training data."""
    X, y = df[FEATURES], np.log(df["market_value_m"].to_numpy())
    oof = np.zeros(len(df))
    importances = []

    for train_idx, test_idx in KFold(FOLDS, shuffle=True, random_state=SEED).split(X):
        model = BUILDERS[kind]().fit(X.iloc[train_idx], y[train_idx])
        oof[test_idx] = model.predict(X.iloc[test_idx])
        perm = permutation_importance(
            model, X.iloc[test_idx], y[test_idx], n_repeats=8, random_state=SEED, scoring="r2"
        )
        importances.append(pd.Series(perm.importances_mean, index=FEATURES))

    return np.exp(oof), pd.concat(importances, axis=1).mean(axis=1)


def plot_predictions(df: pd.DataFrame, league: str) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(11, 5), sharex=True, sharey=True)
    for ax, kind, title in zip(axes, ["linear", "forest"], ["Linear Regression", "Random Forest"]):
        sns.scatterplot(data=df, x="market_value_m", y=f"pred_{kind}", hue="position", s=22, alpha=0.75, ax=ax)
        lim = [0.3, df[["market_value_m", f"pred_{kind}"]].to_numpy().max() * 1.3]
        ax.plot(lim, lim, color="grey", lw=1, ls=":", label="perfect")
        # line of best fit in log space, since that's where the model lives
        slope, intercept = np.polyfit(np.log(df["market_value_m"]), np.log(df[f"pred_{kind}"]), 1)
        xs = np.geomspace(*lim, 50)
        ax.plot(xs, np.exp(intercept) * xs**slope, color="black", lw=1.4, label="best fit")
        ax.set(xscale="log", yscale="log", xlim=lim, ylim=lim, title=title, xlabel="actual value (EUR m)", ylabel="predicted (EUR m)")
        ax.legend(fontsize=8, loc="upper left")
    fig.suptitle(f"{league}: out of fold predictions")
    fig.tight_layout()
    fig.savefig(REPORTS / f"{slug(league)}_predicted_vs_actual.png", dpi=110)
    plt.close(fig)


def plot_importance(imp: pd.DataFrame, league: str) -> None:
    long = imp.reset_index(names="feature").melt(id_vars="feature", var_name="model", value_name="importance")
    order = imp.mean(axis=1).sort_values(ascending=False).index
    fig, ax = plt.subplots(figsize=(7, 4.5))
    sns.barplot(data=long, y="feature", x="importance", hue="model", order=order, ax=ax)
    ax.set(title=f"{league}: what drives the prediction", xlabel="drop in R2 when the feature is shuffled", ylabel="")
    fig.tight_layout()
    fig.savefig(REPORTS / f"{slug(league)}_importance.png", dpi=110)
    plt.close(fig)


def train_all(verbose: bool = True) -> dict:
    players = load_players()
    MODELS.mkdir(exist_ok=True)
    REPORTS.mkdir(exist_ok=True)
    summary, oof_frames, importance = {}, [], {}

    for league in LEAGUES:
        df = players[players["league"] == league].reset_index(drop=True)
        summary[league] = {}
        imp = {}

        for kind in BUILDERS:
            preds, imp[kind] = cross_validate(df, kind)
            df[f"pred_{kind}"] = preds.round(2)
            summary[league][kind] = metrics(df["market_value_m"].to_numpy(), preds)

            final = BUILDERS[kind]().fit(df[FEATURES], np.log(df["market_value_m"]))
            joblib.dump(final, MODELS / f"{slug(league)}_{kind}.joblib")

        imp = pd.DataFrame(imp)
        importance[league] = imp.round(4).to_dict()
        plot_predictions(df, league)
        plot_importance(imp, league)
        oof_frames.append(df)

        if verbose:
            for kind, m in summary[league].items():
                print(f"{league:15s} {kind:7s} RMSE {m['rmse_m']:6.2f}m  MAE {m['mae_m']:5.2f}m  R2 {m['r2']:.3f}  R2(log) {m['r2_log']:.3f}  n={m['n']}")

    pd.concat(oof_frames).to_csv(REPORTS / "oof_predictions.csv", index=False)
    (REPORTS / "metrics.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    (REPORTS / "importance.json").write_text(json.dumps(importance, indent=2), encoding="utf-8")
    return summary


if __name__ == "__main__":
    train_all()
