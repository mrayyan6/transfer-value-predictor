import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import data_loader as dl  # noqa: E402


def test_normalise_handles_letters_nfkd_misses():
    assert dl.normalise("Martin Ødegaard") == "martin odegaard"
    assert dl.normalise("Vinícius Júnior") == "vinicius junior"
    assert dl.normalise("Jakub Kiwior-Łukasz") == "jakub kiwior lukasz"


def test_club_key_ignores_suffixes():
    assert dl.club_key("Arsenal FC") == dl.club_key("Arsenal")
    assert dl.club_key("Real Betis Balompié") == dl.club_key("Real Betis")
    assert dl.club_key("Atlético de Madrid") == "atletico madrid"


def test_match_players_slug_then_fuzzy(monkeypatch):
    monkeypatch.setattr(dl, "MANUAL_MATCHES", Path("does/not/exist.csv"))
    stats = pd.DataFrame(
        {
            "sofascore_id": [1, 2, 3],
            "player_name": ["Bukayo Saka", "Andy Robertson", "Nobody Atall"],
            "slug": ["bukayo-saka", "andy-robertson", "nobody-atall"],
            "team": ["Arsenal", "Liverpool FC", "Arsenal"],
        }
    )
    candidates = pd.DataFrame(
        {
            "player_id": [10, 20, 30],
            "name": ["Bukayo Saka", "Andrew Robertson", "Someone Else"],
            "player_code": ["bukayo-saka", "andrew-robertson", "someone-else"],
            "tm_clubs": [["Arsenal FC"], ["Liverpool FC"], ["Arsenal FC"]],
        }
    )
    out = dl.match_players(stats, candidates).set_index("sofascore_id")
    assert out.loc[1, "tm_player_id"] == 10 and out.loc[1, "match_method"] == "slug"
    assert out.loc[2, "tm_player_id"] == 20 and out.loc[2, "match_method"].startswith("fuzzy")
    assert pd.isna(out.loc[3, "tm_player_id"])


def test_season_window_covers_june_update():
    start, end = dl.season_window("25/26")
    assert start == pd.Timestamp(2025, 8, 1)
    assert end == pd.Timestamp(2026, 7, 15)
