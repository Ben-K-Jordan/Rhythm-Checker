"""Session statistics: the honest numbers, and nothing else.

Everything here describes timing relative to the metronome grid. None of it
scores, grades, or judges the playing — that part is deliberately absent.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .grid import Alignment, Grid, MAX_DEVIATION_FRACTION, align, build_grid
from .onsets import OnsetList

DENSITY_WINDOW = 2.0   # seconds
DENSITY_STEP = 0.5     # seconds
DENSITY_FACTOR = 1.5   # a window this many times the median density is "dense"


@dataclass
class Stats:
    n: int
    mean_ms: float
    median_ms: float
    sd_ms: float
    pct_early: float
    pct_late: float
    pct_in_pocket: float

    @classmethod
    def from_deviations(cls, dev_ms: np.ndarray, pocket_ms: float) -> "Stats":
        if len(dev_ms) == 0:
            return cls(0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
        return cls(
            n=len(dev_ms),
            mean_ms=float(np.mean(dev_ms)),
            median_ms=float(np.median(dev_ms)),
            sd_ms=float(np.std(dev_ms, ddof=1)) if len(dev_ms) > 1 else 0.0,
            pct_early=100.0 * float(np.mean(dev_ms < 0)),
            pct_late=100.0 * float(np.mean(dev_ms > 0)),
            pct_in_pocket=100.0 * float(np.mean(np.abs(dev_ms) <= pocket_ms)),
        )

    def to_dict(self) -> dict[str, Any]:
        return {k: round(v, 2) if isinstance(v, float) else v for k, v in self.__dict__.items()}


@dataclass
class Drift:
    slope_ms_per_min: float
    correlation: float
    first_half: Stats
    second_half: Stats


@dataclass
class DensePassage:
    start: float
    end: float
    n_hits: int
    mean_ms: float


@dataclass
class SessionAnalysis:
    file: str
    duration: float
    bpm: float
    subdivision: int
    grid: Grid
    alignment: Alignment
    pocket_ms: float
    overall: Stats
    drift: Drift | None
    dense_passages: list[DensePassage]
    dense_stats: Stats
    sparse_stats: Stats
    position_stats: dict[int, Stats] = field(default_factory=dict)
    n_detected: int = 0
    count_in: int = 0
    grid_fit: float = 1.0  # circular concentration of hits on the grid, 0..1
    fit_warning: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "file": self.file,
            "duration_s": round(self.duration, 2),
            "bpm": self.bpm,
            "subdivision": self.subdivision,
            "count_in": self.count_in,
            "grid": {
                "fit": round(self.grid_fit, 3),
                "fit_warning": self.fit_warning,
                "anchored": self.grid.anchored,
                "offset_s": round(self.grid.offset, 4),
                "tempo_correction": round(self.grid.tempo_correction, 6),
                "effective_bpm": round(60.0 / self.grid.beat_interval, 3),
                "count_in_warning": self.grid.count_in_warning,
            },
            "hits": {
                "detected": self.n_detected,
                "aligned": len(self.alignment.deviations_ms),
                "unaligned": len(self.alignment.unaligned_times),
            },
            "pocket_ms": self.pocket_ms,
            "overall": self.overall.to_dict(),
            "drift": None
            if self.drift is None
            else {
                "slope_ms_per_min": round(self.drift.slope_ms_per_min, 2),
                "correlation": round(self.drift.correlation, 3),
                "first_half": self.drift.first_half.to_dict(),
                "second_half": self.drift.second_half.to_dict(),
            },
            "dense_passages": [
                {
                    "start_s": round(p.start, 2),
                    "end_s": round(p.end, 2),
                    "n_hits": p.n_hits,
                    "mean_ms": round(p.mean_ms, 2),
                }
                for p in self.dense_passages
            ],
            "dense": self.dense_stats.to_dict(),
            "sparse": self.sparse_stats.to_dict(),
            "positions": {str(k): v.to_dict() for k, v in self.position_stats.items()},
            "per_hit": {
                "times_s": [round(float(t), 4) for t in self.alignment.times],
                "deviations_ms": [round(float(d), 2) for d in self.alignment.deviations_ms],
                "unaligned_times_s": [round(float(t), 4) for t in self.alignment.unaligned_times],
            },
        }


def analyze_session(
    onsets: OnsetList,
    *,
    file: str,
    duration: float,
    bpm: float,
    subdivision: int = 4,
    count_in: int = 0,
    fit_tempo: bool = False,
    pocket_ms: float = 10.0,
) -> SessionAnalysis:
    if len(onsets) < max(4, count_in + 4):
        raise ValueError(
            f"only {len(onsets)} hits detected — not enough to analyze. "
            "Is the recording very quiet? Try --sensitivity 1.5."
        )

    grid, performance = build_grid(
        onsets.times, bpm, subdivision, count_in=count_in, fit_tempo=fit_tempo
    )
    alignment = align(performance, grid)
    dev, times = alignment.deviations_ms, alignment.times

    # Concentration of hits on the grid (offset-independent, 0..1). A fine grid
    # is always "near" every hit, so alignment fraction alone can't catch a
    # wrong BPM — but hits from an unrelated tempo don't *concentrate*.
    grid_fit = float(np.abs(np.mean(np.exp(2j * np.pi * performance / grid.interval))))
    if grid_fit < 0.15 or len(dev) < 4:
        raise ValueError(
            "the hits do not line up with this grid at any offset — the BPM is "
            f"probably wrong (got --bpm {bpm:g}, grid fit {grid_fit:.2f}). "
            "Re-check the metronome setting for this recording."
        )
    fit_warning = None
    if grid_fit < 0.35:
        fit_warning = (
            f"weak grid fit ({grid_fit:.2f}): either this take is far looser than "
            "the grid, or the --bpm/--subdivision doesn't match what was played. "
            "Treat the numbers below with suspicion."
        )

    overall = Stats.from_deviations(dev, pocket_ms)
    drift = _drift(times, dev, pocket_ms)
    passages, dense_mask = _dense_passages(performance, times, dev)
    dense_stats = Stats.from_deviations(dev[dense_mask], pocket_ms)
    sparse_stats = Stats.from_deviations(dev[~dense_mask], pocket_ms)

    position_stats: dict[int, Stats] = {}
    if grid.anchored:
        for pos in range(subdivision):
            sel = alignment.positions == pos
            if int(np.sum(sel)) >= 3:
                position_stats[pos] = Stats.from_deviations(dev[sel], pocket_ms)

    return SessionAnalysis(
        file=file,
        duration=duration,
        bpm=bpm,
        subdivision=subdivision,
        grid=grid,
        alignment=alignment,
        pocket_ms=pocket_ms,
        overall=overall,
        drift=drift,
        dense_passages=passages,
        dense_stats=dense_stats,
        sparse_stats=sparse_stats,
        position_stats=position_stats,
        n_detected=len(onsets),
        count_in=count_in,
        grid_fit=grid_fit,
        fit_warning=fit_warning,
    )


def _drift(times: np.ndarray, dev_ms: np.ndarray, pocket_ms: float) -> Drift | None:
    span_min = (float(times[-1]) - float(times[0])) / 60.0
    if len(times) < 8 or span_min < 0.25:
        return None
    minutes = (times - times[0]) / 60.0
    slope, _ = np.polyfit(minutes, dev_ms, 1)
    if np.std(dev_ms) < 1e-9:
        corr = 0.0
    else:
        corr = float(np.corrcoef(minutes, dev_ms)[0, 1])
    mid = float(times[0]) + (float(times[-1]) - float(times[0])) / 2.0
    first = times <= mid
    return Drift(
        slope_ms_per_min=float(slope),
        correlation=corr,
        first_half=Stats.from_deviations(dev_ms[first], pocket_ms),
        second_half=Stats.from_deviations(dev_ms[~first], pocket_ms),
    )


def _dense_passages(
    all_times: np.ndarray, times: np.ndarray, dev_ms: np.ndarray
) -> tuple[list[DensePassage], np.ndarray]:
    """Windows with well-above-median hit density — a proxy for fills and busy
    passages. Reported as 'high-density', never as 'fills': the tool cannot
    know what was a fill, only what was busy.

    Density is counted over *every* detected hit (``all_times``): a fill often
    subdivides finer than the analysis grid, and its off-grid hits are exactly
    what makes it busy. Timing stats still use only the aligned hits."""
    all_times = np.sort(all_times)
    dense_mask = np.zeros(len(times), dtype=bool)
    if len(times) < 8:
        return [], dense_mask
    t0, t1 = float(all_times[0]), float(all_times[-1])
    if t1 - t0 < 2 * DENSITY_WINDOW:
        return [], dense_mask

    starts = np.arange(t0, t1 - DENSITY_WINDOW + 1e-9, DENSITY_STEP)
    counts = np.array(
        [np.searchsorted(all_times, s + DENSITY_WINDOW) - np.searchsorted(all_times, s)
         for s in starts]
    )
    median = float(np.median(counts[counts > 0])) if np.any(counts > 0) else 0.0
    threshold = max(4.0, DENSITY_FACTOR * median)
    hot = counts >= threshold
    if not np.any(hot) or np.all(hot):
        return [], dense_mask

    passages: list[DensePassage] = []
    i = 0
    while i < len(hot):
        if hot[i]:
            j = i
            while j + 1 < len(hot) and hot[j + 1]:
                j += 1
            start, end = float(starts[i]), float(starts[j]) + DENSITY_WINDOW
            sel = (times >= start) & (times <= end)
            dense_mask |= sel
            n_all = int(np.searchsorted(all_times, end) - np.searchsorted(all_times, start))
            passages.append(
                DensePassage(
                    start=start,
                    end=end,
                    n_hits=n_all,
                    mean_ms=float(np.mean(dev_ms[sel])) if np.any(sel) else 0.0,
                )
            )
            i = j + 1
        else:
            i += 1
    return passages, dense_mask


def max_deviation_ms(grid: Grid) -> float:
    return MAX_DEVIATION_FRACTION * grid.interval * 1000.0
