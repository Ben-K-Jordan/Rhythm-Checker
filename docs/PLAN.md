# Rhythm Checker — Product Plan

The goal: a **warmup / pre-show double-check suite**. Before a show you want two
facts confirmed: the kit sounds right (tuning) and your hands are right
(timing). Both checks must be fast, work in a noisy backstage with no wifi, and
never flatter you.

## Architecture: two tiers, zero servers

| Tier | What | Where it runs |
|------|------|---------------|
| **Live app** (`webapp/`) | Tuner, pre-show check, Guitar-Hero-style rudiment trainer, live timing check | Any browser: iPhone Safari (installable PWA, offline) and Windows laptop |
| **Deep analyzer** (`rhythm_checker/` Python) | Full-session honesty reports, practice history, HTML charts, tuning analysis of recordings | Laptop |

### Why a PWA instead of a native iPhone app

- Installable from Safari ("Add to Home Screen"), full-screen, works **offline**
  (service worker caches everything — venue wifi is irrelevant).
- No Apple developer account, no App Store review, no yearly fee.
- Microphone + sample-accurate audio are available to browsers via
  `getUserMedia` and Web Audio.
- The one honest trade-off: iOS microphone input carries a fixed latency
  (~20–40 ms). It is *constant*, so the built-in **latency calibration** wizard
  measures it once and subtracts it from every timing score. Tuning is
  unaffected (pitch has no clock).
- If the band ever wants a real App Store presence, the same JS wraps into
  Capacitor with near-zero changes. Not needed for v1.

### The complete API-call suite

**There are no cloud API calls. None.** Every algorithm (onset detection,
pitch detection, grid scoring) runs on the device. The only "APIs" used are
free, built-in platform APIs:

| API | Purpose | Cost |
|-----|---------|------|
| `getUserMedia` | microphone access (echo cancellation/AGC disabled — critical for drums) | $0 |
| Web Audio (`AudioContext`, `AudioWorklet`) | sample-accurate metronome + live capture | $0 |
| Canvas 2D | note highway + tuner needle | $0 |
| `localStorage` | kit presets, tuning targets, timing baselines, calibration | $0 |
| Service Worker | offline caching | $0 |

Running cost of the software: **$0 per user, per month, forever.** No
accounts, no telemetry, no network access at all. The only optional cost is
static hosting for the iPhone install URL — GitHub Pages does it for free
(HTTPS included, which iOS requires for mic access). There is deliberately no
"more expensive but better" tier: for on-device DSP, a server would add
latency and failure modes, not quality.

## Modules and features

### 1. Tuner (`webapp` Tuner tab + `rhythm-checker tune` CLI)

Drum tuning = matching lug pitches and setting the fundamental. Tap the head,
the app hears the pitch.

- **Fundamental mode**: tap the center; shows the drum's fundamental in Hz +
  nearest note + cents, with a smoothed needle. Big readout.
- **Lug mode**: tap 2–3" from each lug around the head; each tap is logged
  with its cents deviation from the running median — high lugs and low lugs
  are instantly visible. Clear a drum, go around again after adjusting.
- **Targets**: save the Hz you like per drum ("14in tom = 141 Hz"). Next show,
  the tuner shows cents vs *your* target, not an abstract note.
- DSP: onset-gated capture → 350 ms tone window (attack skipped), Hann +
  zero-padded FFT, fundamental = lowest spectral peak within 18 dB of the
  strongest (drums ring inharmonic overtones *above* the fundamental — picking
  the loudest peak alone would sometimes tune you to an overtone), parabolic
  interpolation for ~±0.2 Hz. Accuracy is pinned by tests against synthesized
  drum tones with realistic overtone series.
- CLI mirror: `rhythm-checker tune lugs.wav [--target 141]` for analyzing a
  recorded lug pass with the same math + a per-tap table.

### 2. Pre-show check ("Dialed") — the reason this app exists

A guided, foolproof checklist. Configure once at a relaxed rehearsal:

1. **Kit setup**: name each drum, tune it the way you love, save its target Hz.
2. **Baseline**: run a 60 s timing check when your hands feel great; the
   mean/spread/pocket numbers become your reference.

On show day, one flow, big pass/fail screens:

- Per drum: tap the head → **IN TUNE** (within tolerance of target) or the
  cents it's off and which direction.
- Hands: 30–60 s with the metronome → spread + pocket % vs your baseline →
  **DIALED** or the honest numbers of what's off.
- Everything works offline, dark stage-friendly UI, giant type readable from
  a drum throne.

### 3. Rudiment trainer (Guitar-Hero-style)

- Note highway: rudiment pattern scrolls toward a strike line, synced to the
  sample-accurate metronome. Each note carries its sticking letter (R/L) and
  accent marking.
- Every real hit is detected from the mic, matched to the nearest expected
  note, and judged: **perfect ±20 ms / good ±40 / late-early ±60 / miss** —
  with the signed error flashed (`-12 ms` = you rushed it). Streak counter and
  accuracy meter for the arcade feel.
- End-of-run report in the house style: mean, spread, % pocket, and where the
  misses clustered (e.g. "the RR doubles average 9 ms early").
- v1 rudiment library: single stroke roll, double stroke roll, single/double
  paradiddle, paradiddle-diddle, triplet singles — plus free subdivision mode.
  (A microphone hears *when*, not *which hand*: sticking is displayed as
  guidance, timing is what's scored. Flams inside 30 ms register as one hit —
  same disclosed limit as the analyzer.)
- Latency calibration applied to every score; a calibration nag shows until
  it's been run on this device.

### 4. Live timing check

Free play against the metronome: live dot-strip of the last hits
(early/late), running mean/spread/pocket, no patterns — the quick "are my
hands on today" tool, and the engine behind the pre-show hands check.

### 5. Deep analyzer (already built, stays)

Record the whole warmup on the phone, run `rhythm-checker analyze` later for
drift/fill/position truth and the multi-week history. The web app is for *now*;
the Python tool is for *trends*.

## Performance & foolproofness budget

- All-local DSP: tuner FFT ~8 ms of work per hit; rudiment scoring O(1) per
  hit; 60 fps canvas with <100 notes live. An older iPhone is idling.
- Metronome uses the Web Audio lookahead-scheduler pattern — clicks are
  scheduled on the audio clock, immune to UI jank.
- Mic constraints explicitly disable `echoCancellation`, `noiseSuppression`,
  `autoGainControl` (they eat drum transients).
- No network, no dependencies, no build step: plain ES modules; a copy of the
  folder is the app. Failure modes (mic denied, silent input, uncalibrated)
  produce visible instructions, never a blank screen.

## Test strategy

- Python: pytest suite (already 55 tests) + tuner tests against synthesized
  inharmonic drum tones.
- Web: the DSP core is pure functions; a self-test module runs the same
  ground-truth checks (synth tone → pitch within ±0.5 Hz; synth clicks →
  onsets within ms) inside the real browser via Playwright, plus UI smoke
  tests. Anything untestable by machine (mic hardware) gets a manual
  checklist in the README.
