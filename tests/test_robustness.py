"""Regression pins for defects found in the line-by-line review: every case
here produced a raw traceback or a wrong answer before its fix."""

import struct
import wave

import numpy as np
import pytest

from rhythm_checker.audio import AudioError, load_recording
from rhythm_checker.cli import main
from rhythm_checker.onsets import detect_onsets
from rhythm_checker.tuner import estimate_pitch

SR = 44100


def test_empty_wav_is_a_clean_error(tmp_path):
    # a zero-byte .wav made stdlib wave raise EOFError, which bypassed every
    # fallback and tracebacked at the CLI
    p = tmp_path / "empty.wav"
    p.write_bytes(b"")
    with pytest.raises(AudioError):
        load_recording(p)


def test_truncated_wav_header_is_a_clean_error(tmp_path):
    p = tmp_path / "trunc.wav"
    p.write_bytes(b"RIFF\x10")
    with pytest.raises(AudioError):
        load_recording(p)


def test_zero_bits_fmt_is_a_clean_error(tmp_path):
    # fmt chunk declaring bitsPerSample=0 divided by zero in _decode_pcm
    p = tmp_path / "bits0.wav"
    fmt = struct.pack("<HHIIHH", 1, 1, SR, SR, 0, 0)  # PCM, 1ch, bits=0
    data = b"\x00" * 64
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt \
        + b"data" + struct.pack("<I", len(data)) + data
    p.write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)
    with pytest.raises(AudioError):
        load_recording(p)


def test_sensitivity_zero_is_a_clean_error():
    # --sensitivity 0 divided the detection threshold by zero
    with pytest.raises(ValueError):
        detect_onsets(np.zeros(SR, dtype=np.float64), SR, sensitivity=0.0)


def test_corrupt_session_store_is_a_clean_error(tmp_path, capsys):
    # a garbage sessions.db tracebacked with sqlite3.DatabaseError — worst on
    # `analyze`, which finished the whole report before dying on the save
    (tmp_path / "sessions.db").write_bytes(b"this is not a sqlite file")
    rc = main(["history", "--store", str(tmp_path)])
    assert rc == 1
    assert "session store" in capsys.readouterr().err


def test_early_tap_does_not_report_mains_hum_as_pitch(tmp_path):
    # the pre-onset hum gate wasn't gain-matched for short pre windows, so a
    # first tap ~0.1-0.2 s into the recording reported 60 Hz as the drum
    dur, f_drum, onset = 2.0, 200.0, 0.15
    t = np.arange(int(dur * SR)) / SR
    sig = 0.06 * np.sin(2 * np.pi * 60.0 * t)  # continuous mains hum
    ring = t[t >= onset] - onset
    drum = np.exp(-ring / 0.3) * np.sin(2 * np.pi * f_drum * ring)
    sig[int(onset * SR):] += drum
    got = estimate_pitch(sig, SR, onset)
    assert got is not None
    assert abs(got - f_drum) < 2.0, f"reported {got} Hz (hum leak?)"
