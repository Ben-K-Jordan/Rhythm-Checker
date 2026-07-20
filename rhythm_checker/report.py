"""Reports: the same facts as text for the terminal or as a self-contained
HTML page with charts (charts require matplotlib, and degrade gracefully).

Wording rule for this module: describe, never judge. "mean -6.3 ms" is a
fact; "sloppy" is an opinion the software is not entitled to.
"""

from __future__ import annotations

import base64
import html
import io
from datetime import datetime

import numpy as np

from .analysis import SessionAnalysis, Stats

POSITION_NAMES = {
    2: ["beat", "&"],
    3: ["beat", "trip-2", "trip-3"],
    4: ["beat", "e", "&", "a"],
    6: ["beat", "2", "3", "4", "5", "6"],
}


def _fmt_ms(x: float) -> str:
    return f"{x:+.1f} ms"


def _duration(seconds: float) -> str:
    m, s = divmod(int(round(seconds)), 60)
    return f"{m}:{s:02d}"


def _grid_name(subdivision: int) -> str:
    return {1: "1/4 notes", 2: "1/8 notes", 3: "1/8 triplets", 4: "1/16 notes",
            6: "1/16 triplets", 8: "1/32 notes"}.get(subdivision, f"1/{4 * subdivision} grid")


def _position_label(pos: int, subdivision: int) -> str:
    names = POSITION_NAMES.get(subdivision)
    return names[pos] if names and pos < len(names) else f"+{pos}/{subdivision}"


def _stats_line(s: Stats) -> str:
    return (f"mean {_fmt_ms(s.mean_ms)}   median {_fmt_ms(s.median_ms)}   "
            f"spread (SD) {s.sd_ms:.1f} ms")


def text_report(a: SessionAnalysis) -> str:
    lines: list[str] = []
    add = lines.append
    add("RHYTHM CHECKER — session report")
    add(f"file: {a.file}")
    add(f"bpm {a.bpm:g} · grid {_grid_name(a.subdivision)} · length {_duration(a.duration)}")
    n_aligned = a.overall.n
    n_unaligned = len(a.alignment.unaligned_times)
    n_skipped = a.grid.n_skipped_after_count_in
    parts = [f"hits: {a.n_detected} detected", f"{n_aligned} on the grid",
             f"{n_unaligned} unattributable"]
    if a.count_in:
        parts.append(f"first {a.count_in} used as count-in anchor")
    if n_skipped:
        parts.append(f"{n_skipped} in the count-in tail ignored")
    add(", ".join(parts))
    if a.grid.tempo_correction != 1.0:
        eff = 60.0 / a.grid.beat_interval
        add(f"tempo fitted: effective {eff:.2f} BPM "
            f"({(eff / a.bpm - 1) * 100:+.2f}% vs nominal)")
    if a.grid.count_in_warning:
        add(f"WARNING: {a.grid.count_in_warning}")
    if a.fit_warning:
        add(f"WARNING: {a.fit_warning}")
    if a.precision_warning:
        add(f"WARNING: {a.precision_warning}")
    add("")

    add(f"TIMING vs the grid   (negative = early/ahead, positive = late/behind)")
    add(f"  {_stats_line(a.overall)}")
    add(f"  {a.overall.pct_early:.0f}% early · {a.overall.pct_late:.0f}% late · "
        f"{a.overall.pct_in_pocket:.0f}% within ±{a.pocket_ms:g} ms")
    if not a.grid.anchored:
        add("  note: no count-in anchor, so the grid was fitted to your own hits.")
        add("  A constant early/late tendency is invisible in this mode — spread,")
        add("  drift and section differences below are still real. To measure")
        add("  absolute push/drag, record the metronome for a few beats before")
        add("  playing and pass --count-in.")
    add("")

    if a.drift is not None:
        d = a.drift
        direction = "toward late" if d.slope_ms_per_min > 0 else "toward early"
        add(f"DRIFT across the session: {d.slope_ms_per_min:+.1f} ms/min {direction} "
            f"(correlation r = {d.correlation:.2f})")
        add(f"  first half:  {_stats_line(d.first_half)}")
        add(f"  second half: {_stats_line(d.second_half)}")
        add("")

    if a.dense_passages:
        add(f"HIGH-DENSITY PASSAGES (busy playing — often fills): "
            f"{len(a.dense_passages)} found, {a.dense_stats.n} measurable hits")
        if a.dense_stats.n:
            add(f"  in dense passages: {_stats_line(a.dense_stats)}")
        else:
            add("  in dense passages: no hit near a grid line — timing not "
                "measurable at this subdivision")
        if a.sparse_stats.n:
            add(f"  everywhere else:   {_stats_line(a.sparse_stats)}")
        for p in a.dense_passages:
            timing = (
                f"mean {_fmt_ms(p.mean_ms)} over {p.n_aligned} on-grid hits"
                if p.mean_ms is not None
                else "no hit near a grid line — timing not measurable at this subdivision"
            )
            add(f"    {_duration(p.start)}–{_duration(p.end)}: {p.n_hits} hits, {timing}")
        add("")

    if a.position_stats:
        add("BY POSITION IN THE BEAT (count-in anchored)")
        for pos in sorted(a.position_stats):
            s = a.position_stats[pos]
            add(f"  {_position_label(pos, a.subdivision):>8}: {_stats_line(s)}  ({s.n} hits)")
        add("")

    add("These numbers describe your timing against the metronome grid.")
    add("Whether the music should sit exactly on that grid is your call, not the software's.")
    return "\n".join(lines)


# --------------------------------------------------------------------------
# HTML report


def _charts(a: SessionAnalysis) -> list[tuple[str, str]]:
    """Returns (title, base64 PNG) pairs; empty if matplotlib is unavailable."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return []

    charts: list[tuple[str, str]] = []
    t = a.alignment.times
    dev = a.alignment.deviations_ms

    def render(fig) -> str:
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=110, bbox_inches="tight")
        plt.close(fig)
        return base64.b64encode(buf.getvalue()).decode("ascii")

    fig, ax = plt.subplots(figsize=(9.5, 3.4))
    for p in a.dense_passages:
        ax.axvspan(p.start, p.end, color="#f2c94c", alpha=0.25, lw=0)
    ax.axhline(0, color="#333", lw=1)
    ax.axhspan(-a.pocket_ms, a.pocket_ms, color="#27ae60", alpha=0.10, lw=0)
    ax.scatter(t, dev, s=9, color="#2d6cdf", alpha=0.65, edgecolors="none")
    if len(t) >= 12:
        order = np.argsort(t)
        ts, ds = t[order], dev[order]
        win = 8.0
        roll = np.array([np.mean(ds[(ts >= x - win / 2) & (ts <= x + win / 2)]) for x in ts])
        ax.plot(ts, roll, color="#c0392b", lw=1.8, label="8 s rolling mean")
        ax.legend(loc="upper right", frameon=False, fontsize=8)
    ax.set_xlabel("time (s)")
    ax.set_ylabel("deviation (ms)\n← early · late →")
    ax.set_title("Every hit vs the grid (yellow = high-density passages)")
    charts.append(("timeline", render(fig)))

    fig, ax = plt.subplots(figsize=(5.0, 3.2))
    ax.hist(dev, bins=max(11, min(41, len(dev) // 6)), color="#2d6cdf", alpha=0.8)
    ax.axvline(0, color="#333", lw=1)
    ax.axvline(a.overall.mean_ms, color="#c0392b", lw=1.5, ls="--",
               label=f"mean {a.overall.mean_ms:+.1f} ms")
    ax.set_xlabel("deviation (ms)   ← early · late →")
    ax.set_ylabel("hits")
    ax.set_title("Where your hits land")
    ax.legend(frameon=False, fontsize=8)
    charts.append(("histogram", render(fig)))

    if a.position_stats:
        fig, ax = plt.subplots(figsize=(5.0, 3.2))
        groups = [
            a.alignment.deviations_ms[a.alignment.positions == pos]
            for pos in sorted(a.position_stats)
        ]
        labels = [_position_label(p, a.subdivision) for p in sorted(a.position_stats)]
        ax.axhline(0, color="#333", lw=1)
        ax.boxplot(groups, showfliers=False)  # tick_labels= needs mpl>=3.9
        ax.set_xticks(range(1, len(labels) + 1), labels)
        ax.set_ylabel("deviation (ms)")
        ax.set_title("By position in the beat")
        charts.append(("positions", render(fig)))

    return charts


def html_report(a: SessionAnalysis) -> str:
    try:
        charts = _charts(a)
        chart_note = "<p><em>Install matplotlib (<code>pip install matplotlib</code>) for charts.</em></p>"
    except Exception as exc:  # a chart failure must not take the report down with it
        charts = []
        chart_note = f"<p><em>Charts unavailable ({html.escape(type(exc).__name__)}: {html.escape(str(exc))}).</em></p>"
    imgs = "\n".join(
        f'<figure><img alt="{name}" src="data:image/png;base64,{b64}"></figure>'
        for name, b64 in charts
    )
    if not charts:
        imgs = chart_note
    pre = html.escape(text_report(a))
    generated = datetime.now().strftime("%Y-%m-%d %H:%M")
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rhythm Checker — {html.escape(a.file)}</title>
<style>
  body {{ font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 2rem auto;
         max-width: 62rem; padding: 0 1rem; color: #1a1a1a; background: #fafafa; }}
  h1 {{ font-size: 1.4rem; }}
  pre {{ background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 1rem;
        overflow-x: auto; font-size: 0.85rem; line-height: 1.45; }}
  figure {{ margin: 1.2rem 0; }}
  img {{ max-width: 100%; background: #fff; border: 1px solid #ddd; border-radius: 8px; }}
  footer {{ color: #777; font-size: 0.8rem; margin-top: 2rem; }}
</style>
</head>
<body>
<h1>Rhythm Checker — {html.escape(a.file)}</h1>
{imgs}
<pre>{pre}</pre>
<footer>generated {generated} · rhythm-checker</footer>
</body>
</html>
"""
