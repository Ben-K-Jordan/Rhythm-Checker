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


def _analysis_window(sample_rate: int) -> int:
    """Power-of-two window spanning ~23 ms at any sample rate, so time
    resolution does not degrade on low-rate recordings."""
    return int(min(4096, max(128, 2 ** round(np.log2(sample_rate * 0.023)))))


def detect_onsets(
    samples: np.ndarray,
    sample_rate: int,
    *,
    sensitivity: float = 1.0,
    min_separation: float = 0.03,
) -> OnsetList:
    """Detect percussive onsets. ``sensitivity`` > 1 finds quieter hits.

    Known limits, by design: hits closer together than ``min_separation``
    (default 30 ms) merge into one, so tight flams and drag ruffs register as
    a single onset; and a hit inside the first analysis window (~25 ms) has no
    "before" to rise from and cannot be detected — leave a moment of room tone
    before playing.
    """
    win = _analysis_window(sample_rate)
    hop = win // 4
    flux = _spectral_flux(samples, win, hop)
    if len(flux) < 8:
        return OnsetList(np.empty(0), np.empty(0))

    peak = float(np.max(flux))
    if peak <= 0:
        return OnsetList(np.empty(0), np.empty(0))
    # Normalize by the 98th percentile of *active* frames. Digitally silent
    # stretches (gated interfaces, trimmed takes) contribute exactly-zero flux;
    # a plain percentile over those collapses to ~0 and would drown every hit.
    active = flux[flux > 1e-4 * peak]
    scale = float(np.percentile(active, 98))
    if scale <= 0:
        return OnsetList(np.empty(0), np.empty(0))
    flux = flux / scale

    hop_t = hop / sample_rate
    med = _rolling_median(flux, max(3, int(round(0.7 / hop_t))))
    # additive term finds hits above the local floor; multiplicative term keeps
    # a hitless recording (noise floor only, median ~ peak) from firing at all
    threshold = med * (1 + 0.4 / sensitivity) + 0.12 / sensitivity

    peak_frames = _pick_peaks(
        flux,
        threshold,
        min_frames_apart=max(1, int(round(min_separation / hop_t))),
        neighborhood=max(1, int(round(0.017 / hop_t))),
    )
    if len(peak_frames) == 0:
        return OnsetList(np.empty(0), np.empty(0))

    win_t = win / sample_rate
    times = np.array(
        [_refine_onset_time(samples, sample_rate, f * hop_t, win_t) for f in peak_frames]
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
    """Sliding median, computed in bounded chunks so peak memory stays
    O(chunk * window) no matter how long the session is."""
    padded = np.pad(x, half_width, mode="edge")
    width = 2 * half_width + 1
    out = np.empty(len(x))
    for start in range(0, len(x), _CHUNK_FRAMES):
        stop = min(start + _CHUNK_FRAMES, len(x))
        block = padded[start : stop + width - 1]
        windows = np.lib.stride_tricks.as_strided(
            block, shape=(stop - start, width), strides=(block.strides[0], block.strides[0])
        )
        out[start:stop] = np.median(windows, axis=1)
    return out


def _pick_peaks(
    flux: np.ndarray, threshold: np.ndarray, min_frames_apart: int, neighborhood: int
) -> np.ndarray:
    """A frame is a peak if above threshold and a local max over ±neighborhood
    frames (~17 ms of context regardless of sample rate)."""
    above = flux > threshold
    local_max = np.ones_like(above)
    for shift in range(1, neighborhood + 1):
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
        return max(0.0, coarse_time)
    segment = np.abs(samples[lo:hi])
    smooth = max(3, int(0.0005 * sample_rate))  # ~0.5 ms, but never sub-sample
    env = np.convolve(segment, np.ones(smooth) / smooth, mode="same")
    step = max(2, int(0.001 * sample_rate))  # slope over ~1 ms
    slope = env[step:] - env[:-step]
    if len(slope) == 0 or float(np.max(slope)) <= 0:
        return max(0.0, coarse_time)
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
