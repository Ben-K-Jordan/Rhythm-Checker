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


def test_sensitivity_actually_discriminates():
    # near-floor ghost notes: default sensitivity keeps only the accents,
    # raised sensitivity recovers every hit — both directions must hold
    times = 0.5 + np.arange(16) * 0.3
    accents = np.where(np.arange(16) % 4 == 0, 1.0, 0.05)
    y = render(times, accents=accents, noise_floor=0.02)
    n_default = len(detect_onsets(y, SR, sensitivity=1.0))
    n_hot = len(detect_onsets(y, SR, sensitivity=1.8))
    assert n_default <= 8, f"quiet hits unexpectedly detected at default ({n_default})"
    assert n_hot == 16, f"sensitivity 1.8 should recover all 16, got {n_hot}"


def test_accuracy_at_44100_full_rate_branch():
    # phone recordings are 44.1k+, which uses the win=1024 code path
    sr = 44100
    rng = np.random.default_rng(12)
    times = np.sort(np.cumsum(0.15 + rng.uniform(0, 0.25, size=25)))
    y = render(times, sr=sr)
    onsets = detect_onsets(y, sr)
    assert len(onsets) == len(times)
    errors_ms = (onsets.times - times) * 1000.0
    assert float(np.std(errors_ms)) < 1.0
    assert float(np.max(np.abs(errors_ms))) < 4.0


def test_close_pairs_survive_low_sample_rates():
    # regression: fixed +/-3-frame peak neighborhood collapsed 35-65 ms pairs
    # at low rates; the window/neighborhood now scale with the sample rate
    sr = 11025
    starts = 0.5 + np.arange(8) * 0.5
    times = np.sort(np.concatenate([starts, starts + 0.045]))
    y = render(times, sr=sr)
    onsets = detect_onsets(y, sr)
    assert len(onsets) == 16, f"expected all 16 hits at {sr} Hz, got {len(onsets)}"


def test_sparse_hits_over_digital_silence_are_detected():
    # regression: gated/trimmed recordings have exactly-zero flux between hits;
    # a plain 98th-percentile normalization collapsed to 0 and dropped every hit
    times = 0.5 + np.arange(15) * 8.0  # one hit per 8 s -> ~0.3% active frames
    y = render(times, noise_floor=0.0, tail=1.0)
    onsets = detect_onsets(y, SR)
    assert len(onsets) == 15
    errors_ms = np.abs(onsets.times - times) * 1000.0
    assert float(np.max(errors_ms)) < 5.0


def test_rolling_median_chunking_matches_naive():
    from rhythm_checker.onsets import _rolling_median

    rng = np.random.default_rng(1)
    x = rng.standard_normal(10_000)
    half = 60
    padded = np.pad(x, half, mode="edge")
    naive = np.array([np.median(padded[i : i + 2 * half + 1]) for i in range(len(x))])
    assert np.array_equal(_rolling_median(x, half), naive)


def test_silence_yields_no_onsets():
    rng = np.random.default_rng(0)
    y = (0.002 * rng.standard_normal(SR * 3)).astype(np.float32)
    onsets = detect_onsets(y, SR)
    assert len(onsets) == 0


def test_short_audio_does_not_crash():
    assert len(detect_onsets(np.zeros(100, dtype=np.float32), SR)) == 0
