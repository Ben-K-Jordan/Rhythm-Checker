"""WAV decoding round-trips and session history persistence."""

import wave

import numpy as np
import pytest

from rhythm_checker.audio import AudioError, load_recording
from rhythm_checker.store import SessionRecord, load_records, save_record, trend_summary

from synth import SR, render, write_wav


def test_wav_16bit_roundtrip(tmp_path):
    y = render([0.5, 1.0, 1.5])
    path = tmp_path / "a.wav"
    write_wav(path, y)
    rec = load_recording(path)
    assert rec.sample_rate == SR
    assert abs(rec.duration - len(y) / SR) < 0.01


def test_wav_stereo_and_widths(tmp_path):
    t = np.arange(SR) / SR
    mono = (0.5 * np.sin(2 * np.pi * 220 * t)).astype(np.float64)
    stereo = np.stack([mono, -0.5 * mono], axis=1)

    for width, encode in [
        (1, lambda x: ((x * 127) + 128).astype(np.uint8).tobytes()),
        (2, lambda x: (x * 32767).astype("<i2").tobytes()),
        (4, lambda x: (x * (2**31 - 1)).astype("<i4").tobytes()),
    ]:
        path = tmp_path / f"w{width}.wav"
        with wave.open(str(path), "wb") as wf:
            wf.setnchannels(2)
            wf.setsampwidth(width)
            wf.setframerate(SR)
            wf.writeframes(encode(stereo.reshape(-1)))
        rec = load_recording(path)
        assert len(rec.samples) == SR, f"width {width}"


def test_wav_24bit(tmp_path):
    t = np.arange(SR // 2) / SR
    mono = 0.4 * np.sin(2 * np.pi * 220 * t)
    as_int = (mono * (2**23 - 1)).astype(np.int32)
    b = np.zeros((len(as_int), 3), dtype=np.uint8)
    b[:, 0] = as_int & 0xFF
    b[:, 1] = (as_int >> 8) & 0xFF
    b[:, 2] = (as_int >> 16) & 0xFF
    path = tmp_path / "w24.wav"
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(3)
        wf.setframerate(SR)
        wf.writeframes(b.tobytes())
    rec = load_recording(path)
    assert len(rec.samples) == len(mono)
    # normalized signal should still look like a sine (peak near 1)
    assert np.max(np.abs(rec.samples)) == pytest.approx(1.0, abs=1e-3)


def test_missing_file_raises():
    with pytest.raises(AudioError, match="not found"):
        load_recording("/definitely/not/here.wav")


def test_empty_wav_raises(tmp_path):
    path = tmp_path / "empty.wav"
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
    with pytest.raises(AudioError, match="no audio"):
        load_recording(path)


def _record(**over):
    base = dict(
        date="2026-07-20T10:00:00+00:00", name="warmup", file="a.wav", bpm=120.0,
        subdivision=4, duration_s=60.0, n_hits=100, anchored=False, mean_ms=-3.0,
        sd_ms=9.5, pct_in_pocket=60.0, drift_ms_per_min=1.2,
        dense_mean_ms=-8.0, sparse_mean_ms=-2.0,
    )
    base.update(over)
    return SessionRecord(**base)


def test_store_roundtrip_and_corrupt_lines(tmp_path):
    save_record(_record(), tmp_path)
    save_record(_record(name="doubles", sd_ms=7.1), tmp_path)
    (tmp_path / "sessions.jsonl").open("a").write("{corrupt json\n")
    records = load_records(tmp_path)
    assert [r.name for r in records] == ["warmup", "doubles"]
    summary = trend_summary(records)
    assert "warmup" in summary and "doubles" in summary


def test_trend_summary_empty():
    assert "No sessions" in trend_summary([])
