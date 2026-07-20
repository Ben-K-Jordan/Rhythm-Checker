"""Synthesize drum-like audio with exactly known hit times, so every test
compares the tool's report against ground truth."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

SR = 22050


def hit_waveform(sr: int = SR, freq: float = 180.0, dur: float = 0.08,
                 noise: float = 0.6, seed: int = 0) -> np.ndarray:
    """A percussive burst: sharp attack, exponential decay, tone + noise."""
    n = int(dur * sr)
    t = np.arange(n) / sr
    env = np.exp(-t / 0.015)
    rng = np.random.default_rng(seed)
    body = np.sin(2 * np.pi * freq * t) + noise * rng.standard_normal(n)
    return (env * body).astype(np.float64)


def render(hit_times: list[float] | np.ndarray, *, sr: int = SR,
           tail: float = 0.5, noise_floor: float = 0.003,
           accents: list[float] | np.ndarray | None = None,
           seed: int = 42) -> np.ndarray:
    """Place hit bursts at the given times over a low noise floor."""
    hit_times = np.asarray(hit_times, dtype=float)
    total = int((float(hit_times.max(initial=0.0)) + tail) * sr) + 1
    rng = np.random.default_rng(seed)
    y = noise_floor * rng.standard_normal(total)
    for i, t0 in enumerate(hit_times):
        w = hit_waveform(sr, seed=i)
        amp = 1.0 if accents is None else float(accents[i])
        start = int(round(t0 * sr))
        end = min(start + len(w), total)
        y[start:end] += amp * w[: end - start]
    peak = np.max(np.abs(y))
    return (y / peak * 0.9).astype(np.float32)


def write_wav(path: str | Path, samples: np.ndarray, sr: int = SR) -> None:
    pcm = np.clip(samples * 32767.0, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())


def grid_times(bpm: float, subdivision: int, n: int, start: float = 0.5) -> np.ndarray:
    """n perfectly spaced grid hits starting at `start` seconds."""
    interval = 60.0 / bpm / subdivision
    return start + interval * np.arange(n)
