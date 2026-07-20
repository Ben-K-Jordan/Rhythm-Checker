"""Generate a synthetic 'practice session' WAV so you can try the tool
before wiring up your phone:

    python examples/make_demo.py demo.wav
    rhythm-checker analyze demo.wav --bpm 110 --subdivision 4 --count-in 4 \
        --html demo-report.html --no-save

The synthetic drummer has flaws on purpose: starts ~8 ms ahead of the click,
drags progressively until it ends up ~10 ms behind (so the session *mean* is
near zero — only the drift stat exposes it), and rushes the sixteenth-note
fill in the middle. The report should tell you exactly that.
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent.parent / "tests"))
from synth import render, write_wav  # noqa: E402

BPM = 110
BEAT = 60.0 / BPM


def main() -> None:
    out = sys.argv[1] if len(sys.argv) > 1 else "demo.wav"
    rng = np.random.default_rng(2026)

    clicks = 0.5 + BEAT * np.arange(4)  # audible count-in
    start = clicks[-1] + BEAT

    times, accents = [], []
    t = start
    for bar in range(24):
        if bar == 11:  # one bar of sixteenths, rushed
            for i in range(16):
                times.append(t + i * BEAT / 4 - 0.013)
                accents.append(0.9 if i % 4 == 0 else 0.55)
        else:  # straight eighths
            for i in range(8):
                times.append(t + i * BEAT / 2)
                accents.append(1.0 if i % 2 == 0 else 0.7)
        t += 4 * BEAT

    times = np.array(times)
    jitter = rng.normal(0, 0.005, len(times))          # human wobble, 5 ms SD
    push = -0.008                                       # plays 8 ms ahead
    fatigue = np.linspace(0, 0.018, len(times))         # drags 18 ms by the end
    times = np.sort(times + jitter + push + fatigue)

    all_times = np.concatenate([clicks, times])
    all_accents = np.concatenate([np.full(4, 1.2), np.array(accents)])
    write_wav(out, render(all_times, accents=all_accents, seed=7))
    print(f"wrote {out}: {len(times)} hits over {times[-1]:.0f} s at {BPM} BPM")
    print("ground truth: starts ~8 ms ahead, drifts ~19 ms/min late (ending ~10 ms "
          "behind, so the session mean is ~+1 ms), bar 12's fill rushed ~13 ms")


if __name__ == "__main__":
    main()
