"""Drum tuning analysis: the pitch of each tap, so lugs can be matched and
fundamentals set on purpose.

A struck drumhead rings its fundamental plus *inharmonic* overtones above it
(mode ratios around 1.59x, 2.14x, ...). The loudest spectral peak is therefore
sometimes an overtone — the fundamental is found as the lowest peak that is
still within a window of the strongest one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from .onsets import OnsetList

PITCH_MIN_HZ = 40.0    # below the lowest useful kick fundamental
PITCH_MAX_HZ = 1000.0
TONE_SKIP = 0.025      # seconds of attack transient to skip after the onset
TONE_WINDOW = 0.35     # seconds of ring analyzed per tap
PEAK_FLOOR_DB = 18.0   # candidate peaks must be within this of the max peak
CLUSTER_CENTS = 100.0  # taps within this of a group belong to the same drum

_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def hz_to_note(freq: float) -> str:
    """Nearest note name + octave, e.g. 110.0 -> 'A2'."""
    midi = 69 + 12 * np.log2(freq / 440.0)
    n = int(round(midi))
    return f"{_NOTE_NAMES[n % 12]}{n // 12 - 1}"


def cents_between(freq: float, reference: float) -> float:
    return float(1200.0 * np.log2(freq / reference))


@dataclass
class TapPitch:
    time: float
    freq: float | None      # None when no stable pitch was found
    note: str | None
    cents_vs_group: float | None = None


@dataclass
class DrumGroup:
    median_freq: float
    note: str
    taps: list[TapPitch]

    @property
    def spread_cents(self) -> float:
        cents = [t.cents_vs_group for t in self.taps if t.cents_vs_group is not None]
        return float(np.std(cents)) if len(cents) > 1 else 0.0


@dataclass
class TuningAnalysis:
    file: str
    taps: list[TapPitch]
    groups: list[DrumGroup]
    target_hz: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "file": self.file,
            "target_hz": self.target_hz,
            "taps": [
                {
                    "time_s": round(t.time, 3),
                    "freq_hz": None if t.freq is None else round(t.freq, 2),
                    "note": t.note,
                    "cents_vs_group": None
                    if t.cents_vs_group is None
                    else round(t.cents_vs_group, 1),
                }
                for t in self.taps
            ],
            "groups": [
                {
                    "median_hz": round(g.median_freq, 2),
                    "note": g.note,
                    "n_taps": len(g.taps),
                    "spread_cents": round(g.spread_cents, 1),
                    "cents_vs_target": None
                    if self.target_hz is None
                    else round(cents_between(g.median_freq, self.target_hz), 1),
                }
                for g in self.groups
            ],
        }


def estimate_pitch(
    samples: np.ndarray,
    sample_rate: int,
    onset_time: float,
    max_end: float | None = None,
) -> float | None:
    """Fundamental frequency of the ring after one tap, or None if unclear."""
    start = int((onset_time + TONE_SKIP) * sample_rate)
    end = int((onset_time + TONE_SKIP + TONE_WINDOW) * sample_rate)
    if max_end is not None:
        end = min(end, int(max_end * sample_rate))
    end = min(end, len(samples))
    if end - start < int(0.1 * sample_rate):  # < 100 ms of tone: too vague
        return None
    raw = samples[start:end]

    # require actual sustained ring: a damped thud or a stray noise trigger
    # must return None, not a confidently wrong number
    block = max(1, int(0.02 * sample_rate))
    n_blocks = len(raw) // block
    rms = np.sqrt(np.mean(raw[: n_blocks * block].reshape(n_blocks, block) ** 2, axis=1))
    if float(np.max(rms)) <= 0 or int(np.sum(rms >= 0.1 * np.max(rms))) < 5:
        return None

    segment = raw * np.hanning(len(raw))

    n_fft = int(2 ** np.ceil(np.log2(len(segment)))) * 4  # zero-pad for resolution
    spectrum = np.abs(np.fft.rfft(segment, n_fft))
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)

    band = (freqs >= PITCH_MIN_HZ) & (freqs <= PITCH_MAX_HZ)
    mags = spectrum[band]
    fs = freqs[band]
    if len(mags) < 8 or float(np.max(mags)) <= 0:
        return None
    # tonal prominence: a real ring towers over its spectral floor; broadband
    # noise (a stray trigger, wire buzz) does not
    if float(np.max(mags)) < 10.0 * float(np.median(mags)):
        return None

    floor = float(np.max(mags)) * (10 ** (-PEAK_FLOOR_DB / 20))
    # local maxima above the floor, lowest frequency first
    peaks = np.flatnonzero(
        (mags[1:-1] >= mags[:-2]) & (mags[1:-1] >= mags[2:]) & (mags[1:-1] >= floor)
    ) + 1
    if len(peaks) == 0:
        return None
    p = int(peaks[0])

    # parabolic interpolation around the bin for sub-bin precision
    if 0 < p < len(mags) - 1:
        y0, y1, y2 = np.log(mags[p - 1] + 1e-12), np.log(mags[p] + 1e-12), np.log(mags[p + 1] + 1e-12)
        denom = y0 - 2 * y1 + y2
        shift = 0.5 * (y0 - y2) / denom if abs(denom) > 1e-12 else 0.0
        shift = float(np.clip(shift, -0.5, 0.5))
    else:
        shift = 0.0
    bin_width = fs[1] - fs[0]
    return float(fs[p] + shift * bin_width)


def analyze_tuning(
    samples: np.ndarray,
    sample_rate: int,
    onsets: OnsetList,
    *,
    file: str = "",
    target_hz: float | None = None,
) -> TuningAnalysis:
    if len(onsets) == 0:
        raise ValueError(
            "no taps detected — tap the head clearly, one hit at a time, and "
            "let each ring."
        )

    taps: list[TapPitch] = []
    times = onsets.times
    for i, t in enumerate(times):
        next_onset = float(times[i + 1]) if i + 1 < len(times) else None
        # stop the window just before the next tap so its attack can't intrude
        max_end = None if next_onset is None else next_onset - 0.01
        freq = estimate_pitch(samples, sample_rate, float(t), max_end)
        taps.append(
            TapPitch(
                time=float(t),
                freq=freq,
                note=None if freq is None else hz_to_note(freq),
            )
        )

    pitched = [t for t in taps if t.freq is not None]
    if not pitched:
        raise ValueError(
            "taps were detected but none rang long enough to pitch — let each "
            "tap ring out (damp nothing) and leave space between taps."
        )

    groups = _cluster(pitched)
    return TuningAnalysis(file=file, taps=taps, groups=groups, target_hz=target_hz)


def _cluster(taps: list[TapPitch]) -> list[DrumGroup]:
    """Group taps whose pitches sit within CLUSTER_CENTS of a group's running
    median — separate drums (or a drastically detuned lug) become separate
    groups."""
    groups: list[list[TapPitch]] = []
    for tap in sorted(taps, key=lambda t: t.freq):  # type: ignore[arg-type, return-value]
        placed = False
        for g in groups:
            med = float(np.median([t.freq for t in g]))
            if abs(cents_between(tap.freq, med)) <= CLUSTER_CENTS:  # type: ignore[arg-type]
                g.append(tap)
                placed = True
                break
        if not placed:
            groups.append([tap])

    out: list[DrumGroup] = []
    for g in sorted(groups, key=lambda g: float(np.median([t.freq for t in g]))):
        med = float(np.median([t.freq for t in g]))
        for t in g:
            t.cents_vs_group = cents_between(t.freq, med)  # type: ignore[arg-type]
        out.append(
            DrumGroup(median_freq=med, note=hz_to_note(med), taps=sorted(g, key=lambda t: t.time))
        )
    return out


def text_report(a: TuningAnalysis) -> str:
    lines = ["RHYTHM CHECKER — tuning report", f"file: {a.file}"]
    n_unpitched = sum(1 for t in a.taps if t.freq is None)
    lines.append(f"taps: {len(a.taps)} detected, {len(a.taps) - n_unpitched} pitched")
    if n_unpitched:
        lines.append(f"  ({n_unpitched} rang too briefly to pitch — damped or too close together)")
    for i, g in enumerate(a.groups, 1):
        head = (
            f"\nDRUM {i}: {g.median_freq:.1f} Hz (~{g.note}), "
            f"{len(g.taps)} taps, lug spread {g.spread_cents:.0f} cents"
        )
        if a.target_hz is not None:
            cents = cents_between(g.median_freq, a.target_hz)
            head += f" — {cents:+.0f} cents vs target {a.target_hz:g} Hz"
        lines.append(head)
        for t in g.taps:
            marker = ""
            if t.cents_vs_group is not None and abs(t.cents_vs_group) > 15:
                marker = "  <-- adjust this lug"
            lines.append(
                f"  {t.time:6.2f}s  {t.freq:7.1f} Hz  {t.cents_vs_group:+6.1f} cents{marker}"
            )
    lines.append("")
    lines.append("Cents are relative to each drum's median tap. The right pitch for")
    lines.append("your drum is the one you like — the numbers just keep the lugs honest.")
    return "\n".join(lines)
