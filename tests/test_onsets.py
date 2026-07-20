"""Onset detection accuracy against synthesized ground truth."""

import numpy as np

from rhythm_checker.onsets import detect_onsets

from synth import SR, render


def test_detects_all_hits_with_precise_times():
    rng = np.random.default_rng(7)
    times = np.sort(np.cumsum(0.12 + rng.uniform(0, 0.3, size=30)))
    y = render(times)
    onsets = detect_onsets(y, SR)
    assert len(onsets) == len(times), f"expected {len(times)} hits, got {len(onsets)}"
    errors_ms = np.abs(onsets.times - times) * 1000.0
    assert float(np.max(errors_ms)) < 5.0, f"worst timing error {errors_ms.max():.2f} ms"


def test_relative_timing_is_subframe_accurate():
    # absolute detection bias is fine (it cancels in grid alignment);
    # hit-to-hit consistency is what timing analysis depends on
    times = 0.5 + np.arange(40) * 0.25
    y = render(times)
    onsets = detect_onsets(y, SR)
    assert len(onsets) == len(times)
    bias = onsets.times - times
    assert float(np.std(bias)) * 1000.0 < 1.5


def test_quiet_hits_found_with_higher_sensitivity():
    times = 0.5 + np.arange(16) * 0.3
    accents = np.where(np.arange(16) % 4 == 0, 1.0, 0.18)
    y = render(times, accents=accents)
    found_hot = detect_onsets(y, SR, sensitivity=1.8)
    assert len(found_hot) >= 14


def test_silence_yields_no_onsets():
    rng = np.random.default_rng(0)
    y = (0.002 * rng.standard_normal(SR * 3)).astype(np.float32)
    onsets = detect_onsets(y, SR)
    assert len(onsets) == 0


def test_short_audio_does_not_crash():
    assert len(detect_onsets(np.zeros(100, dtype=np.float32), SR)) == 0
