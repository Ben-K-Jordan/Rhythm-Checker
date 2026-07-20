"""End-to-end honesty checks: synthesize a 'drummer' with programmed flaws,
run the full pipeline, and require the report to tell the truth about them."""

import json
import subprocess
import sys

import numpy as np
import pytest

from rhythm_checker import analyze_file
from rhythm_checker.analysis import analyze_session
from rhythm_checker.onsets import detect_onsets
from rhythm_checker.report import html_report, text_report

from synth import SR, grid_times, render, write_wav

BPM = 120
BEAT = 60.0 / BPM


def _analyze(times, tmp_path, name="s.wav", **kwargs):
    path = tmp_path / name
    write_wav(path, render(np.asarray(times)))
    return analyze_file(str(path), BPM, **kwargs)


def test_steady_playing_reports_low_spread(tmp_path):
    rng = np.random.default_rng(3)
    jitter = rng.normal(0, 0.004, 120)  # ~4 ms SD human
    times = grid_times(BPM, 2, 120) + jitter
    a = _analyze(np.sort(times), tmp_path, subdivision=2)
    assert a.overall.n >= 110
    # pin against the SD of the actual drawn jitter, not the nominal 4.0:
    # detection may only add a sub-ms of measurement error on top of it
    true_sd = float(np.std(jitter, ddof=1)) * 1000.0
    assert a.overall.sd_ms == pytest.approx(true_sd, abs=0.8)
    assert abs(a.overall.mean_ms) < 2.0


def test_rushed_player_with_count_in_anchor(tmp_path):
    clicks = 0.5 + BEAT * np.arange(4)
    play = clicks[-1] + BEAT + (BEAT / 2) * np.arange(80) - 0.012  # 12 ms early
    rng = np.random.default_rng(5)
    play = play + rng.normal(0, 0.003, len(play))
    a = _analyze(np.concatenate([clicks, np.sort(play)]), tmp_path,
                 subdivision=2, count_in=4)
    assert a.grid.anchored
    assert a.grid.count_in_warning is None
    assert a.overall.mean_ms == pytest.approx(-12.0, abs=2.5)
    assert a.overall.median_ms == pytest.approx(-12.0, abs=2.5)
    # the early/late labels must point the right way, not just the mean
    assert a.overall.pct_early >= 95.0
    assert a.overall.pct_late <= 5.0
    # dev ~ N(-12, 3): only ~25% of hits can sit within the ±10 ms pocket
    assert 5.0 <= a.overall.pct_in_pocket <= 50.0
    report = text_report(a)
    assert "count-in anchor" in report


def test_dragging_player_positive_direction(tmp_path):
    # mirror case: constant lateness must come out positive (catches sign flips
    # anywhere in the pipeline, which the symmetric tests cannot)
    clicks = 0.5 + BEAT * np.arange(4)
    play = clicks[-1] + BEAT + (BEAT / 2) * np.arange(60) + 0.015  # 15 ms late
    rng = np.random.default_rng(6)
    play = play + rng.normal(0, 0.003, len(play))
    a = _analyze(np.concatenate([clicks, np.sort(play)]), tmp_path,
                 subdivision=2, count_in=4)
    assert a.overall.mean_ms == pytest.approx(15.0, abs=2.5)
    assert a.overall.pct_late >= 95.0


def test_fatigue_drift_is_detected(tmp_path):
    n = 150
    base = grid_times(BPM, 2, n)
    drift = np.linspace(0, 0.030, n)  # slides 30 ms late over the session
    a = _analyze(base + drift, tmp_path, subdivision=2)
    assert a.drift is not None
    session_min = (base[-1] + 0.030 - base[0]) / 60.0
    expected_slope = 30.0 / session_min
    assert a.drift.slope_ms_per_min == pytest.approx(expected_slope, rel=0.15)
    assert a.drift.correlation > 0.8
    assert a.drift.second_half.mean_ms > a.drift.first_half.mean_ms


def test_rushed_fill_shows_in_dense_stats(tmp_path):
    # quarter-note time, one bar of rushed sixteenths in the middle
    groove1 = grid_times(BPM, 1, 16)                      # 0.5 .. 8.0
    fill_start = groove1[-1] + BEAT
    fill = fill_start + (BEAT / 4) * np.arange(16) - 0.014  # 14 ms early
    groove2 = fill_start + 4 * BEAT + BEAT * np.arange(16)
    rng = np.random.default_rng(11)
    times = np.sort(np.concatenate([groove1, fill, groove2])
                    + rng.normal(0, 0.002, 48))
    a = _analyze(times, tmp_path)
    assert len(a.dense_passages) >= 1
    assert a.dense_stats.n >= 12
    assert a.dense_stats.mean_ms < a.sparse_stats.mean_ms - 5.0


def test_fill_finer_than_grid_still_registers_as_dense(tmp_path):
    # eighth-note groove analyzed on an eighth grid, but the fill is sixteenths:
    # half its hits are off-grid, yet the passage must still show up as dense
    groove1 = grid_times(BPM, 2, 32)                     # 0.5 .. 8.25
    fill_start = groove1[-1] + BEAT / 2
    fill = fill_start + (BEAT / 4) * np.arange(16)
    groove2 = fill_start + 4 * BEAT + (BEAT / 2) * np.arange(32)
    times = np.concatenate([groove1, fill, groove2])
    a = _analyze(times, tmp_path, subdivision=2)
    assert len(a.dense_passages) >= 1
    assert any(p.start < fill_start < p.end for p in a.dense_passages)
    assert len(a.alignment.unaligned_times) >= 6  # the off-grid sixteenths, reported


def test_all_offgrid_dense_burst_never_fabricates_stats(tmp_path):
    # a burst that never touches the quarter-note grid (phases 0.42-0.56 of the
    # beat, beyond the 0.4-interval attribution limit), isolated from the groove
    # by rests: the report must say "not measurable" — a fabricated
    # "mean +0.0 ms" over zero hits would be a lie
    clicks = 0.5 + BEAT * np.arange(4)
    start = clicks[-1] + BEAT
    g1 = start + BEAT * np.arange(10)
    burst_base = g1[-1] + 3 * BEAT
    burst = np.array([burst_base + (b + 0.42 + ph) * BEAT
                      for b in range(4) for ph in (0.0, 0.07, 0.14)])
    g2 = burst_base + 7 * BEAT + BEAT * np.arange(10)
    times = np.sort(np.concatenate([clicks, g1, burst, g2]))
    a = _analyze(times, tmp_path, subdivision=1, count_in=4)
    dense = [p for p in a.dense_passages if p.n_aligned == 0]
    assert dense, "the off-grid burst should form a zero-aligned dense passage"
    assert all(p.mean_ms is None for p in dense)
    assert a.dense_stats.n == 0
    assert len(a.alignment.unaligned_times) >= 12
    report = text_report(a)
    assert "in dense passages: no hit near a grid line" in report
    assert "in dense passages: mean" not in report


def test_position_breakdown_only_when_anchored(tmp_path):
    clicks = 0.5 + BEAT * np.arange(4)
    start = clicks[-1] + BEAT
    beats = start + BEAT * np.arange(24)
    ands = beats + BEAT / 2 + 0.010  # every "&" 10 ms late
    times = np.sort(np.concatenate([clicks, beats, ands]))
    a = _analyze(times, tmp_path, subdivision=2, count_in=4)
    assert 0 in a.position_stats and 1 in a.position_stats
    assert a.position_stats[1].mean_ms > a.position_stats[0].mean_ms + 5.0

    a2 = _analyze(np.sort(np.concatenate([beats, ands])), tmp_path,
                  name="s2.wav", subdivision=2)
    assert a2.position_stats == {}


def test_triplet_grid_subdivision_3(tmp_path):
    # shuffle: beat plus the last eighth-note triplet, every triplet 8 ms late
    clicks = 0.5 + BEAT * np.arange(4)
    start = clicks[-1] + BEAT
    beats = start + BEAT * np.arange(30)
    trips = beats + 2 * BEAT / 3 + 0.008
    rng = np.random.default_rng(14)
    times = np.sort(np.concatenate([clicks, beats, trips])
                    + np.concatenate([np.zeros(4), rng.normal(0, 0.002, 60)]))
    a = _analyze(times, tmp_path, subdivision=3, count_in=4)
    assert a.fit_warning is None
    assert a.position_stats[0].mean_ms == pytest.approx(0.0, abs=2.0)
    assert a.position_stats[2].mean_ms == pytest.approx(8.0, abs=2.0)
    assert "1/8 triplets" in text_report(a)


def test_swing_on_straight_grid_warns_instead_of_lying(tmp_path):
    # swung eighths (offbeat at 2/3 of the beat) measured on a sixteenth grid:
    # the deviations split into two tight clusters and the tool must say so
    beats = grid_times(BPM, 1, 32)
    swung = beats + 2 * BEAT / 3
    rng = np.random.default_rng(15)
    times = np.sort(np.concatenate([beats, swung]) + rng.normal(0, 0.002, 64))
    a = _analyze(times, tmp_path, subdivision=4)
    assert a.fit_warning is not None
    assert "clusters" in a.fit_warning
    assert "--subdivision 3" in a.fit_warning
    assert "WARNING" in text_report(a)


def test_low_sample_rate_gets_precision_warning(tmp_path):
    times = grid_times(BPM, 1, 40)
    path = tmp_path / "low.wav"
    write_wav(path, render(times, sr=8000), sr=8000)
    a = analyze_file(str(path), BPM, subdivision=1)
    assert a.precision_warning is not None
    assert "8000" in a.precision_warning
    assert "WARNING" in text_report(a)


def test_fit_tempo_report_sign_matches_effective_bpm(tmp_path):
    # device clock runs slow -> intervals stretched -> effective BPM BELOW
    # nominal, and the report's percentage must carry the matching sign
    interval = (60.0 / BPM / 2) * 1.003
    times = 0.5 + interval * np.arange(100)
    a = _analyze(times, tmp_path, subdivision=2, fit_tempo=True)
    eff = 60.0 / a.grid.beat_interval
    assert eff == pytest.approx(BPM / 1.003, abs=0.1)  # ~119.64
    report = text_report(a)
    assert "119.6" in report
    assert "-0.3" in report  # NOT "+0.3": the sign inversion regression


def test_fit_tempo_recovers_skewed_clock(tmp_path):
    interval = (60.0 / BPM / 2) * 1.003
    times = 0.5 + interval * np.arange(100)
    a = _analyze(times, tmp_path, subdivision=2, fit_tempo=True)
    assert a.grid.tempo_correction == pytest.approx(1.003, abs=5e-4)
    assert a.overall.sd_ms < 3.0
    # without the fit the same recording shows inflated spread
    b = _analyze(times, tmp_path, name="b.wav", subdivision=2)
    assert b.overall.sd_ms > a.overall.sd_ms


def test_wrong_bpm_fails_with_helpful_error(tmp_path):
    times = grid_times(97, 1, 40)  # played at 97 BPM
    path = tmp_path / "wrong.wav"
    write_wav(path, render(times))
    with pytest.raises(ValueError, match="BPM"):
        analyze_file(str(path), 141)  # far off, not a harmonic


def test_too_few_hits_fails_clearly(tmp_path):
    path = tmp_path / "few.wav"
    write_wav(path, render([0.5, 1.0]))
    with pytest.raises(ValueError, match="not enough"):
        analyze_file(str(path), BPM)


def test_reports_render_and_contain_the_disclaimer(tmp_path):
    rng = np.random.default_rng(8)
    times = np.sort(grid_times(BPM, 2, 60) + rng.normal(0, 0.006, 60))
    a = _analyze(times, tmp_path, subdivision=2)
    txt = text_report(a)
    assert "your call" in txt  # the judgment stays human
    page = html_report(a)
    assert page.startswith("<!doctype html>")
    assert "data:image/png;base64," in page  # matplotlib present in dev env


def test_analysis_to_dict_pins_real_values(tmp_path):
    clicks = 0.5 + BEAT * np.arange(4)
    play = clicks[-1] + BEAT + (BEAT / 2) * np.arange(60) - 0.010
    rng = np.random.default_rng(9)
    play = np.sort(play + rng.normal(0, 0.003, len(play)))
    a = _analyze(np.concatenate([clicks, play]), tmp_path, subdivision=2, count_in=4)
    d = json.loads(json.dumps(a.to_dict()))  # full round trip
    assert d["overall"]["mean_ms"] == pytest.approx(-10.0, abs=2.5)
    assert d["hits"]["count_in"] == 4
    assert d["hits"]["detected"] == d["hits"]["count_in"] + \
        d["hits"]["skipped_after_count_in"] + d["hits"]["aligned"] + d["hits"]["unaligned"]
    assert len(d["per_hit"]["times_s"]) == d["hits"]["aligned"]
    assert len(d["per_hit"]["deviations_ms"]) == d["hits"]["aligned"]
    assert d["grid"]["anchored"] is True
    assert set(d["positions"].keys()) == {"0", "1"}
    assert d["bpm"] == BPM and d["subdivision"] == 2


def test_onsets_subcommand_reports_known_hits(tmp_path):
    times = grid_times(BPM, 1, 12)
    wav = tmp_path / "hits.wav"
    write_wav(wav, render(times))
    out = subprocess.run(
        [sys.executable, "-m", "rhythm_checker", "onsets", str(wav)],
        capture_output=True, text=True,
    )
    assert out.returncode == 0, out.stderr
    payload = json.loads(out.stdout)
    assert payload["n_onsets"] == 12
    reported = np.array(payload["times_s"])
    assert np.max(np.abs(reported - times)) < 0.005


def test_cli_rejects_absurd_bpm(tmp_path):
    wav = tmp_path / "x.wav"
    write_wav(wav, render(grid_times(BPM, 1, 10)))
    out = subprocess.run(
        [sys.executable, "-m", "rhythm_checker", "analyze", str(wav),
         "--bpm", "500", "--no-save"],
        capture_output=True, text=True,
    )
    assert out.returncode == 1
    assert "20-400" in out.stderr
    assert "Traceback" not in out.stderr


def test_cli_unwritable_output_is_a_clean_error(tmp_path):
    wav = tmp_path / "x.wav"
    write_wav(wav, render(np.sort(grid_times(BPM, 2, 40))))
    out = subprocess.run(
        [sys.executable, "-m", "rhythm_checker", "analyze", str(wav),
         "--bpm", "120", "--subdivision", "2", "--no-save",
         "--html", "/nonexistent-dir/report.html"],
        capture_output=True, text=True,
    )
    assert out.returncode == 1
    assert "error:" in out.stderr and "/nonexistent-dir" in out.stderr
    assert "Traceback" not in out.stderr


def test_cli_full_run(tmp_path):
    rng = np.random.default_rng(4)
    times = np.sort(grid_times(BPM, 2, 80) + rng.normal(0, 0.005, 80))
    wav = tmp_path / "practice.wav"
    write_wav(wav, render(times))
    store = tmp_path / "store"
    html = tmp_path / "report.html"
    out = subprocess.run(
        [sys.executable, "-m", "rhythm_checker", "analyze", str(wav),
         "--bpm", "120", "--subdivision", "2", "--store", str(store),
         "--html", str(html), "--name", "unit-test"],
        capture_output=True, text=True,
    )
    assert out.returncode == 0, out.stderr
    assert "RHYTHM CHECKER" in out.stdout
    assert html.exists()
    assert (store / "sessions.jsonl").exists()

    hist = subprocess.run(
        [sys.executable, "-m", "rhythm_checker", "history", "--store", str(store)],
        capture_output=True, text=True,
    )
    assert hist.returncode == 0, hist.stderr
    assert "unit-test" in hist.stdout


def test_cli_errors_cleanly_on_missing_file(tmp_path):
    out = subprocess.run(
        [sys.executable, "-m", "rhythm_checker", "analyze",
         str(tmp_path / "nope.wav"), "--bpm", "120"],
        capture_output=True, text=True,
    )
    assert out.returncode == 1
    assert "not found" in out.stderr
