"""Tuner accuracy against synthesized drum tones with known fundamentals.

Real drumheads ring inharmonic overtones (mode ratios ~1.59x, 2.14x, 2.30x)
that can be nearly as loud as — or louder than — the fundamental. The tests
synthesize that structure so a naive loudest-peak detector would fail them.
"""

import subprocess
import sys

import numpy as np
import pytest

from rhythm_checker.onsets import detect_onsets
from rhythm_checker.tuner import (
    analyze_tuning,
    cents_between,
    estimate_pitch,
    hz_to_note,
    text_report,
)

from synth import SR, write_wav

MODE_RATIOS = [1.0, 1.59, 2.14, 2.30]
MODE_AMPS = [1.0, 0.85, 0.45, 0.25]


def drum_tap(freq, sr=SR, dur=0.8, seed=0, overtone_boost=1.0):
    """A decaying inharmonic drum tone: attack thump + ringing modes."""
    n = int(dur * sr)
    t = np.arange(n) / sr
    tone = np.zeros(n)
    for k, (ratio, amp) in enumerate(zip(MODE_RATIOS, MODE_AMPS)):
        a = amp * (overtone_boost if k > 0 else 1.0)
        tone += a * np.exp(-t / (0.30 / ratio)) * np.sin(2 * np.pi * freq * ratio * t)
    rng = np.random.default_rng(seed)
    attack = np.exp(-t / 0.004) * rng.standard_normal(n) * 0.8
    out = tone + attack
    fade = min(n, int(0.05 * sr))  # no end-of-buffer click
    out[-fade:] *= np.linspace(1.0, 0.0, fade)
    return out


def render_taps(freqs, gap=1.0, sr=SR, seed=1, **tap_kw):
    times = 0.5 + gap * np.arange(len(freqs))
    total = int((times[-1] + 1.2) * sr)
    rng = np.random.default_rng(seed)
    y = 0.002 * rng.standard_normal(total)
    for i, (t0, f) in enumerate(zip(times, freqs)):
        w = drum_tap(f, sr, seed=100 + i, **tap_kw)
        start = int(t0 * sr)
        end = min(start + len(w), total)
        y[start:end] += w[: end - start]
    return (y / np.max(np.abs(y)) * 0.9).astype(np.float32), times


def _pitch_of(freq, **kw):
    y, times = render_taps([freq], **kw)
    return estimate_pitch(y, SR, float(times[0]))


@pytest.mark.parametrize("freq", [55.0, 82.4, 110.0, 146.8, 196.0, 329.6])
def test_fundamental_found_across_the_kit_range(freq):
    got = _pitch_of(freq)
    assert got is not None
    assert abs(got - freq) < 0.7, f"expected {freq} Hz, got {got:.2f}"


def test_fundamental_not_fooled_by_louder_overtones():
    # boost overtones until the loudest spectral peak provably ISN'T the
    # fundamental — then require the estimator to find the fundamental anyway
    y, times = render_taps([120.0], overtone_boost=3.0)
    seg = y[int((times[0] + 0.025) * SR): int((times[0] + 0.375) * SR)]
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    freqs = np.fft.rfftfreq(len(seg), 1.0 / SR)
    loudest = freqs[np.argmax(np.where((freqs >= 40) & (freqs <= 1000), spec, 0))]
    assert abs(loudest - 120.0) > 30, (
        f"test premise broken: loudest peak {loudest:.1f} Hz is still the fundamental"
    )
    got = estimate_pitch(y, SR, float(times[0]))
    assert got is not None
    assert abs(got - 120.0) < 1.0, f"locked onto an overtone: {got:.2f} Hz"


def test_mains_hum_is_never_reported_as_the_drum():
    # a 60 Hz hum bed (bad grounding) under a 141 Hz tap: hum is tonal and
    # sustained, defeating naive gates — the pre-onset spectrum unmasks it
    y, times = render_taps([141.0] * 3)
    t = np.arange(len(y)) / SR
    y = y + 0.02 * np.sin(2 * np.pi * 60.0 * t).astype(y.dtype)
    for t0 in times:
        got = estimate_pitch(y, SR, float(t0))
        assert got is not None
        assert abs(got - 141.0) < 1.0, f"reported {got:.1f} Hz (the hum?) instead of 141"


def test_hum_only_trigger_yields_none_not_60hz():
    rng = np.random.default_rng(3)
    t = np.arange(2 * SR) / SR
    y = (0.02 * np.sin(2 * np.pi * 60.0 * t) + 0.002 * rng.standard_normal(len(t))).astype(np.float32)
    assert estimate_pitch(y, SR, 0.8) is None


def test_boundary_tap_joins_the_nearer_drum():
    # drums 120 cents apart; one lug of the UPPER drum is 30c flat — it must
    # be flagged on the upper drum, not blamed on the (perfect) lower one
    upper = 141.0 * 2 ** (120 / 1200)
    flat_lug = upper * 2 ** (-30 / 1200)
    freqs = [141.0] * 4 + [upper] * 3 + [flat_lug]
    y, _ = render_taps(freqs)
    onsets = detect_onsets(y, SR, min_separation=0.12)
    a = analyze_tuning(y, SR, onsets, file="two.wav")
    assert len(a.groups) == 2
    low, high = a.groups
    assert len(low.taps) == 4 and len(high.taps) == 4
    assert all(abs(t.cents_vs_group) < 10 for t in low.taps), "lower drum wrongly blamed"
    worst = max(high.taps, key=lambda t: abs(t.cents_vs_group))
    assert worst.cents_vs_group == pytest.approx(-22.5, abs=8)  # -30c vs median shifted by itself


def test_detuned_lug_flagged_in_lug_pass():
    # 6 lugs at 141 Hz, one 30 cents sharp (141 * 2**(30/1200) ≈ 143.46)
    freqs = [141.0] * 6
    freqs[3] = 141.0 * 2 ** (30 / 1200)
    y, _ = render_taps(freqs)
    onsets = detect_onsets(y, SR, min_separation=0.12)
    a = analyze_tuning(y, SR, onsets, file="lugs.wav", target_hz=141.0)
    assert len(a.groups) == 1
    g = a.groups[0]
    assert len(g.taps) == 6
    assert g.median_freq == pytest.approx(141.0, abs=0.7)
    cents = [t.cents_vs_group for t in g.taps]
    sharp = max(cents)
    assert sharp == pytest.approx(30.0, abs=8.0)
    assert sum(1 for c in cents if c > 15) == 1  # exactly the one bad lug
    assert "adjust this lug" in text_report(a)


def test_two_drums_form_two_groups():
    y, _ = render_taps([110.0, 110.0, 110.0, 180.0, 180.0, 180.0])
    onsets = detect_onsets(y, SR, min_separation=0.12)
    a = analyze_tuning(y, SR, onsets, file="two.wav")
    assert len(a.groups) == 2
    assert a.groups[0].median_freq == pytest.approx(110.0, abs=1.0)
    assert a.groups[1].median_freq == pytest.approx(180.0, abs=1.5)


def test_damped_tap_reports_none_not_garbage():
    y, times = render_taps([120.0])
    cut = int((times[0] + 0.05) * SR)  # kill the ring 50 ms after the attack
    y[cut:] = 0.0
    assert estimate_pitch(y, SR, float(times[0])) is None


def test_noise_window_reports_none_not_garbage():
    # a stray trigger (bumped mic, buzz) hands the estimator plain noise:
    # the only honest pitch is no pitch
    rng = np.random.default_rng(2)
    y = (0.01 * rng.standard_normal(SR)).astype(np.float32)
    assert estimate_pitch(y, SR, 0.1) is None


def test_note_and_cents_helpers():
    assert hz_to_note(440.0) == "A4"
    assert hz_to_note(110.0) == "A2"
    assert cents_between(440.0, 440.0) == pytest.approx(0.0)
    assert cents_between(466.16, 440.0) == pytest.approx(100.0, abs=0.5)


def test_tune_cli_end_to_end(tmp_path):
    import json

    freqs = [141.0] * 4
    freqs[2] = 141.0 * 2 ** (40 / 1200)
    y, _ = render_taps(freqs)
    wav = tmp_path / "lugs.wav"
    write_wav(wav, y)
    out = subprocess.run(
        [sys.executable, "-m", "rhythm_checker", "tune", str(wav),
         "--target", "141", "--json", str(tmp_path / "t.json")],
        capture_output=True, text=True,
    )
    assert out.returncode == 0, out.stderr
    assert "tuning report" in out.stdout
    assert "adjust this lug" in out.stdout
    data = json.loads((tmp_path / "t.json").read_text())
    assert data["target_hz"] == 141.0
    assert len(data["taps"]) == 4
    g = data["groups"][0]
    assert g["n_taps"] == 4
    assert abs(g["median_hz"] - 141.0) < 1.5
    assert abs(g["cents_vs_target"]) < 20


def test_tune_cli_rejects_bad_targets(tmp_path):
    y, _ = render_taps([141.0] * 3)
    wav = tmp_path / "t.wav"
    write_wav(wav, y)
    for bad in ("0", "-100"):
        out = subprocess.run(
            [sys.executable, "-m", "rhythm_checker", "tune", str(wav), "--target", bad],
            capture_output=True, text=True,
        )
        assert out.returncode != 0, f"--target {bad} accepted"
        assert "positive frequency" in out.stderr
        assert "Traceback" not in out.stderr


def test_unpitched_taps_are_disclosed(tmp_path):
    y, times = render_taps([141.0] * 3, gap=1.0)
    cut = int((times[-1] + 0.05) * SR)  # damp the final tap almost immediately
    y = y.copy()
    y[cut:] = 0.0
    onsets = detect_onsets(y, SR, min_separation=0.12)
    a = analyze_tuning(y, SR, onsets, file="damp.wav")
    assert sum(1 for t in a.taps if t.freq is None) == 1
    assert "rang too briefly" in text_report(a)


def test_tune_cli_silence_fails_clearly(tmp_path):
    rng = np.random.default_rng(0)
    wav = tmp_path / "quiet.wav"
    write_wav(wav, (0.002 * rng.standard_normal(SR * 2)).astype(np.float32))
    out = subprocess.run(
        [sys.executable, "-m", "rhythm_checker", "tune", str(wav)],
        capture_output=True, text=True,
    )
    assert out.returncode == 1
    assert "no taps detected" in out.stderr
