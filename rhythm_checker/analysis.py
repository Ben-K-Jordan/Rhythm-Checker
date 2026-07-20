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
    n_hits: int        # every detected hit in the passage, on-grid or not
    n_aligned: int     # the subset with a measurable deviation
    mean_ms: float | None  # None when no hit in the passage could be attributed


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
    sample_rate: int | None = None
    precision_warning: str | None = None

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
                "count_in": self.count_in,
                "skipped_after_count_in": self.grid.n_skipped_after_count_in,
                "aligned": len(self.alignment.deviations_ms),
                "unaligned": len(self.alignment.unaligned_times),
            },
            "sample_rate": self.sample_rate,
            "precision_warning": self.precision_warning,
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
                    "n_aligned": p.n_aligned,
                    "mean_ms": None if p.mean_ms is None else round(p.mean_ms, 2),
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
    sample_rate: int | None = None,
) -> SessionAnalysis:
    if len(onsets) < max(4, count_in + 4):
        raise ValueError(
            f"only {len(onsets)} hits detected — not enough to analyze. "
            "Confirm the recording contains the playing; if the take is just "
            "quiet, try --sensitivity 1.5."
        )

    grid, performance = build_grid(
        onsets.times, bpm, subdivision, count_in=count_in, fit_tempo=fit_tempo
    )
    alignment = align(performance, grid)
    dev, times = alignment.deviations_ms, alignment.times

    # Concentration of hits on the grid (offset-independent, 0..1). A fine grid
    # is always "near" every hit, so alignment fraction alone can't catch a
    # wrong BPM — but hits from an unrelated tempo don't *concentrate*.
    def concentration(interval: float) -> float:
        return float(np.abs(np.mean(np.exp(2j * np.pi * performance / interval))))

    grid_fit = concentration(grid.interval)
    beat_fit = concentration(grid.beat_interval)
    if grid_fit < 0.15:
        if beat_fit >= 0.35:
            # the tempo is right — the subdivision grid is what doesn't fit
            raise ValueError(
                f"the hits line up with the beat at {bpm:g} BPM but not with the "
                f"1-in-{subdivision} subdivision grid (grid fit {grid_fit:.2f}). "
                "Either the take is far looser than that grid can measure, or "
                f"--subdivision {subdivision} is finer than what was played — "
                "try a coarser --subdivision."
            )
        raise ValueError(
            "the hits do not line up with this grid at any offset — the BPM is "
            f"probably wrong (got --bpm {bpm:g}, grid fit {grid_fit:.2f}). "
            "Re-check the metronome setting for this recording."
        )
    if len(dev) < 4:
        raise ValueError(
            f"only {len(dev)} hits could be attributed to grid positions — "
            "too few to compute honest statistics."
        )
    fit_warning = _fit_warning(grid_fit, dev, performance, grid)

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
        sample_rate=sample_rate,
        precision_warning=(
            None
            if sample_rate is None or sample_rate >= 16000
            else (
                f"recorded at {sample_rate} Hz — onset timing precision degrades "
                "at low sample rates, so several ms of the spread below may be "
                "measurement error, not you. Record at 44.1 kHz if you can."
            )
        ),
    )


def _fit_warning(
    grid_fit: float, dev_ms: np.ndarray, performance: np.ndarray, grid: Grid
) -> str | None:
    """Warnings for grids that fit, but suspiciously."""
    if grid_fit < 0.35:
        return (
            f"weak grid fit ({grid_fit:.2f}): either this take is far looser than "
            "the grid, or the --bpm/--subdivision doesn't match what was played. "
            "Treat the numbers below with suspicion."
        )
    # Two well-separated clusters of deviations = swung/shuffled playing measured
    # against a straight grid (or vice versa). The mixture inflates the spread
    # with a number that describes neither cluster — say so instead of hiding it.
    # A *small* gap (one position consistently a few ms late) is normal playing;
    # the position table reports it, so only flag gaps that are large relative
    # to the grid and that actually degrade the fit or point to another grid.
    min_gap = max(8.0, 0.15 * grid.interval * 1000.0)
    split = _bimodal_split(dev_ms, min_gap)
    if split is not None:
        better = _better_subdivision(performance, grid)
        if better is not None or grid_fit < 0.6:
            hint = (
                f" A 1-in-{better} subdivision grid fits these hits markedly "
                f"better — try --subdivision {better}." if better else ""
            )
            return (
                f"hits land in two distinct clusters about {split:.0f} ms apart — "
                "this looks like swung or shuffled playing measured against a "
                "straight grid. The spread and pocket numbers describe the "
                f"mixture, not your consistency.{hint}"
            )
    return None


def _bimodal_split(dev_ms: np.ndarray, min_gap: float) -> float | None:
    """Cluster-gap size in ms if the deviations are strongly two-clustered."""
    if len(dev_ms) < 20:
        return None
    lo, hi = float(np.percentile(dev_ms, 10)), float(np.percentile(dev_ms, 90))
    if hi - lo < 1e-6:
        return None
    c1, c2 = lo, hi  # 2-means in one dimension
    for _ in range(25):
        assign = np.abs(dev_ms - c1) <= np.abs(dev_ms - c2)
        if not np.any(assign) or np.all(assign):
            return None
        n1, n2 = c1, c2
        c1, c2 = float(np.mean(dev_ms[assign])), float(np.mean(dev_ms[~assign]))
        if abs(c1 - n1) + abs(c2 - n2) < 1e-9:
            break
    share = float(np.mean(assign))
    if not 0.2 <= share <= 0.8:
        return None
    within = np.concatenate([dev_ms[assign] - c1, dev_ms[~assign] - c2])
    pooled_sd = float(np.std(within)) or 1e-9
    gap = abs(c2 - c1)
    return gap if gap > 3.0 * pooled_sd and gap > min_gap else None


def _better_subdivision(performance: np.ndarray, grid: Grid) -> int | None:
    """A coarser-or-triplet subdivision whose grid the hits concentrate on
    markedly better than the one analyzed, if any."""
    current = float(np.abs(np.mean(np.exp(2j * np.pi * performance / grid.interval))))
    best, best_fit = None, current
    for cand in (1, 2, 3, 4, 6, 8):
        if cand == grid.subdivision:
            continue
        interval = grid.beat_interval / cand
        fit = float(np.abs(np.mean(np.exp(2j * np.pi * performance / interval))))
        if fit > best_fit + 0.15:
            best, best_fit = cand, fit
    return best


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

    # runs of hot windows -> spans; overlapping spans merged so no hit is
    # counted in two passages (window length > step, so runs can overlap)
    spans: list[list[float]] = []
    i = 0
    while i < len(hot):
        if hot[i]:
            j = i
            while j + 1 < len(hot) and hot[j + 1]:
                j += 1
            start, end = float(starts[i]), float(starts[j]) + DENSITY_WINDOW
            if spans and start <= spans[-1][1]:
                spans[-1][1] = max(spans[-1][1], end)
            else:
                spans.append([start, end])
            i = j + 1
        else:
            i += 1

    passages: list[DensePassage] = []
    for start, end in spans:
        sel = (times >= start) & (times <= end)
        dense_mask |= sel
        n_aligned = int(np.sum(sel))
        n_all = int(np.searchsorted(all_times, end) - np.searchsorted(all_times, start))
        passages.append(
            DensePassage(
                start=start,
                end=end,
                n_hits=n_all,
                n_aligned=n_aligned,
                mean_ms=float(np.mean(dev_ms[sel])) if n_aligned else None,
            )
        )
    return passages, dense_mask


def max_deviation_ms(grid: Grid) -> float:
    return MAX_DEVIATION_FRACTION * grid.interval * 1000.0
