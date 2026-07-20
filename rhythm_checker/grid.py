"""Metronome grid: where the click actually was, and how far each hit landed from it.

Sign convention everywhere: negative deviation = early (ahead of the click),
positive = late (behind the click).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

MAX_DEVIATION_FRACTION = 0.4  # farther than this from any grid line => unaligned


@dataclass
class Grid:
    bpm: float
    subdivision: int  # grid lines per beat: 1=quarters, 2=eighths, 4=sixteenths
    offset: float     # seconds; a grid line falls on offset + k * interval
    anchored: bool    # True when the offset came from a count-in, not from the hits
    tempo_correction: float = 1.0  # applied multiplier on the beat interval
    count_in_warning: str | None = None

    @property
    def beat_interval(self) -> float:
        return 60.0 / self.bpm * self.tempo_correction

    @property
    def interval(self) -> float:
        return self.beat_interval / self.subdivision


@dataclass
class Alignment:
    deviations_ms: np.ndarray   # signed, one per aligned hit
    times: np.ndarray           # seconds, one per aligned hit
    positions: np.ndarray       # grid index mod subdivision, one per aligned hit
    unaligned_times: np.ndarray  # hits too far from any grid line to attribute
    grid: Grid = field(repr=False, default=None)  # type: ignore[assignment]


def circular_phase(times: np.ndarray, interval: float) -> float:
    """Offset in [0, interval) that best centers the grid on these times."""
    z = np.exp(2j * np.pi * times / interval).mean()
    if np.abs(z) < 1e-12:
        return 0.0
    return float((np.angle(z) / (2 * np.pi)) % 1.0) * interval


def refine_tempo(times: np.ndarray, interval: float, tolerance: float = 0.005) -> float:
    """Multiplier on `interval` (within ±tolerance) that maximizes how tightly
    the hits concentrate on a grid. Corrects device-clock skew; do not use it
    to 'fix' genuine tempo drift — it would hide exactly what we measure."""
    factors = np.linspace(1 - tolerance, 1 + tolerance, 401)
    concentration = np.array(
        [np.abs(np.exp(2j * np.pi * times / (interval * f)).mean()) for f in factors]
    )
    best = int(np.argmax(concentration))
    if 0 < best < len(factors) - 1:  # parabolic refinement
        y0, y1, y2 = concentration[best - 1 : best + 2]
        denom = y0 - 2 * y1 + y2
        if abs(denom) > 1e-12:
            shift = 0.5 * (y0 - y2) / denom
            return float(factors[best] + shift * (factors[1] - factors[0]))
    return float(factors[best])


def anchor_from_count_in(
    click_times: np.ndarray, bpm: float, tempo_correction: float = 1.0
) -> tuple[float, str | None]:
    """Grid offset from audible count-in clicks; also sanity-checks their spacing."""
    beat = 60.0 / bpm * tempo_correction
    offset = circular_phase(click_times, beat)
    warning = None
    if len(click_times) >= 2:
        gaps = np.diff(click_times)
        rel_err = np.abs(gaps - beat) / beat
        if float(np.max(rel_err)) > 0.06:
            implied = 60.0 / float(np.median(gaps))
            warning = (
                f"count-in clicks are spaced like {implied:.1f} BPM, not {bpm:g} BPM — "
                "check the --bpm value and that the first "
                f"{len(click_times)} detected hits really are the count-in"
            )
    return offset, warning


def build_grid(
    onset_times: np.ndarray,
    bpm: float,
    subdivision: int,
    *,
    count_in: int = 0,
    fit_tempo: bool = False,
    tempo_tolerance: float = 0.005,
) -> tuple[Grid, np.ndarray]:
    """Returns the grid plus the performance onsets (count-in clicks removed)."""
    if bpm <= 0:
        raise ValueError("bpm must be positive")
    if subdivision < 1:
        raise ValueError("subdivision must be >= 1")
    if count_in < 0:
        raise ValueError("count-in must be >= 0")
    if count_in and len(onset_times) <= count_in:
        raise ValueError(
            f"--count-in {count_in} given but only {len(onset_times)} hits were detected"
        )

    clicks = onset_times[:count_in] if count_in else np.empty(0)
    performance = onset_times[count_in:] if count_in else onset_times
    if count_in:
        # drop anything still ringing right after the last click
        performance = performance[performance > clicks[-1] + 0.25 * 60.0 / bpm]
    if len(performance) == 0:
        raise ValueError("no hits left after removing the count-in")

    correction = refine_tempo(performance, 60.0 / bpm / subdivision, tempo_tolerance) if fit_tempo else 1.0

    warning = None
    if count_in:
        offset, warning = anchor_from_count_in(clicks, bpm, correction)
        anchored = True
    else:
        offset = circular_phase(performance, 60.0 / bpm * correction / subdivision)
        anchored = False

    grid = Grid(
        bpm=bpm,
        subdivision=subdivision,
        offset=offset,
        anchored=anchored,
        tempo_correction=correction,
        count_in_warning=warning,
    )
    return grid, performance


def align(onset_times: np.ndarray, grid: Grid) -> Alignment:
    interval = grid.interval
    rel = (onset_times - grid.offset) / interval
    nearest = np.round(rel)
    dev = (rel - nearest) * interval  # seconds, signed
    ok = np.abs(dev) <= MAX_DEVIATION_FRACTION * interval
    return Alignment(
        deviations_ms=dev[ok] * 1000.0,
        times=onset_times[ok],
        positions=(nearest[ok].astype(np.int64) % grid.subdivision),
        unaligned_times=onset_times[~ok],
        grid=grid,
    )
