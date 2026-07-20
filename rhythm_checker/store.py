"""Session history: one JSON line per analyzed session, so weeks of practice
add up to a picture no single recording can give."""

from __future__ import annotations

import json
import os
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


def save_record(record: SessionRecord, store_dir: Path | None = None) -> Path:
    store = store_dir or default_store_dir()
    store.mkdir(parents=True, exist_ok=True)
    path = store / "sessions.jsonl"
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record.to_dict()) + "\n")
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
    path = (store_dir or default_store_dir()) / "sessions.jsonl"
    if not path.exists():
        return []
    records: list[SessionRecord] = []
    skipped = 0
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(_coerce(json.loads(line)))
            except (json.JSONDecodeError, TypeError, ValueError, KeyError):
                skipped += 1  # a hand-edited or older-format line; skip, don't crash
    if skipped:
        print(
            f"warning: skipped {skipped} unreadable line(s) in {path}",
            file=sys.stderr,
        )
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
