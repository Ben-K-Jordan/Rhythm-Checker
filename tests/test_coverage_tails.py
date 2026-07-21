"""Close the measured coverage holes: ffmpeg happy path (via a bundled static
binary), chart fallbacks, store env-var branch, trend edges."""
import os, subprocess, sys
import numpy as np
import pytest
from rhythm_checker import analyze_file
from rhythm_checker.audio import load_recording
from rhythm_checker.report import html_report
from rhythm_checker.store import default_store_dir
from synth import SR, grid_times, render, write_wav


def _ffmpeg():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


@pytest.mark.skipif(_ffmpeg() is None, reason="no ffmpeg binary available")
def test_ffmpeg_decode_path_end_to_end(tmp_path, monkeypatch):
    # real m4a: encode with ffmpeg, decode through load_recording's ffmpeg path
    exe = _ffmpeg()
    link = tmp_path / "bin"
    link.mkdir()
    (link / "ffmpeg").symlink_to(exe)
    monkeypatch.setenv("PATH", f"{link}:{os.environ['PATH']}")
    times = grid_times(120, 1, 12)
    wav = tmp_path / "t.wav"
    write_wav(wav, render(times))
    m4a = tmp_path / "t.m4a"
    subprocess.run([exe, "-v", "error", "-i", str(wav), "-c:a", "aac", str(m4a)], check=True)
    rec = load_recording(m4a)
    assert rec.sample_rate == 44100
    a = analyze_file(str(m4a), 120, subdivision=1)
    assert a.overall.n >= 10  # hits survive the lossy round trip


def test_html_report_without_matplotlib(tmp_path, monkeypatch):
    rng = np.random.default_rng(1)
    times = np.sort(grid_times(120, 2, 60) + rng.normal(0, 0.005, 60))
    wav = tmp_path / "s.wav"
    write_wav(wav, render(times))
    a = analyze_file(str(wav), 120, subdivision=2)
    monkeypatch.setitem(sys.modules, "matplotlib", None)
    page = html_report(a)
    assert "Install matplotlib" in page and "data:image/png" not in page


def test_anchored_report_renders_positions_boxplot(tmp_path):
    beat = 0.5
    clicks = 0.5 + beat * np.arange(4)
    play = clicks[-1] + beat + (beat / 2) * np.arange(60)
    rng = np.random.default_rng(2)
    times = np.sort(np.concatenate([clicks, play + rng.normal(0, 0.004, 60)]))
    wav = tmp_path / "a.wav"
    write_wav(wav, render(times))
    a = analyze_file(str(wav), 120, subdivision=2, count_in=4)
    assert a.position_stats
    assert html_report(a).count("data:image/png") == 3  # timeline+hist+boxplot


def test_store_dir_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv("RHYTHM_CHECKER_STORE", str(tmp_path / "x"))
    assert default_store_dir() == tmp_path / "x"
