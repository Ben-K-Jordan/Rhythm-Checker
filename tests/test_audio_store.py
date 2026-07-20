"""WAV decoding round-trips and session history persistence."""

import struct
import wave

import numpy as np
import pytest

from rhythm_checker.audio import AudioError, load_recording
from rhythm_checker.store import SessionRecord, load_records, save_record, trend_summary

from synth import SR, render, write_wav


def _expected_after_finish(mono: np.ndarray) -> np.ndarray:
    """Mirror of audio._finish: DC removal then peak normalization."""
    x = mono - np.mean(mono)
    return x / np.max(np.abs(x))


def test_wav_16bit_roundtrip(tmp_path):
    y = render([0.5, 1.0, 1.5])
    path = tmp_path / "a.wav"
    write_wav(path, y)
    rec = load_recording(path)
    assert rec.sample_rate == SR
    assert abs(rec.duration - len(y) / SR) < 0.01
    # the decoded waveform must be the one we wrote, not merely the same length
    assert np.allclose(rec.samples, _expected_after_finish(y), atol=2e-4)


def test_wav_stereo_and_widths_decode_correct_values(tmp_path):
    t = np.arange(SR) / SR
    mono = (0.5 * np.sin(2 * np.pi * 220 * t)).astype(np.float64)
    stereo = np.stack([mono, -0.5 * mono], axis=1)
    downmix = stereo.mean(axis=1)  # what a correct decoder must produce

    # tolerances allow quantization error x4, because peak-normalizing the
    # 0.25-peak downmix amplifies absolute errors fourfold
    for width, tol, encode in [
        (1, 4e-2, lambda x: np.round(x * 127 + 128).astype(np.uint8).tobytes()),
        (2, 1e-3, lambda x: np.round(x * 32767).astype("<i2").tobytes()),
        (4, 1e-5, lambda x: np.round(x * (2**31 - 1)).astype("<i4").tobytes()),
    ]:
        path = tmp_path / f"w{width}.wav"
        with wave.open(str(path), "wb") as wf:
            wf.setnchannels(2)
            wf.setsampwidth(width)
            wf.setframerate(SR)
            wf.writeframes(encode(stereo.reshape(-1)))
        rec = load_recording(path)
        assert len(rec.samples) == SR, f"width {width}"
        assert np.allclose(
            rec.samples, _expected_after_finish(downmix), atol=tol
        ), f"width {width} decoded wrong values"


def _write_24bit(path, mono, channels=1):
    as_int = (np.asarray(mono) * (2**23 - 1)).astype(np.int32)
    b = np.zeros((len(as_int), 3), dtype=np.uint8)
    b[:, 0] = as_int & 0xFF
    b[:, 1] = (as_int >> 8) & 0xFF
    b[:, 2] = (as_int >> 16) & 0xFF
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(3)
        wf.setframerate(SR)
        wf.writeframes(b.tobytes())


def test_wav_24bit_decodes_exact_values(tmp_path):
    t = np.arange(SR // 2) / SR
    mono = 0.4 * np.sin(2 * np.pi * 220 * t)  # includes negative values
    path = tmp_path / "w24.wav"
    _write_24bit(path, mono)
    rec = load_recording(path)
    assert len(rec.samples) == len(mono)
    assert np.allclose(rec.samples, _expected_after_finish(mono), atol=1e-5)


def test_truncated_wav_still_loads(tmp_path):
    # a recorder crash or interrupted transfer chops the file mid-sample;
    # the partial final frame is dropped, everything before it is kept
    y = render([0.5, 1.0])
    for name, width_writer in [("t16.wav", write_wav), ("t24.wav", _write_24bit)]:
        path = tmp_path / name
        width_writer(path, y)
        blob = path.read_bytes()
        path.write_bytes(blob[:-1])
        rec = load_recording(path)
        assert abs(len(rec.samples) - len(y)) <= 2, name


def test_extensible_and_float_wavs_decode_natively(tmp_path):
    """WAVE_FORMAT_EXTENSIBLE (common from DAWs/recorders) and IEEE-float WAVs
    are rejected by the stdlib wave module but must decode via the RIFF
    fallback — with the same values as their plain-PCM equivalents."""
    t = np.arange(SR // 2) / SR
    mono = (0.5 * np.sin(2 * np.pi * 220 * t)).astype(np.float64)

    def wav_blob(fmt_chunk: bytes, data: bytes) -> bytes:
        chunks = b"fmt " + struct.pack("<I", len(fmt_chunk)) + fmt_chunk
        chunks += b"data" + struct.pack("<I", len(data)) + data
        return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks

    # extensible header wrapping ordinary 16-bit PCM
    pcm = (mono * 32767).astype("<i2").tobytes()
    guid = struct.pack("<H", 1) + bytes.fromhex("000000000010800000AA00389B71")
    fmt_ext = struct.pack("<HHIIHH", 0xFFFE, 1, SR, SR * 2, 2, 16)
    fmt_ext += struct.pack("<HHI", 22, 16, 3) + guid
    ext = tmp_path / "ext.wav"
    ext.write_bytes(wav_blob(fmt_ext, pcm))
    with pytest.raises(wave.Error):
        wave.open(str(ext))  # proves the stdlib alone can't read it
    rec = load_recording(ext)
    assert np.allclose(rec.samples, _expected_after_finish(mono), atol=2e-4)

    # IEEE float32
    fmt_f32 = struct.pack("<HHIIHH", 3, 1, SR, SR * 4, 4, 32)
    f32 = tmp_path / "f32.wav"
    f32.write_bytes(wav_blob(fmt_f32, mono.astype("<f4").tobytes()))
    rec = load_recording(f32)
    assert np.allclose(rec.samples, _expected_after_finish(mono), atol=1e-6)


def test_non_wav_without_ffmpeg_fails_with_instructions(tmp_path, monkeypatch):
    import rhythm_checker.audio as audio_mod

    monkeypatch.setattr(audio_mod.shutil, "which", lambda _: None)
    path = tmp_path / "phone.m4a"
    path.write_bytes(b"\x00\x00\x00\x20ftypM4A ")
    with pytest.raises(AudioError, match="ffmpeg"):
        load_recording(path)


def test_directory_input_is_a_clean_audio_error(tmp_path):
    d = tmp_path / "session.wav"
    d.mkdir()
    with pytest.raises(AudioError, match="directory"):
        load_recording(d)


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


def test_store_roundtrip_and_corrupt_lines(tmp_path, capsys):
    import json as json_mod

    save_record(_record(), tmp_path)
    save_record(_record(name="doubles", sd_ms=7.1), tmp_path)
    with (tmp_path / "sessions.jsonl").open("a") as fh:
        fh.write("{corrupt json\n")
        # valid JSON, wrong-typed field: must be skipped, not crash `history`
        bad = _record(name="hand-edited").to_dict()
        bad["sd_ms"] = "oops"
        fh.write(json_mod.dumps(bad) + "\n")
        # numeric-as-string is coercible and must survive
        ok = _record(name="stringly", anchored=True).to_dict()
        ok["bpm"] = "90"
        fh.write(json_mod.dumps(ok) + "\n")
    records = load_records(tmp_path)
    assert [r.name for r in records] == ["warmup", "doubles", "stringly"]
    assert records[2].bpm == 90.0
    assert "skipped 2 unreadable" in capsys.readouterr().err
    summary = trend_summary(records)
    assert "warmup" in summary and "doubles" in summary


def test_trend_summary_marks_unanchored_means(tmp_path):
    rows = [_record(name="fitted", anchored=False, mean_ms=-3.0),
            _record(name="anchored", anchored=True, mean_ms=-6.5)]
    summary = trend_summary(rows)
    fitted_line = next(l for l in summary.splitlines() if "fitted" in l)
    anchored_line = next(l for l in summary.splitlines() if "anchored" in l)
    assert "(-3.0)" in fitted_line       # parenthesized: grid was fitted to the playing
    assert "-6.5" in anchored_line and "(" not in anchored_line
    assert "9.5" in fitted_line          # sd column present
    assert "+1.2" in fitted_line         # drift column present


def test_trend_summary_empty():
    assert "No sessions" in trend_summary([])
