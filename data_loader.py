"""Build the player table the value model trains on.

Stats come from Sofascore's season statistics endpoint, market values from the
Transfermarkt snapshot that dcaribou/transfermarkt-datasets publishes. The two
sources name players differently, so most of this file is about matching them.

Everything downloaded is cached in data/raw/, so reruns are quick and don't
hammer anyone's servers.

    python data_loader.py                 build data/processed/players.csv
    python data_loader.py --refresh       ignore the cache and download again
    python data_loader.py --season 24/25  build an older season instead
"""

from __future__ import annotations

import argparse
import json
import re
import time
import unicodedata
from pathlib import Path

import pandas as pd
from curl_cffi import requests
from rapidfuzz import fuzz, process

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "data" / "raw"
PROCESSED = ROOT / "data" / "processed"
MANUAL_MATCHES = ROOT / "data" / "manual_matches.csv"

SOFASCORE = "https://api.sofascore.com/api/v1"
TRANSFERMARKT = "https://pub-e682421888d945d684bcae8890b0ec20.r2.dev/data"

LEAGUES = {
    "Premier League": {"sofascore": 17, "transfermarkt": "GB1"},
    "La Liga": {"sofascore": 8, "transfermarkt": "ES1"},
}

# Keepers are left out on purpose: goals, key passes and tackles say almost
# nothing about what a goalkeeper is worth.
POSITIONS = {"D": "Defender", "M": "Midfielder", "F": "Forward"}

STAT_FIELDS = {
    "minutesPlayed": "minutes_played",
    "appearances": "appearances",
    "goals": "goals",
    "assists": "assists",
    "shotsOnTarget": "shots_on_target",
    "keyPasses": "key_passes",
    "tackles": "tackles",
}

# A few appearances off the bench tell you nothing, and those players are
# valued on potential or reputation anyway.
MIN_MINUTES = 600

DEFAULT_SEASON = "25/26"

_session: requests.Session | None = None


def _http() -> requests.Session:
    # Sofascore blocks plain python clients, a browser fingerprint gets through.
    global _session
    if _session is None:
        _session = requests.Session(impersonate="chrome")
    return _session


def _get_json(url: str, cache: Path, refresh: bool) -> dict:
    if cache.exists() and not refresh:
        return json.loads(cache.read_text(encoding="utf-8"))

    for attempt in range(4):
        resp = _http().get(url, timeout=30)
        if resp.status_code == 200:
            break
        if resp.status_code in (403, 429) or resp.status_code >= 500:
            time.sleep(5 * (attempt + 1))
            continue
        resp.raise_for_status()
    else:
        raise RuntimeError(f"gave up on {url}, last status {resp.status_code}")

    data = resp.json()
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(data), encoding="utf-8")
    time.sleep(0.8)
    return data


def _download(url: str, dest: Path, refresh: bool) -> Path:
    if dest.exists() and not refresh:
        return dest
    resp = _http().get(url, timeout=120)
    resp.raise_for_status()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(resp.content)
    return dest


# Sofascore

def season_id(tournament: int, season: str, refresh: bool = False) -> int:
    url = f"{SOFASCORE}/unique-tournament/{tournament}/seasons"
    data = _get_json(url, RAW / "sofascore" / f"seasons_{tournament}.json", refresh)
    for s in data["seasons"]:
        if s["year"] == season:
            return s["id"]
    raise ValueError(f"season {season} not found for tournament {tournament}")


def fetch_league_stats(league: str, season: str, refresh: bool = False) -> pd.DataFrame:
    tournament = LEAGUES[league]["sofascore"]
    sid = season_id(tournament, season, refresh)
    fields = ",".join(STAT_FIELDS)
    rows = []

    for code, position in POSITIONS.items():
        page = 0
        while True:
            # page size is capped at 100, anything bigger silently falls back to 10
            url = (
                f"{SOFASCORE}/unique-tournament/{tournament}/season/{sid}/statistics"
                f"?limit=100&offset={page * 100}&order=-minutesPlayed"
                f"&accumulation=total&fields={fields}&filters=position.in.{code}"
            )
            cache = RAW / "sofascore" / f"stats_{tournament}_{sid}_{code}_{page}.json"
            data = _get_json(url, cache, refresh)

            for r in data["results"]:
                row = {new: r.get(old) for old, new in STAT_FIELDS.items()}
                row.update(
                    sofascore_id=r["player"]["id"],
                    player_name=r["player"]["name"],
                    slug=r["player"]["slug"],
                    team=r["team"]["name"],
                    team_id=r["team"]["id"],
                    position=position,
                    league=league,
                )
                rows.append(row)

            page += 1
            if page >= data["pages"]:
                break

    df = pd.DataFrame(rows)
    stat_cols = list(STAT_FIELDS.values())
    df[stat_cols] = df[stat_cols].fillna(0).astype(int)
    return df


def fetch_team_strength(league: str, season: str, refresh: bool = False) -> pd.DataFrame:
    """Points per game for every club, used as a rough 'how big is this club' signal."""
    tournament = LEAGUES[league]["sofascore"]
    sid = season_id(tournament, season, refresh)
    url = f"{SOFASCORE}/unique-tournament/{tournament}/season/{sid}/standings/total"
    data = _get_json(url, RAW / "sofascore" / f"standings_{tournament}_{sid}.json", refresh)
    rows = data["standings"][0]["rows"]
    return pd.DataFrame(
        {
            "team_id": r["team"]["id"],
            "team_ppg": round(r["points"] / max(r["matches"], 1), 3),
            "league_position": r["position"],
        }
        for r in rows
    )


# Transfermarkt

def load_transfermarkt(refresh: bool = False) -> tuple[pd.DataFrame, pd.DataFrame]:
    folder = RAW / "transfermarkt"
    players = pd.read_csv(
        _download(f"{TRANSFERMARKT}/players.csv.gz", folder / "players.csv.gz", refresh),
        parse_dates=["date_of_birth"],
    )
    valuations = pd.read_csv(
        _download(f"{TRANSFERMARKT}/player_valuations.csv.gz", folder / "player_valuations.csv.gz", refresh),
        parse_dates=["date"],
    )
    return players, valuations


def season_window(season: str) -> tuple[pd.Timestamp, pd.Timestamp]:
    # Transfermarkt usually does a big update in early June, right after the
    # season ends, so the window runs a little past the last matchday.
    start_year = 2000 + int(season[:2])
    return pd.Timestamp(start_year, 8, 1), pd.Timestamp(start_year + 1, 7, 15)


def value_candidates(players: pd.DataFrame, valuations: pd.DataFrame, league: str, season: str) -> pd.DataFrame:
    """Latest valuation inside the season window for everyone valued at a club in this league."""
    comp = LEAGUES[league]["transfermarkt"]
    start, end = season_window(season)
    window = valuations[(valuations["date"] >= start) & (valuations["date"] <= end)]
    in_league = window.loc[window["player_club_domestic_competition_id"] == comp, "player_id"].unique()

    latest = (
        window[window["player_id"].isin(in_league)]
        .sort_values("date")
        .groupby("player_id")
        .tail(1)
        .rename(columns={"date": "value_date", "current_club_name": "tm_club"})
    )
    clubs_seen = (
        window[window["player_id"].isin(in_league)]
        .groupby("player_id")["current_club_name"]
        .agg(lambda s: sorted(set(s)))
        .rename("tm_clubs")
    )
    info = players[["player_id", "name", "player_code", "date_of_birth"]]
    out = latest.merge(info, on="player_id", how="left").merge(clubs_seen, on="player_id", how="left")
    return out[["player_id", "name", "player_code", "date_of_birth", "tm_club", "tm_clubs", "market_value_in_eur", "value_date"]]


# Matching the two sources

# NFKD strips most accents but leaves letters like ø and ł alone.
_SPECIAL = str.maketrans({"ø": "o", "Ø": "o", "æ": "ae", "Æ": "ae", "ß": "ss", "ł": "l", "Ł": "l", "đ": "d", "Đ": "d", "ı": "i", "þ": "th"})


def normalise(text: str) -> str:
    text = str(text).translate(_SPECIAL)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-z0-9 ]", " ", text.lower())
    return re.sub(r"\s+", " ", text).strip()


_CLUB_NOISE = {"fc", "cf", "afc", "cd", "ud", "sd", "rcd", "ca", "de", "club", "balompie", "football"}


def club_key(name: str) -> str:
    words = [w for w in normalise(name).split() if w not in _CLUB_NOISE]
    return " ".join(words)


def _same_club(sofa_team: str, tm_clubs) -> bool:
    if not isinstance(tm_clubs, list):
        return False
    key = club_key(sofa_team)
    return any(fuzz.token_set_ratio(key, club_key(c)) >= 85 for c in tm_clubs)


def match_players(stats: pd.DataFrame, candidates: pd.DataFrame) -> pd.DataFrame:
    """Attach a Transfermarkt player_id to each Sofascore row where we can.

    Order of attempts: manual overrides, identical URL slug, identical cleaned
    name, then fuzzy name matching that needs a club match to accept anything
    less than near certain.
    """
    stats = stats.copy()
    stats["tm_player_id"] = pd.NA
    stats["match_method"] = ""

    if MANUAL_MATCHES.exists():
        manual = pd.read_csv(MANUAL_MATCHES).dropna(subset=["tm_player_id"])
        lookup = dict(zip(manual["sofascore_id"], manual["tm_player_id"].astype(int)))
        hit = stats["sofascore_id"].map(lookup)
        stats.loc[hit.notna(), "tm_player_id"] = hit[hit.notna()]
        stats.loc[hit.notna(), "match_method"] = "manual"

    by_slug = dict(zip(candidates["player_code"], candidates["player_id"]))
    todo = stats["tm_player_id"].isna()
    slug_hit = stats.loc[todo, "slug"].map(by_slug)
    stats.loc[slug_hit.dropna().index, "tm_player_id"] = slug_hit.dropna()
    stats.loc[slug_hit.dropna().index, "match_method"] = "slug"

    cand = candidates.assign(key=candidates["name"].map(normalise))
    name_counts = cand["key"].value_counts()
    unique_names = cand[cand["key"].map(name_counts) == 1]
    by_name = dict(zip(unique_names["key"], unique_names["player_id"]))
    todo = stats["tm_player_id"].isna()
    name_hit = stats.loc[todo, "player_name"].map(normalise).map(by_name)
    stats.loc[name_hit.dropna().index, "tm_player_id"] = name_hit.dropna()
    stats.loc[name_hit.dropna().index, "match_method"] = "name"

    keys = cand["key"].tolist()
    for idx in stats.index[stats["tm_player_id"].isna()]:
        row = stats.loc[idx]
        best = process.extract(normalise(row["player_name"]), keys, scorer=fuzz.WRatio, limit=3)
        for _, score, pos in best:
            c = cand.iloc[pos]
            club_ok = _same_club(row["team"], c["tm_clubs"])
            if score >= 95 or (score >= 80 and club_ok):
                stats.loc[idx, "tm_player_id"] = c["player_id"]
                stats.loc[idx, "match_method"] = f"fuzzy {score:.0f}"
                break

    # If two Sofascore rows landed on the same Transfermarkt player, trust neither.
    dupes = stats["tm_player_id"].notna() & stats.duplicated("tm_player_id", keep=False)
    stats.loc[dupes, ["tm_player_id", "match_method"]] = [pd.NA, ""]
    return stats


# Putting it together

def build(season: str = DEFAULT_SEASON, refresh: bool = False, verbose: bool = True) -> pd.DataFrame:
    players, valuations = load_transfermarkt(refresh)
    frames = []

    for league in LEAGUES:
        stats = fetch_league_stats(league, season, refresh)
        stats = stats.merge(fetch_team_strength(league, season, refresh), on="team_id", how="left")
        stats = stats[stats["minutes_played"] >= MIN_MINUTES]

        candidates = value_candidates(players, valuations, league, season)
        matched = match_players(stats, candidates)

        if verbose:
            n, ok = len(matched), matched["tm_player_id"].notna().sum()
            print(f"{league}: {ok}/{n} players matched to a market value")
            misses = matched.loc[matched["tm_player_id"].isna(), ["player_name", "team"]]
            if len(misses):
                print("  unmatched:", ", ".join(f"{p} ({t})" for p, t in misses.head(12).values))

        matched = matched.dropna(subset=["tm_player_id"])
        matched["tm_player_id"] = matched["tm_player_id"].astype(int)
        frames.append(
            matched.merge(
                candidates[["player_id", "date_of_birth", "market_value_in_eur", "value_date"]],
                left_on="tm_player_id",
                right_on="player_id",
                how="left",
            ).drop(columns="player_id")
        )

    df = pd.concat(frames, ignore_index=True)
    df["age"] = ((df["value_date"] - df["date_of_birth"]).dt.days / 365.25).round(1)
    df["market_value_m"] = (df["market_value_in_eur"] / 1e6).round(2)
    df["season"] = season

    columns = [
        "player_name", "team", "league", "age", "position",
        "minutes_played", "appearances", "goals", "assists",
        "shots_on_target", "key_passes", "tackles",
        "team_ppg", "league_position", "market_value_m",
        "season", "value_date", "sofascore_id", "tm_player_id", "match_method",
    ]
    df = df.dropna(subset=["age", "market_value_m"])[columns]
    return df.sort_values(["league", "market_value_m"], ascending=[True, False]).reset_index(drop=True)


def load_players() -> pd.DataFrame:
    """Read the processed table. Used by model.py and export_web.py."""
    return pd.read_csv(PROCESSED / "players.csv", parse_dates=["value_date"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--season", default=DEFAULT_SEASON, help="Sofascore season label, e.g. 25/26")
    parser.add_argument("--refresh", action="store_true", help="download again instead of using data/raw")
    args = parser.parse_args()

    df = build(args.season, args.refresh)
    PROCESSED.mkdir(parents=True, exist_ok=True)
    out = PROCESSED / "players.csv"
    df.to_csv(out, index=False)
    print(f"wrote {len(df)} players to {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
