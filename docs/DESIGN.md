# Rhythm Checker design system (v3, "Stage Monitor")

The app looks like a photocopied gig poster and reads like a floor monitor.
Cream paper, black ink, one red, hazard tape. The number a drummer came for
is the biggest thing on the screen, and it has to be readable from the throne.

This file is the reference for anyone changing the UI. Tokens live in
`webapp/css/base.css`; a machine-readable copy is in
[`docs/design/tokens.json`](design/tokens.json).

## Principles

| Rule | How to check it |
|---|---|
| **Readable from the throne** | Live numbers are Space Mono 700 at 72 to 120 px. Nothing on screen is smaller than 11 px. |
| **One job per screen** | Each screen state has one red primary button, always in the bottom `.bar`. The monitor or hero number is the largest text. |
| **Honest numbers** | The app reports, it never judges. No grade words unless Settings > Grade words is on (off by default). Every signed ms number carries *early* or *late*. Every chart axis has ticks and a unit. |
| **Targets and contrast** | Every control has a hit box of at least 44 × 44 px. Text meets WCAG AA (we hold 4.6:1 to absorb the paper grain). |
| **One voice** | Strings follow the glossary below. No exclamation marks. Status lines stay up until the next event. |

## Tokens

All tokens are CSS custom properties on `:root` in `webapp/css/base.css`.

### Colour: one job each

| Token | Hex | Job |
|---|---|---|
| `--paper` | `#f2ecdd` | Page background |
| `--white` | `#ffffff` | Cards, tiles |
| `--ink` | `#141210` | All data and body text |
| `--red` | `#e0301e` | Primary button fill and the R hand. White text on it only at 24 px or larger |
| `--blue` | `#2b4cf0` | The L hand only |
| `--green` | `#3a7d34` | Inside your own tolerance, or saved. Always with a check or words |
| `--amber` | `#e8b23a` | Hazard tape, warn chips, toast action, focus ring on dark. Never data |
| `--red-ink` | `#c8281a` | Red text under 24 px (4.72:1 on paper) |
| `--amber-ink` | `#7a5a10` | Any amber-coloured text (5.40:1 on paper) |
| `--green-ink` | `#2f6a2a` | Green text on paper (5.54:1) |
| `--ink60` | `#5a534a` | Secondary text (6.43:1 on paper) |
| `--tint` | `#e9e2d0` | Summary strip, pocket band, gauge track |
| `--rule` | `#cfc5ae` | Hairlines and unlit meter bars (graphics only) |
| `--dot` / `--dot-strong` | `#8a857c` / `#6e685f` | Older hits / in-pocket dots (graphics only, never text) |
| `--heat1..3` | `#a8a091` `#6b6458` `#141210` | History heatmap, ordinal ramp |

Banned: `--red` as text under 24 px, `--dot` as text, opacity-dimmed text.

The R/L pair and the heat ramp were checked with a colour-vision-deficiency
palette validator (R/L ΔE 31.9 under protanopia; ramp passes as ordinal).

### Type

| Role | Font | Size | Where |
|---|---|---|---|
| Monitor | Space Mono 700 | 120 → 96 → 72 by glyph count | One live number per run screen |
| Hero | Space Mono 700 | 88 | One result number per screen |
| Masthead | Anton | 88 | Start poster only |
| Title stamp | Anton | 30 | `h1.stamp`, tilted −1.5°, red offset shadow |
| Direction word | Anton | 30 | EARLY / LATE / SHARP / FLAT beside a monitor |
| Primary / secondary button | Anton | 28 / 19 | `.bar` |
| Control | Oswald 700 | 15 | Segments, chips, summary strip |
| Label | Oswald 600 | 13 | Tile labels, section stamps |
| Body / caption | Space Mono 400 | 14 / 12 | Hints, toasts, sub-lines |
| Axis / footnote | Space Mono 400 | 11 | The floor. Chart ticks and footnotes only |

No CSS `text-transform` anywhere: source strings carry their display case, so
what the code says is what the screen shows. Fonts are bundled in
`webapp/fonts/`; icons are inline SVG from `ui.icon(name)` because the fonts
lack arrow and check glyphs.

### Space, size, depth, motion

- Spacing: 4, 8, 12, 16, 24, 32 px (`--s1`…`--s8`); 16 px gutter; 44 px hit size.
- Fixed heights, never `flex: 1`: header 52, title row 44, segment 48, primary button 64, bar 90, highway 220 running.
- Shadows are hard offsets with zero blur: 2 px controls, 3 px cards, 5 px primary, 6 px poster.
- Motion: one 120 ms tween (disclosures) and the 600 ms hold-to-confirm fill. Anything shaped like an instrument moves only with real data. Reduced motion stops the hazard stripes and the meter peak decay.

## Components

Class API in `webapp/css/base.css`; helpers in `webapp/js/ui.js`.

| Component | Notes |
|---|---|
| `.bar` | Sticky bottom bar on every tool screen. One `.btn--primary`, optional `.btn--secondary`. A disabled primary always shows a `.bar__reason` line. |
| `.btn--primary` / `--secondary` / `--quiet` / `--danger` | Always pair `.btn` with a modifier. `--danger` is only used with `.hold`. |
| `.hold` | `holdToConfirm(button, fn, { label })`. Destructive actions are held for 600 ms (pointer, or Enter/Space held). The label narrates KEEP HOLDING…. |
| `.seg`, `.seg--tall`, `.seg--scroll` | `seg(container, options, value, onChange)`. Selected state is `.on` plus `aria-pressed`. Ink fill when on, never red. |
| `.chip`, `.chip-btn` | Static status (28 tall) vs. interactive (44 tall). `--ok`, `--warn`, `--ink` variants. |
| `.card`, `.statbox`, `.stat-strip` | White boxes with a hard shadow. Stat values never wrap and never change colour with the value. |
| `.monitor`, `.hero` | The live number and the result number. `monitorSize(str)` picks 120/96/72. |
| `.live` | Hazard LIVE banner that replaces the header while a run counts in or plays. Only STOP is on screen. |
| `.summary` | Locked one-line setup summary while running; a button back to setup after a run. |
| `.toast` | `toast(text, { action, onAction, keepClear, returnFocus })`. One at a time, 6 s, sits above the bar. While it shows, the screen keeps room under it and `keepClear` (the block just tapped) scrolls out from under it; that room is only given back when doing so cannot move the page. It stays up while keyboard focus is on its action, and if it closes holding focus, focus goes to `returnFocus`. UNDO restores the exact previous values. |
| `.sheet`, `.scrim` | Settings only. `role="dialog"`, header and main are `inert` while open, Esc closes, focus returns to the gear. |
| `.meter` | Four-bar mic meter in the header; tap goes to Calibrate. |
| `.stepper`, `.switch` | A real visible number input between − and +; a `role="switch"` toggle. |
| `.proxy-select` | A real `<select>` kept 1 px and transparent behind a custom control so tests and assistive tech still see it. |

## Run states

Rudiments, Timing and Calibrate's test share one contract. The screen root
carries `data-state`:

```
idle ──PLAY──▶ countin ──▶ running ──▶ result
  ▲              │ STOP       │ STOP      │ PLAY AGAIN → countin
  └─────────── stopped ◀──────┘           │ EDIT SETUP → idle
```

`setRunState(root, state)` sets the attribute and dispatches a `rc:run` event;
the shell alone swaps the header for the LIVE banner. Setup is hidden while
counting in or running, and every setup handler returns early while a run is
live. After an import, RESET ALL or closing Settings, the shell calls the
current screen's `refresh()`.

## Charts

Each chart was designed form-first (pick the chart form, then colour by job,
then validate, then marks, then accessibility), and each has a text twin.

- **Note highway** (canvas): two lanes, R over L, with a NOW line. Pucks carry their hand letter, so colour is never the only cue. `fitCanvas()` keeps the drawing undistorted at any DPR.
- **Early/late strip**: one axis from −60 to +60 ms, labelled EARLY and LATE, plus the real counting window as a band. Position carries the meaning, not hue.
- **Tuner gauge** (SVG): ±50¢ arc with your own tolerance as the green zone, ticks every 5¢ and labels every 25¢.
- **Drift chart** (canvas): every hit over time, early up, with the pocket band and a rolling mean. Drift is a least-squares slope from 5 s on.
- **History**: spread per run over time (rudiments and timing are separate series) and a 10-week heatmap with a legend and per-cell labels.

## Copy

| Use | Not |
|---|---|
| spread (±x ms, the standard deviation) | steadiness |
| avg 8.8 ms early | mean, a bare signed number |
| pocket | band |
| extra hits | strays |
| drift (ms/min, later/earlier) | trend |
| latency, shown as the correction: −8 ms | calibration offset |
| threshold | TRIG |
| days in a row | streak |
| batter / reso | B / R |
| run (Calibrate uses *test*) | session |

Formatting: real minus sign (U+2212), a no-break space between a value and
its unit (`nbsp()`), integers on live monitors, one decimal on results.

## Accessibility gate

Checked before every UI change ships:

- 0 visible text under 11 px; every control at least 44 × 44.
- Only the colour pairs above; white on red only at 24 px or larger.
- A visible `:focus-visible` ring on every control (amber on dark surfaces).
- Settings and the mic-lost dialog trap focus, make the page behind them `inert`, and return focus when they close.
- Destructive holds work from the keyboard (hold Enter or Space).
- Charts have `role="img"` and a summary label; their values also appear as HTML.
- Check at 390 × 763 (an installed iPhone) that the primary button is fully visible.

v3 before → after, measured over 18 screen states in Chromium at 390 × 844:
text under 11 px went from 333 to 0, controls under 44 px from 208 to 0, and
contrast failures stayed at 0.

## Using the tokens in Figma

`docs/design/tokens.json` is W3C design-tokens JSON (colour, font family,
font size, space, size, shadow, motion). Import it with the Tokens Studio
plugin. After editing the `:root` block in `base.css`, regenerate it:

```sh
python3 docs/design/gen_tokens.py webapp/css/base.css docs/design/tokens.json
```
