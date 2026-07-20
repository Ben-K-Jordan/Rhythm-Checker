"""Onset (hit) detection.

Spectral-flux detection tuned for percussive material: a chunked STFT keeps
memory flat on long sessions, an adaptive median threshold rides over bleed
and room noise, and each detected hit is refined against the waveform's
amplitude envelope so timing is not limited to STFT hop resolution.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

_CHUNK_FRAMES = 4096


@dataclass
class OnsetList:
    times: np.ndarray      # seconds, sorted
    strengths: np.ndarray  # relative flux peak height per onset

    def __len__(self) -> int:
        return len(self.times)


def detect_onsets(
    samples: np.ndarray,
    sample_rate: int,
    *,
    sensitivity: float = 1.0,
    min_separation: float = 0.03,
) -> OnsetList:
    """Detect percussive onsets. ``sensitivity`` > 1 finds quieter hits."""
    win = 1024 if sample_rate >= 32000 else 512
    hop = win // 4
    flux = _spectral_flux(samples, win, hop)
    if len(flux) < 8:
        return OnsetList(np.empty(0), np.empty(0))

    scale = float(np.percentile(flux, 98))
    if scale <= 0:
        return OnsetList(np.empty(0), np.empty(0))
    flux = flux / scale

    hop_t = hop / sample_rate
    med = _rolling_median(flux, max(3, int(round(0.7 / hop_t))))
    # additive term finds hits above the local floor; multiplicative term keeps
    # a hitless recording (noise floor only, median ~ peak) from firing at all
    threshold = med * (1 + 0.4 / sensitivity) + 0.12 / sensitivity

    peak_frames = _pick_peaks(flux, threshold, min_frames_apart=max(1, int(round(min_separation / hop_t))))
    if len(peak_frames) == 0:
        return OnsetList(np.empty(0), np.empty(0))

    times = np.array(
        [_refine_onset_time(samples, sample_rate, f * hop_t, win / sample_rate) for f in peak_frames]
    )
    strengths = flux[peak_frames]

    order = np.argsort(times)
    times, strengths = times[order], strengths[order]
    keep = _dedupe(times, strengths, min_separation)
    return OnsetList(times[keep], strengths[keep])


def _spectral_flux(samples: np.ndarray, win: int, hop: int) -> np.ndarray:
    if len(samples) < win + hop:
        return np.empty(0)
    n_frames = 1 + (len(samples) - win) // hop
    window = np.hanning(win).astype(np.float32)
    flux = np.empty(n_frames - 1, dtype=np.float64)
    prev_mag: np.ndarray | None = None
    for start in range(0, n_frames, _CHUNK_FRAMES):
        stop = min(start + _CHUNK_FRAMES, n_frames)
        idx = np.arange(win)[None, :] + hop * np.arange(start, stop)[:, None]
        mags = np.log1p(50.0 * np.abs(np.fft.rfft(samples[idx] * window, axis=1)))
        if prev_mag is not None:
            mags = np.vstack([prev_mag, mags])
        diff = np.diff(mags, axis=0)
        np.maximum(diff, 0.0, out=diff)
        block = diff.sum(axis=1)
        lo = start - 1 if prev_mag is not None else 0
        flux[lo : lo + len(block)] = block
        prev_mag = mags[-1:]
    # light smoothing to merge double peaks from one transient
    kernel = np.array([0.25, 0.5, 0.25])
    return np.convolve(flux, kernel, mode="same")


def _rolling_median(x: np.ndarray, half_width: int) -> np.ndarray:
    padded = np.pad(x, half_width, mode="edge")
    shape = (len(x), 2 * half_width + 1)
    strides = (padded.strides[0], padded.strides[0])
    windows = np.lib.stride_tricks.as_strided(padded, shape=shape, strides=strides)
    return np.median(windows, axis=1)


def _pick_peaks(flux: np.ndarray, threshold: np.ndarray, min_frames_apart: int) -> np.ndarray:
    above = flux > threshold
    local_max = np.ones_like(above)
    for shift in (1, 2, 3):
        local_max[shift:] &= flux[shift:] >= flux[:-shift]
        local_max[:-shift] &= flux[:-shift] >= flux[shift:]
    candidates = np.flatnonzero(above & local_max)
    picked: list[int] = []
    for frame in candidates:
        if picked and frame - picked[-1] < min_frames_apart:
            if flux[frame] > flux[picked[-1]]:
                picked[-1] = frame
        else:
            picked.append(frame)
    return np.array(picked, dtype=int)


def _refine_onset_time(
    samples: np.ndarray, sample_rate: int, coarse_time: float, win_duration: float
) -> float:
    """Locate the attack precisely: steepest rise of the amplitude envelope
    within the STFT frame that flagged the onset. ``coarse_time`` is the
    frame's *start*, so the attack lies up to ``win_duration`` after it."""
    pre = int(0.005 * sample_rate)
    post = int((win_duration + 0.005) * sample_rate)
    center = int(coarse_time * sample_rate)
    lo, hi = max(0, center - pre), min(len(samples), center + post)
    if hi - lo < 32:
        return coarse_time
    segment = np.abs(samples[lo:hi])
    smooth = max(1, int(0.0005 * sample_rate))  # ~0.5 ms
    env = np.convolve(segment, np.ones(smooth) / smooth, mode="same")
    step = max(1, int(0.001 * sample_rate))  # slope over ~1 ms
    slope = env[step:] - env[:-step]
    if len(slope) == 0 or float(np.max(slope)) <= 0:
        return coarse_time
    return (lo + int(np.argmax(slope)) + step / 2) / sample_rate


def _dedupe(times: np.ndarray, strengths: np.ndarray, min_separation: float) -> np.ndarray:
    """After waveform refinement two frame-peaks can collapse onto one attack;
    keep the stronger of any pair closer than min_separation."""
    keep = np.ones(len(times), dtype=bool)
    last = 0
    for i in range(1, len(times)):
        if times[i] - times[last] < min_separation:
            if strengths[i] > strengths[last]:
                keep[last] = False
                last = i
            else:
                keep[i] = False
        else:
            last = i
    return keep
