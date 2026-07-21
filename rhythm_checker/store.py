"""Session history in SQLite (stdlib sqlite3): one row per analyzed session,
so weeks of practice add up to a picture no single recording can give.
Legacy JSONL stores migrate automatically on first read."""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .analysis import SessionAnalysis

ENV_VAR = "RHYTHM_CHECKER_STORE"


def default_store_dir() -> Path:
    env = os.environ.get(ENV_VAR)
    if env:
        return Path(env)
    return Path.home() / ".rhythm-checker"


@dataclass
class SessionRecord:
    date: str
    name: str
    file: str
    bpm: float
    subdivision: int
    duration_s: float
    n_hits: int
    anchored: bool
    mean_ms: float
    sd_ms: float
    pct_in_pocket: float
    drift_ms_per_min: float | None
    dense_mean_ms: float | None
    sparse_mean_ms: float | None

    @classmethod
    def from_analysis(cls, a: SessionAnalysis, name: str) -> "SessionRecord":
        return cls(
            date=datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            name=name,
            file=a.file,
            bpm=a.bpm,
            subdivision=a.subdivision,
            duration_s=round(a.duration, 1),
            n_hits=a.overall.n,
            anchored=a.grid.anchored,
            mean_ms=round(a.overall.mean_ms, 2),
            sd_ms=round(a.overall.sd_ms, 2),
            pct_in_pocket=round(a.overall.pct_in_pocket, 1),
            drift_ms_per_min=round(a.drift.slope_ms_per_min, 2) if a.drift else None,
            dense_mean_ms=round(a.dense_stats.mean_ms, 2) if a.dense_stats.n else None,
            sparse_mean_ms=round(a.sparse_stats.mean_ms, 2) if a.sparse_stats.n else None,
        )

    def to_dict(self) -> dict[str, Any]:
        return dict(self.__dict__)


_COLS = ["date", "name", "file", "bpm", "subdivision", "duration_s", "n_hits",
         "anchored", "mean_ms", "sd_ms", "pct_in_pocket", "drift_ms_per_min",
         "dense_mean_ms", "sparse_mean_ms"]


def _connect(store_dir: Path | None) -> tuple[sqlite3.Connection, Path]:
    store = store_dir or default_store_dir()
    store.mkdir(parents=True, exist_ok=True)
    path = store / "sessions.db"
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sessions ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  date TEXT NOT NULL, name TEXT NOT NULL, file TEXT NOT NULL,"
        "  bpm REAL NOT NULL, subdivision INTEGER NOT NULL,"
        "  duration_s REAL NOT NULL, n_hits INTEGER NOT NULL,"
        "  anchored INTEGER NOT NULL, mean_ms REAL NOT NULL, sd_ms REAL NOT NULL,"
        "  pct_in_pocket REAL NOT NULL, drift_ms_per_min REAL,"
        "  dense_mean_ms REAL, sparse_mean_ms REAL)"
    )
    _migrate_legacy_jsonl(conn, store)
    return conn, path


def _migrate_legacy_jsonl(conn: sqlite3.Connection, store: Path) -> None:
    legacy = store / "sessions.jsonl"
    if not legacy.exists():
        return
    skipped = 0
    with legacy.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = _coerce(json.loads(line))
                _insert(conn, rec)
            except (json.JSONDecodeError, TypeError, ValueError, KeyError):
                skipped += 1
    conn.commit()
    legacy.rename(store / "sessions.jsonl.migrated")
    if skipped:
        print(f"warning: skipped {skipped} unreadable line(s) migrating {legacy}",
              file=sys.stderr)


def _insert(conn: sqlite3.Connection, record: SessionRecord) -> None:
    values = [getattr(record, c) for c in _COLS]
    values[_COLS.index("anchored")] = int(record.anchored)
    conn.execute(
        f"INSERT INTO sessions ({', '.join(_COLS)}) "
        f"VALUES ({', '.join('?' * len(_COLS))})",
        values,
    )


def save_record(record: SessionRecord, store_dir: Path | None = None) -> Path:
    conn, path = _connect(store_dir)
    with conn:
        _insert(conn, record)
    conn.close()
    return path


_FIELD_TYPES: dict[str, Any] = {
    "date": str, "name": str, "file": str,
    "bpm": float, "duration_s": float, "mean_ms": float, "sd_ms": float,
    "pct_in_pocket": float,
    "subdivision": int, "n_hits": int,
    "anchored": bool,
    "drift_ms_per_min": "float?", "dense_mean_ms": "float?", "sparse_mean_ms": "float?",
}


def _coerce(data: dict[str, Any]) -> SessionRecord:
    clean: dict[str, Any] = {}
    for key, kind in _FIELD_TYPES.items():
        value = data[key]  # KeyError -> caught by the caller, line skipped
        if kind == "float?":
            clean[key] = None if value is None else float(value)
        elif kind is bool:
            if not isinstance(value, bool):
                raise ValueError(f"{key} must be a bool")
            clean[key] = value
        else:
            clean[key] = kind(value)
    return SessionRecord(**clean)


def load_records(store_dir: Path | None = None) -> list[SessionRecord]:
    store = store_dir or default_store_dir()
    if not (store / "sessions.db").exists() and not (store / "sessions.jsonl").exists():
        return []
    conn, _ = _connect(store_dir)
    rows = conn.execute(
        f"SELECT {', '.join(_COLS)} FROM sessions ORDER BY id"
    ).fetchall()
    conn.close()
    records: list[SessionRecord] = []
    for row in rows:
        data = dict(zip(_COLS, row))
        data["anchored"] = bool(data["anchored"])
        try:
            records.append(_coerce(data))
        except (TypeError, ValueError, KeyError):
            continue  # a hand-edited row; skip, don't crash
    return records


def trend_summary(records: list[SessionRecord]) -> str:
    if not records:
        return "No sessions recorded yet. Run `rhythm-checker analyze` first."
    lines = [
        "PRACTICE HISTORY (newest last)",
        f"{'date':<17}{'name':<18}{'bpm':>5}{'hits':>6}{'mean':>9}{'SD':>8}"
        f"{'pocket':>8}{'drift':>10}",
    ]
    for r in records:
        drift = f"{r.drift_ms_per_min:+.1f}" if r.drift_ms_per_min is not None else "—"
        mean = f"{r.mean_ms:+.1f}" if r.anchored else f"({r.mean_ms:+.1f})"
        lines.append(
            f"{r.date[:16]:<17}{r.name[:17]:<18}{r.bpm:>5g}{r.n_hits:>6}"
            f"{mean:>9}{r.sd_ms:>8.1f}{r.pct_in_pocket:>7.0f}%{drift:>10}"
        )
    lines.append("")
    lines.append("mean in (parens) = unanchored session: grid fitted to the playing,")
    lines.append("so the mean shows balance around the fitted grid, not absolute push/drag.")
    if len(records) >= 3:
        first_sd = sum(r.sd_ms for r in records[: len(records) // 2]) / (len(records) // 2)
        rest = records[len(records) // 2 :]
        last_sd = sum(r.sd_ms for r in rest) / len(rest)
        lines.append("")
        lines.append(
            f"spread (SD): earlier sessions avg {first_sd:.1f} ms → recent avg {last_sd:.1f} ms"
        )
    return "\n".join(lines)
