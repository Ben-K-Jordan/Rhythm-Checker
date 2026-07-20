# Rhythm Checker — iPhone UX Specification

Synthesis of a three-design panel (show-day ritual / daily practice loop /
one-thumb-in-the-dark ergonomics) scored by independent judges. The winning
structure: **the ergonomics design's physical laws, the ritual design's
two-state home and ledger, the practice design's Focus card.** Each design's
judged mistake is explicitly designed out (§9).

## 1. Design laws (non-negotiable)

1. **One primary action per screen.** Every screen has exactly one obvious
   next thing, rendered as the biggest element. Anything else is secondary and
   lives in the bottom thumb bar.
2. **The thumb-zone law.** Primary actions occupy the bottom 40% of the
   viewport, full-width, ≥72pt tall. Minimum tap target anywhere: 44×44pt.
   During live sessions the **top 60% of the screen is inert** — the enemies
   are knuckle brushes, sweat drops, and a phone vibrating on a stool.
3. **Destructive = held, never tapped.** Disarm, end-check, delete, overwrite
   baseline: 600ms press-and-hold with a radial fill that narrates itself.
   A stray tap can never destroy show-day state.
4. **State = color + shape + word, never color alone.** Backstage lighting is
   a red gel; ~8% of men are red-green colorblind. Pass: green + filled circle
   + the number. Fail: red + open triangle + the number. Attention: amber +
   outline + a fact. Red/green are never the *only* difference between states.
5. **Numbers, not opinions.** Data numerals in large tabular mono (88pt for
   the hero readout). Category words (DIALED, miss) are published thresholds,
   not judgments. No confetti, no praise copy. A flawless run reports
   "0 misses." and stops talking.
6. **Disabled states carry their reason as their label.** Never a grayed
   mystery button: "PRE-SHOW — NEEDS 2 TARGETS + BASELINE", and tapping it
   goes to the shortest fix.
7. **The app never guesses.** Show day is armed manually. No calendar/location
   inference. While armed, DISARM (held) is always visible.
8. **Degrade honestly, never block.** Missing targets/baseline/calibration
   shrink the check and are disclosed in the verdict ("2 drums skipped — no
   target"), they never disable it. Ten minutes before stage, a partial truth
   beats a locked door.
9. **Offline is the app.** Every screen fully functional in airplane mode in a
   concrete basement. Zero runtime network calls.

## 2. Information architecture

Hub-and-spoke, never more than two levels deep. No tab bar.

```
HOME (two states: PRACTICE | ARMED)
 ├─ Pre-Show check   (drums leg → hands leg → verdict)
 ├─ Tuner            (fundamental / lug pass / targets)
 ├─ Rudiments        (highway; picker → run → report)
 ├─ Timing           (free play → report → baseline)
 ├─ History          (sessions, trends, Focus-card source)
 └─ Status & Settings (calibration, kit, tolerances, backup)
```

Launch never asks for the microphone. Home renders instantly from
localStorage; the mic is requested lazily by the first screen that needs it
(so any iOS permission prompt appears attached to an obvious reason).

## 3. Home — PRACTICE state (default)

True-black OLED background. Top to bottom:

1. **Arm strip** (~120pt): full-width outlined button, "TONIGHT'S A SHOW".
   Tap → Arm sheet (stage-time chips 20:00/21:00/22:00/23:00/now+2h,
   ±15min steppers, one ARM button). Arming is the single action that
   changes everything, so it sits on top — but it is never automatic.
2. **Focus card — "WHAT THE DATA SAYS"**: up to three machine-generated rows,
   fixed deterministic rules, ranked by effect size, worded as facts:
   - "Paradiddle L-lead: mean +12 ms late across last 3 sessions"
   - "Floor tom drifted −2.8 Hz since Tuesday"
   Each row deep-links to the exact fix: the rudiment preloaded at the
   offending tempo, or the drifted drum in the Tuner. No rows yet? The card
   says what it's waiting for ("2 more sessions to compare"). This is the
   reason to open the app daily — pull from honest data, not streak-guilt.
3. **Module grid** 2×2: TUNER · RUDIMENTS · TIMING · HISTORY. Each tile:
   glyph, label, one factual stat line ("6/6 targets", "baseline 12d old" —
   amber when stale >21d).
4. **Status footer** (mono, 13pt): "Calibrated 87ms · baseline 12d · 6/6
   targets". Any gap renders amber and taps to its fix.

## 4. Home — ARMED state (the ritual)

The entire screen becomes the ritual card. Survives relaunch; auto-disarms
2h after stage time, filing the result into History.

1. **Context line**: "SHOW DAY — ARMED 16:40 · STAGE 21:00".
2. **The Big Button** (≥55% of viewport): its label is always the next undone
   action — "CHECK DRUMS" → "CHECK HANDS" → then it *becomes the verdict*:
   **DIALED** (green, filled circle) or **NOT YET** (red, open triangle, with
   the worst offender inline). One glance = current truth; one tap = next step.
3. **The ledger** (two mono rows, persistent):
   `DRUMS ✓ 17:12 — 6/6 within ±10¢` / `HANDS — not checked`.
   This makes the *split ritual* first-class: drums at soundcheck, hands
   backstage three hours later, across relaunches. Tap a row for its detail.
4. **Thumb bar**: WARMUP (last rudiment preloaded) · TUNER · DISARM (held).

Tap-count truths: armed launch → "am I dialed?" = **0 taps** (it's the Big
Button's face). Run the next leg = **1 tap**. Full check from practice state =
2 taps (arm ceremony happens hours earlier, when hands are free).

## 5. The check legs

**Drums leg** — phone on the snare stand, screen up, zero taps per drum:
progress segments across the top (green filled / red triangle / gray pending);
drum name 40pt; "HIT IT"; live fundamental 88pt mono; target line under it;
±10 Hz deviation bar. Three clean strikes agreeing within 1.5 Hz → median vs
target → 700ms result flash → auto-advance. Un-targeted drums auto-skip
(disclosed). Failed drums don't block — the verdict says "FLOOR TOM −18¢ —
tune UP". Thumb bar: REDO · SKIP · (held) END.

**Hands leg** — auto-starts with a 4-click count-in at baseline tempo. Center:
countdown 88pt. Middle: live early/late dot strip (last 32 hits, center
hairline, EARLY/LATE labels) — *no running verdict mid-take*; the numbers come
at the end. Bottom: (held) ABORT. Backgrounding the app invalidates the run
and says so; it never silently scores a truncated take.

**Verdict** — one word first (DIALED / NOT YET), then the ledger with numbers,
then per-item rows each carrying its fix ("tune UP", "spread 11.2 vs baseline
8.9 — warm up more, run again"). RUN AGAIN re-runs only failed legs.

## 6. Practice surfaces

- **Tuner**: hero readout (Hz 88pt, note+cents under), needle, lug-pass dots
  around a drum circle, kit selector as chips, "save as target" (held, since
  it overwrites). Inert above the thumb bar while listening.
- **Rudiments**: full-screen highway; HUD top (inert): streak, accuracy,
  last judgement + signed ms. One control: (held) STOP. End report = the
  honest numbers + per-step means, then "again / slower / faster" buttons.
- **Timing**: BPM/grid/length chips → one START. Same dot strip as the hands
  leg. End report offers "save as baseline" (held — it redefines DIALED).
- **History**: sessions list + two sparkline trends (spread across sessions,
  pocket %), per-rudiment bests, the data the Focus card cites. No medals —
  just the graphs moving.

## 7. First-run (at rehearsal, not at the gig)

A 4-step checklist the app walks once, each step skippable, footer shows
what's still missing:

1. **Mic** — explainer screen *then* the permission prompt ("analysis happens
   on this phone; nothing is recorded or uploaded").
2. **Calibrate** — hit the drum on 10 clicks; median mic-vs-click offset.
   (Mic-based on purpose: it measures the full input chain the scores use.
   Screen-tap calibration would measure the wrong path — see §9.)
3. **Kit** — name drums, tap each to capture today's tuning as target.
4. **Baseline** — 60s timing check on a good day, saved.

Plus the iOS one-timer: Share → **Add to Home Screen** education card with
"why: full screen, offline, opens in one tap at the venue".

## 8. iOS-PWA specifics

- **Wake lock** during sessions (Screen Wake Lock API); released on end.
- **Backgrounding** suspends the AudioContext → any live run is invalidated
  honestly, with a one-tap restart.
- **Permission timing**: mic requested at screen entry (attached to intent),
  never at launch; a denial shows the Settings-app path in words.
- **Relaunch**: standalone PWAs relaunch at start_url — home always
  reconstructs state (armed card, ledger, half-done check) from localStorage.
- **Audio route changes** (AirPods connect, call ends): session pauses and
  says why, never silently rescores.
- **No haptics** (unreliable in iOS PWAs): confirmations are visual (state
  flash) + audible (through the metronome bus) only.

## 9. Mistakes the panel caught — designed out

| Rejected idea | Why it's wrong | This spec |
|---|---|---|
| Screen-tap latency calibration | Measures output + touch-digitizer lag; scores are judged from **mic onsets**, a different path | Calibration stays mic-based (hit the drum on the click) — as implemented |
| Hard-gating the pre-show check on complete setup | One un-targeted rack tom would kill the whole check 10 min before stage | Soft-gate: skip + disclose (§1.8) |
| Mandatory arm-the-mic screen on every launch | Taxes the 90% use case (glancing at the verdict) and detaches the permission prompt from intent | Home renders micless; lazy mic per screen (§2) |
| Practice-first home demoting the verdict | The walk-on moment is the product's reason to exist | Two-state home; armed state owns the screen (§4) |
| History saved but never shown | Data with no surface can't create daily pull | History module + Focus card (§3, §6) |

## 10. Implementation map (current webapp → this spec)

Already built: all five engines (tuner, pre-show legs, highway, timing,
mic-based calibration), the honest-numbers reporting, offline PWA shell.

v1.1 (UI restructure, no new DSP): two-state home + arm sheet + ledger
state-machine (replaces tab bar as entry); thumb-bar layout pass; held-action
component; color/shape state tokens; lazy mic per mode (currently armed at
boot); wake lock; backgrounding invalidation.

v1.2: session history store + History screen + Focus card rules; first-run
checklist; verdict deep-links ("tune UP" → Tuner on that drum).
