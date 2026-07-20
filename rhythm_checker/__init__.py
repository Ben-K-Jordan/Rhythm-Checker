"""Rhythm Checker: honest timing data for drum practice.

The recording is measured, hit by hit, against the metronome grid. The
software reports what happened; deciding what it means for the music is
deliberately left to the human.
"""

from __future__ import annotations

__version__ = "0.1.0"

from .analysis import SessionAnalysis, analyze_session
from .audio import AudioError, Recording, load_recording
from .grid import Alignment, Grid, align, build_grid
from .onsets import OnsetList, detect_onsets
from .report import html_report, text_report


def analyze_file(
    path: str,
    bpm: float,
    *,
    subdivision: int = 4,
    count_in: int = 0,
    fit_tempo: bool = False,
    pocket_ms: float = 10.0,
    sensitivity: float = 1.0,
) -> SessionAnalysis:
    """One-call API: load a recording, detect hits, analyze against the grid."""
    from pathlib import Path

    recording = load_recording(path)
    onsets = detect_onsets(recording.samples, recording.sample_rate, sensitivity=sensitivity)
    return analyze_session(
        onsets,
        file=Path(path).name,
        duration=recording.duration,
        bpm=bpm,
        subdivision=subdivision,
        count_in=count_in,
        fit_tempo=fit_tempo,
        pocket_ms=pocket_ms,
    )
