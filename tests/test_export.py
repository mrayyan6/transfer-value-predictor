"""The site must give the same numbers as the python models.

Runs every exported model through the JavaScript in web/js/model.js (with
node) and compares against the joblib pipelines on the full player table.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from model import FEATURES, MODELS, slug  # noqa: E402

NODE = shutil.which("node")
WEB_MODELS = ROOT / "web" / "data" / "models"


@pytest.mark.skipif(NODE is None, reason="node not installed")
@pytest.mark.parametrize("league", ["Premier League", "La Liga"])
@pytest.mark.parametrize("kind", ["linear", "forest"])
def test_browser_matches_python(league, kind, tmp_path):
    players = pd.read_csv(ROOT / "data" / "processed" / "players.csv")
    players = players[players["league"] == league]

    pipe = joblib.load(MODELS / f"{slug(league)}_{kind}.joblib")
    expected = np.exp(pipe.predict(players[FEATURES]))

    rows = tmp_path / "players.json"
    rows.write_text(players[FEATURES].to_json(orient="records"), encoding="utf-8")
    out = subprocess.run(
        [NODE, str(ROOT / "tests" / "js_predictions.mjs"), str(WEB_MODELS / f"{slug(league)}_{kind}.json"), str(rows)],
        capture_output=True, text=True, check=True,
    )
    got = np.array(json.loads(out.stdout))

    np.testing.assert_allclose(got, expected, rtol=1e-3)
