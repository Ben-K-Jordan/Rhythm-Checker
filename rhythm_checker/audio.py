"""Audio loading.

WAV files (the common case for exported phone recordings) are decoded natively
with the standard library. Anything else (m4a, mp3, ...) is handed to ffmpeg
if it is installed; otherwise we fail with instructions rather than guessing.
"""

from __future__ import annotations

import shutil
import subprocess
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np


class AudioError(Exception):
    """Raised when a recording cannot be decoded."""


@dataclass
class Recording:
    samples: np.ndarray  # float32, mono, roughly in [-1, 1]
    sample_rate: int

    @property
    def duration(self) -> float:
        return len(self.samples) / self.sample_rate


def load_recording(path: str | Path) -> Recording:
    path = Path(path)
    if not path.exists():
        raise AudioError(f"file not found: {path}")
    if path.suffix.lower() in (".wav", ".wave"):
        try:
            return _load_wav(path)
        except wave.Error:
            # Non-PCM WAV (e.g. float32 export); ffmpeg can still read it.
            return _load_via_ffmpeg(path)
    return _load_via_ffmpeg(path)


def _load_wav(path: Path) -> Recording:
    with wave.open(str(path), "rb") as wf:
        sr = wf.getframerate()
        channels = wf.getnchannels()
        width = wf.getsampwidth()
        n_frames = wf.getnframes()
        raw = wf.readframes(n_frames)

    if width == 1:  # unsigned 8-bit
        data = np.frombuffer(raw, dtype=np.uint8).astype(np.float32)
        data = (data - 128.0) / 128.0
    elif width == 2:
        data = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        as_int = (
            b[:, 0].astype(np.int32)
            | (b[:, 1].astype(np.int32) << 8)
            | (b[:, 2].astype(np.int32) << 16)
        )
        as_int = np.where(as_int >= 1 << 23, as_int - (1 << 24), as_int)
        data = as_int.astype(np.float32) / float(1 << 23)
    elif width == 4:
        data = np.frombuffer(raw, dtype="<i4").astype(np.float32) / float(1 << 31)
    else:
        raise AudioError(f"unsupported WAV sample width: {width * 8}-bit")

    if channels > 1:
        data = data[: len(data) - len(data) % channels]
        data = data.reshape(-1, channels).mean(axis=1)
    return _finish(data, sr, path)


def _load_via_ffmpeg(path: Path) -> Recording:
    if shutil.which("ffmpeg") is None:
        raise AudioError(
            f"'{path.name}' is not a PCM WAV file and ffmpeg is not installed. "
            "Install ffmpeg (https://ffmpeg.org) to analyze m4a/mp3/etc., or "
            "export the recording as WAV first."
        )
    sr = 44100
    cmd = [
        "ffmpeg", "-v", "error",
        "-i", str(path),
        "-f", "f32le", "-acodec", "pcm_f32le", "-ac", "1", "-ar", str(sr),
        "-",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, check=True)
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode(errors="replace").strip()
        raise AudioError(f"ffmpeg could not decode '{path.name}': {detail}") from exc
    data = np.frombuffer(proc.stdout, dtype=np.float32).copy()
    return _finish(data, sr, path)


def _finish(data: np.ndarray, sr: int, path: Path) -> Recording:
    if len(data) == 0:
        raise AudioError(f"'{path.name}' contains no audio")
    if sr < 8000:
        raise AudioError(f"sample rate {sr} Hz is too low for timing analysis")
    data = data - float(np.mean(data))  # remove DC offset
    peak = float(np.max(np.abs(data)))
    if peak > 0:
        data = data / peak
    return Recording(samples=data.astype(np.float32), sample_rate=sr)
