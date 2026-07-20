"""Pure math: grid fitting and alignment, no audio involved."""

import numpy as np
import pytest

from rhythm_checker.grid import (
    align,
    anchor_from_count_in,
    build_grid,
    circular_phase,
    refine_tempo,
)


def test_circular_phase_recovers_offset():
    interval = 0.125
    times = 0.037 + interval * np.arange(50)
    assert circular_phase(times, interval) == pytest.approx(0.037, abs=1e-9)


def test_circular_phase_handles_wraparound():
    # offset near the top of the interval must not average to garbage
    interval = 0.125
    rng = np.random.default_rng(1)
    times = 0.124 + interval * np.arange(60) + rng.normal(0, 0.004, 60)
    offset = circular_phase(times, interval)
    dist = min(abs(offset - 0.124), abs(offset - 0.124 + interval), abs(offset - 0.124 - interval))
    assert dist < 0.003


def test_alignment_signs_and_magnitude():
    grid, perf = build_grid(np.array([1.0, 1.495, 2.010, 2.5]), 120, 1)
    a = align(perf, grid)
    assert len(a.deviations_ms) == 4
    # hit 2 came 5 ms early, hit 3 came 10 ms late (relative to fitted grid,
    # which itself moves slightly toward the mean)
    assert a.deviations_ms[1] < a.deviations_ms[0] < a.deviations_ms[2]


def test_anchored_grid_measures_absolute_offset():
    bpm, sub = 120, 4
    beat = 60.0 / bpm
    clicks = 0.5 + beat * np.arange(4)
    late = clicks[-1] + beat + beat / sub * np.arange(32) + 0.015  # all 15 ms late
    all_onsets = np.concatenate([clicks, late])
    grid, perf = build_grid(all_onsets, bpm, sub, count_in=4)
    assert grid.anchored
    a = align(perf, grid)
    assert np.mean(a.deviations_ms) == pytest.approx(15.0, abs=1.0)


def test_unanchored_grid_absorbs_constant_offset():
    bpm, sub = 120, 4
    times = 0.515 + (60.0 / bpm / sub) * np.arange(64)
    grid, perf = build_grid(times, bpm, sub)
    a = align(perf, grid)
    assert abs(np.mean(a.deviations_ms)) < 1.0  # constant push is invisible unanchored


def test_count_in_spacing_warning():
    clicks = np.array([0.5, 0.9, 1.3, 1.7])  # spaced like 150 BPM
    _, warning = anchor_from_count_in(clicks, 120)
    assert warning is not None and "150" in warning


def test_count_in_correct_spacing_no_warning():
    clicks = 0.5 + 0.5 * np.arange(4)
    _, warning = anchor_from_count_in(clicks, 120)
    assert warning is None


def test_far_hits_are_unaligned_not_forced():
    bpm = 120
    interval = 60.0 / bpm  # quarters
    times = 0.5 + interval * np.arange(20).astype(float)
    times = np.append(times, 0.5 + 3 * interval + 0.45 * interval)  # way off
    grid, perf = build_grid(times, bpm, 1)
    a = align(perf, grid)
    assert len(a.unaligned_times) == 1
    assert len(a.deviations_ms) == 20


def test_refine_tempo_finds_clock_skew():
    true_interval = 0.125 * 1.003  # device clock 0.3% off
    times = 0.4 + true_interval * np.arange(200)
    factor = refine_tempo(times, 0.125)
    assert factor == pytest.approx(1.003, abs=3e-4)


def test_build_grid_validates_input():
    times = np.arange(10.0)
    with pytest.raises(ValueError):
        build_grid(times, -5, 4)
    with pytest.raises(ValueError):
        build_grid(times, 120, 0)
    with pytest.raises(ValueError):
        build_grid(np.arange(3.0), 120, 4, count_in=4)
