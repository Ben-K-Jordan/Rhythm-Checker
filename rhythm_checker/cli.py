"""Command-line interface."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .analysis import analyze_session
from .audio import AudioError, load_recording
from .onsets import detect_onsets
from .report import html_report, text_report
from .store import SessionRecord, load_records, save_record, trend_summary


def _positive_hz(text: str) -> float:
    value = float(text)
    if not value > 0:
        raise argparse.ArgumentTypeError(
            f"target must be a positive frequency in Hz, got {text}"
        )
    return value


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rhythm-checker",
        description=(
            "Measure every drum hit in a practice recording against the metronome "
            "grid. The numbers tell the truth about your time; what to do with "
            "that truth stays with you."
        ),
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    an = sub.add_parser("analyze", help="analyze one practice recording")
    an.add_argument("file", help="recording (WAV natively; m4a/mp3 via ffmpeg)")
    an.add_argument("--bpm", type=float, required=True,
                    help="the metronome tempo you practiced to")
    an.add_argument("--subdivision", type=int, default=4, metavar="N",
                    help="grid lines per beat: 1=quarters 2=eighths 3=triplets "
                         "4=sixteenths (default: 4)")
    an.add_argument("--count-in", type=int, default=0, metavar="N",
                    help="treat the first N hits as audible metronome/count-in clicks; "
                         "anchors the grid so absolute push/drag is measurable")
    an.add_argument("--fit-tempo", action="store_true",
                    help="correct up to ±0.5%% tempo skew from the recording device's "
                         "clock (also absorbs genuine steady drift — leave off unless "
                         "you trust your device less than your hands)")
    an.add_argument("--pocket-ms", type=float, default=10.0, metavar="MS",
                    help="tolerance counted as 'in the pocket' (default: 10)")
    an.add_argument("--sensitivity", type=float, default=1.0,
                    help="onset detection sensitivity; raise toward 1.5-2 for quiet "
                         "recordings or brushes (default: 1.0)")
    an.add_argument("--min-gap-ms", type=float, default=30.0, metavar="MS",
                    help="hits closer together than this merge into one — flams "
                         "and drags count as a single hit (default: 30)")
    an.add_argument("--name", default="", help="label for this session in history")
    an.add_argument("--html", metavar="PATH", help="also write a chart report to PATH")
    an.add_argument("--json", dest="json_path", metavar="PATH",
                    help="also dump full per-hit data as JSON to PATH")
    an.add_argument("--no-save", action="store_true",
                    help="don't add this session to the practice history")
    an.add_argument("--store", metavar="DIR", help="history directory "
                    "(default: ~/.rhythm-checker, or $RHYTHM_CHECKER_STORE)")

    hist = sub.add_parser("history", help="list analyzed sessions")
    hist.add_argument("--store", metavar="DIR")
    hist.add_argument("--limit", type=int, default=0, help="show only the last N")

    onsets_p = sub.add_parser("onsets", help="debug: dump detected hit times")
    onsets_p.add_argument("file")
    onsets_p.add_argument("--sensitivity", type=float, default=1.0)

    tune = sub.add_parser("tune", help="analyze a recording of drum taps for tuning")
    tune.add_argument("file", help="recording of individual taps (lug pass or center hits)")
    tune.add_argument("--target", type=_positive_hz, default=None, metavar="HZ",
                      help="your saved target fundamental for this drum")
    tune.add_argument("--sensitivity", type=float, default=1.0)
    tune.add_argument("--json", dest="json_path", metavar="PATH",
                      help="also dump per-tap data as JSON to PATH")

    return parser


def _cmd_analyze(args: argparse.Namespace) -> int:
    recording = load_recording(args.file)
    onsets = detect_onsets(
        recording.samples,
        recording.sample_rate,
        sensitivity=args.sensitivity,
        min_separation=args.min_gap_ms / 1000.0,
    )
    analysis = analyze_session(
        onsets,
        file=Path(args.file).name,
        duration=recording.duration,
        bpm=args.bpm,
        subdivision=args.subdivision,
        count_in=args.count_in,
        fit_tempo=args.fit_tempo,
        pocket_ms=args.pocket_ms,
        sample_rate=recording.sample_rate,
    )

    print(text_report(analysis))

    if args.html:
        Path(args.html).write_text(html_report(analysis), encoding="utf-8")
        print(f"\nchart report written to {args.html}")
    if args.json_path:
        Path(args.json_path).write_text(
            json.dumps(analysis.to_dict(), indent=2), encoding="utf-8"
        )
        print(f"full data written to {args.json_path}")
    if not args.no_save:
        name = args.name or Path(args.file).stem
        store_dir = Path(args.store) if args.store else None
        path = save_record(SessionRecord.from_analysis(analysis, name), store_dir)
        print(f"session added to history ({path})")
    return 0


def _cmd_history(args: argparse.Namespace) -> int:
    store_dir = Path(args.store) if args.store else None
    records = load_records(store_dir)
    if args.limit > 0:
        records = records[-args.limit:]
    print(trend_summary(records))
    return 0


def _cmd_onsets(args: argparse.Namespace) -> int:
    recording = load_recording(args.file)
    onsets = detect_onsets(
        recording.samples, recording.sample_rate, sensitivity=args.sensitivity
    )
    print(json.dumps(
        {
            "file": args.file,
            "duration_s": round(recording.duration, 2),
            "n_onsets": len(onsets),
            "times_s": [round(float(t), 4) for t in onsets.times],
        },
        indent=2,
    ))
    return 0


def _cmd_tune(args: argparse.Namespace) -> int:
    from .tuner import analyze_tuning, text_report as tuning_report

    recording = load_recording(args.file)
    # taps ring into each other less than playing does; a longer merge window
    # keeps one tap from double-counting via its own decay wobble
    onsets = detect_onsets(
        recording.samples, recording.sample_rate,
        sensitivity=args.sensitivity, min_separation=0.12,
    )
    analysis = analyze_tuning(
        recording.samples, recording.sample_rate, onsets,
        file=Path(args.file).name, target_hz=args.target,
    )
    print(tuning_report(analysis))
    if args.json_path:
        Path(args.json_path).write_text(
            json.dumps(analysis.to_dict(), indent=2), encoding="utf-8"
        )
        print(f"\nfull data written to {args.json_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    handlers = {"analyze": _cmd_analyze, "history": _cmd_history,
                "onsets": _cmd_onsets, "tune": _cmd_tune}
    try:
        return handlers[args.command](args)
    except (AudioError, ValueError, OSError) as exc:
        if isinstance(exc, OSError) and exc.filename:
            msg = f"{exc.strerror or exc}: {exc.filename}"
        else:
            msg = str(exc)
        print(f"error: {msg}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
