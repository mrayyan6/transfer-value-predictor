"""Rebuild everything and push, but only if the data actually changed.

This was a GitHub Action until the first run got a 403: Sofascore blocks
cloud IPs, so it runs from my own machine on a monthly Windows scheduled
task instead (setup is in the README). A push to main is all Vercel needs
to redeploy.

    python refresh.py             fetch, retrain if needed, commit, push
    python refresh.py --no-push   same, but leave the commit local
"""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOG = ROOT / "refresh.log"
OUTPUTS = ["data/processed", "models", "reports", "web/data"]

# when started by the scheduler through pythonw there's no console, so
# child processes would each pop up a window without this flag
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def log(msg: str) -> None:
    line = f"{datetime.now():%Y-%m-%d %H:%M} {msg}"
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    if sys.stdout:
        print(line)


def run(*args: str) -> str:
    result = subprocess.run(
        args, cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
        creationflags=NO_WINDOW, env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    if result.returncode != 0:
        log(f"failed: {' '.join(args)}\n{result.stdout}{result.stderr}")
        raise SystemExit(1)
    return result.stdout.strip()


def python(*args: str) -> str:
    # the venv's python.exe, even when this script runs under pythonw.exe
    exe = Path(sys.executable).with_name("python.exe")
    return run(str(exe if exe.exists() else sys.executable), *args)


def main() -> None:
    push = "--no-push" not in sys.argv
    log("refresh started")

    run("git", "pull", "--ff-only")
    log(python("data_loader.py", "--refresh").splitlines()[-1])

    if not run("git", "status", "--porcelain", "--", "data/processed/players.csv"):
        log("player table unchanged, nothing to do")
        return

    python("model.py")
    python("export_web.py")
    python("-m", "pytest", "-q")

    run("git", "add", *OUTPUTS)
    run("git", "commit", "-m", f"Refresh data {datetime.now():%Y-%m-%d}", "--", *OUTPUTS)
    if push:
        run("git", "push")
    log("committed" + (" and pushed" if push else ", not pushed"))


if __name__ == "__main__":
    main()
