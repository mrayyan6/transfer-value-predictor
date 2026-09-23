"""Turn the trained models into JSON the site can run without a server.

Linear models become their scaler statistics plus coefficients. Random
forests become flat arrays per tree (feature, threshold, left, right, value),
which a few lines of JavaScript can walk. The player table goes along with
the out of fold predictions, so the verdicts on the site are honest ones.

    python export_web.py
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from model import CATEGORICAL, MODELS, NUMERIC, POSITIONS, REPORTS, slug

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "web" / "data"


def export_linear(pipe) -> dict:
    prep, reg = pipe.named_steps["prep"], pipe.named_steps["reg"]
    num = prep.named_transformers_["num"]
    age_sq = prep.named_transformers_["age_sq"].named_steps["standardscaler"]
    pos = prep.named_transformers_["pos"]

    n_num = len(NUMERIC)
    coef = reg.coef_
    # drop="first" means the first position is the baseline and gets no coefficient
    dropped = pos.categories_[0][pos.drop_idx_[0]]
    kept_positions = [p for p in pos.categories_[0] if p != dropped]

    return {
        "type": "linear",
        "numeric": NUMERIC,
        "mean": num.mean_.round(6).tolist(),
        "scale": num.scale_.round(6).tolist(),
        "coef": coef[:n_num].round(6).tolist(),
        "ageSq": {
            "mean": round(float(age_sq.mean_[0]), 6),
            "scale": round(float(age_sq.scale_[0]), 6),
            "coef": round(float(coef[n_num]), 6),
        },
        "position": {p: round(float(c), 6) for p, c in zip(kept_positions, coef[n_num + 1:])},
        "intercept": round(float(reg.intercept_), 6),
    }


def export_forest(pipe) -> dict:
    forest = pipe.named_steps["reg"]
    columns = NUMERIC + [f"position={p}" for p in POSITIONS]
    trees = []
    for est in forest.estimators_:
        t = est.tree_
        trees.append(
            {
                # leaves have feature -2 in sklearn, -1 reads nicer in JS
                "f": np.where(t.feature < 0, -1, t.feature).tolist(),
                # Full precision on purpose. sklearn compares float32 inputs
                # against thresholds that sit right next to them (26.2 vs
                # 26.19999998), so rounding sends some players down the
                # wrong branch.
                "t": t.threshold.tolist(),
                "l": t.children_left.tolist(),
                "r": t.children_right.tolist(),
                "v": np.round(t.value[:, 0, 0], 4).tolist(),
            }
        )
    return {"type": "forest", "columns": columns, "trees": trees}


def slider_ranges(df: pd.DataFrame) -> dict:
    ranges = {}
    for col in NUMERIC:
        lo, hi = float(df[col].min()), float(df[col].max())
        if col in ("age", "team_ppg"):
            ranges[col] = [round(lo, 1), round(hi, 1)]
        else:
            ranges[col] = [0, int(np.ceil(hi * 1.1))]
    return ranges


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "models").mkdir(exist_ok=True)

    oof = pd.read_csv(REPORTS / "oof_predictions.csv")
    metrics = json.loads((REPORTS / "metrics.json").read_text(encoding="utf-8"))
    importance = json.loads((REPORTS / "importance.json").read_text(encoding="utf-8"))

    leagues = {}
    for league, frame in oof.groupby("league", sort=False):
        key = slug(league)
        for kind, exporter in (("linear", export_linear), ("forest", export_forest)):
            pipe = joblib.load(MODELS / f"{key}_{kind}.joblib")
            payload = exporter(pipe)
            (OUT / "models" / f"{key}_{kind}.json").write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")

        teams = (
            frame.groupby("team")[["team_ppg", "league_position"]]
            .first()
            .sort_values("league_position")
            .reset_index()
        )
        leagues[league] = {
            "key": key,
            "metrics": metrics[league],
            "importance": importance[league],
            "ranges": slider_ranges(frame),
            "teams": teams.to_dict(orient="records"),
            "players": int(len(frame)),
        }

    players = oof.rename(
        columns={
            "player_name": "name",
            "market_value_m": "value",
            "pred_linear": "linear",
            "pred_forest": "forest",
            "sofascore_id": "id",
        }
    )
    keep = ["id", "name", "team", "league", *NUMERIC, *CATEGORICAL, "appearances", "value", "linear", "forest"]
    (OUT / "players.json").write_text(
        json.dumps(players[keep].to_dict(orient="records"), ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    season = str(oof["season"].iloc[0])
    meta = {
        "season": f"20{season[:2]}/{season[3:]}",
        "valuesAsOf": str(pd.to_datetime(oof["value_date"]).max().date()),
        "exported": date.today().isoformat(),
        "numeric": NUMERIC,
        "positions": POSITIONS,
        "leagues": leagues,
    }
    (OUT / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

    sizes = {p.relative_to(OUT).as_posix(): round(p.stat().st_size / 1024) for p in OUT.rglob("*.json")}
    print("exported:", ", ".join(f"{k} {v}KB" for k, v in sizes.items()))


if __name__ == "__main__":
    main()
