"""Audio loading.

WAV files (the common case for exported phone recordings) are decoded natively
with the standard library, including WAVE_FORMAT_EXTENSIBLE and float WAVs via
a small RIFF fallback parser. Anything else (m4a, mp3, ...) is handed to
ffmpeg if it is installed; otherwise we fail with instructions rather than
guessing.
"""

from __future__ import annotations

import shutil
import struct
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
    if path.is_dir():
        raise AudioError(f"'{path}' is a directory, not a recording")
    if path.suffix.lower() in (".wav", ".wave"):
        try:
            return _load_wav(path)
        except wave.Error:
            pass
        try:
            # WAVE_FORMAT_EXTENSIBLE / float WAVs: stdlib wave (< 3.12) rejects
            # them, but the sample data is ordinary PCM/float — parse the RIFF
            # chunks ourselves before resorting to ffmpeg.
            return _load_wav_riff(path)
        except AudioError:
            return _load_via_ffmpeg(path)
    return _load_via_ffmpeg(path)


def _decode_pcm(raw: bytes, width: int, channels: int, path: Path) -> np.ndarray:
    frame_bytes = width * max(1, channels)
    usable = len(raw) - len(raw) % frame_bytes
    if usable == 0:
        raise AudioError(f"'{path.name}' contains no audio")
    raw = raw[:usable]  # a partial final frame (truncated transfer) has no usable audio

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
        data = data.reshape(-1, channels).mean(axis=1)
    return data


def _load_wav(path: Path) -> Recording:
    with wave.open(str(path), "rb") as wf:
        sr = wf.getframerate()
        channels = wf.getnchannels()
        width = wf.getsampwidth()
        raw = wf.readframes(wf.getnframes())
    return _finish(_decode_pcm(raw, width, channels, path), sr, path)


_FMT_PCM = 1
_FMT_FLOAT = 3
_FMT_EXTENSIBLE = 0xFFFE


def _load_wav_riff(path: Path) -> Recording:
    """Minimal RIFF parser for PCM/float WAVs the stdlib wave module rejects
    (WAVE_FORMAT_EXTENSIBLE headers, IEEE float data)."""
    blob = path.read_bytes()
    if len(blob) < 44 or blob[:4] != b"RIFF" or blob[8:12] != b"WAVE":
        raise AudioError(f"'{path.name}' is not a RIFF/WAVE file")

    fmt = None
    data = None
    pos = 12
    while pos + 8 <= len(blob):
        chunk_id = blob[pos : pos + 4]
        (size,) = struct.unpack_from("<I", blob, pos + 4)
        body = blob[pos + 8 : pos + 8 + size]
        if chunk_id == b"fmt ":
            fmt = body
        elif chunk_id == b"data":
            data = body
        pos += 8 + size + (size & 1)  # chunks are word-aligned
    if fmt is None or len(fmt) < 16 or data is None:
        raise AudioError(f"'{path.name}' has no decodable fmt/data chunks")

    tag, channels, sr, _, _, bits = struct.unpack_from("<HHIIHH", fmt, 0)
    if tag == _FMT_EXTENSIBLE and len(fmt) >= 26:
        (tag,) = struct.unpack_from("<H", fmt, 24)  # first bytes of SubFormat GUID
    if channels < 1 or sr < 1:
        raise AudioError(f"'{path.name}' has a corrupt fmt chunk")

    if tag == _FMT_PCM:
        samples = _decode_pcm(data, bits // 8, channels, path)
    elif tag == _FMT_FLOAT and bits in (32, 64):
        dtype = "<f4" if bits == 32 else "<f8"
        width = bits // 8 * channels
        data = data[: len(data) - len(data) % width]
        if not data:
            raise AudioError(f"'{path.name}' contains no audio")
        samples = np.frombuffer(data, dtype=dtype).astype(np.float32)
        if channels > 1:
            samples = samples.reshape(-1, channels).mean(axis=1)
    else:
        raise AudioError(f"'{path.name}' uses WAV format tag {tag}, which this tool cannot decode")
    return _finish(samples, sr, path)


def _load_via_ffmpeg(path: Path) -> Recording:
    if shutil.which("ffmpeg") is None:
        raise AudioError(
            f"'{path.name}' is not a WAV file this tool can decode natively and "
            "ffmpeg is not installed. Install ffmpeg (https://ffmpeg.org) to "
            "analyze m4a/mp3/etc., or export the recording as a standard PCM WAV."
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
