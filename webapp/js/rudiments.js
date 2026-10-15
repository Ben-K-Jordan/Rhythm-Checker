// Rudiment trainer — the hero screen. A horizontal scroll strip: R/L pucks
// ride right-to-left past a fixed NOW read-head and are judged live as they
// cross it. Now drives all 40 PAS/Vic Firth essential rudiments from
// rudiment-data.js: sparse rhythms, flams, drags, buzz rolls, odd counts.
// The mic hears WHEN, not WHICH HAND — sticking letters are guidance, and
// grace notes (flams/drags) render for feel but are scored at their primary.

import { ChartPlayer } from './metronome.js';
import { METERS, meterById, defaultGrouping, accentsFor, segmentAt, TapTempo } from './meter.js';
import { RUDIMENTS, CATEGORIES, rudimentById } from './rudiment-data.js';
import { rudimentNotationSVG, notationModel } from './notation.js';
import { BleedGuard, judgeHit, JUDGE_WINDOWS, summarize } from './dsp.js';
import { store } from './store.js';
import { FEELS } from './feel.js';
import { wakeLock } from './audio.js';
import {
  icon, fmtSigned, dirWord, offsetText, nbsp, monitorSize, factLine, announce, setRunState, seg,
} from './ui.js';
import { createHighway } from './highway.js';

export { RUDIMENTS };

export const RAMPS = [
  { id: 'off', label: 'STEADY', sub: 'no ramp', ramp: null },
  { id: 'r5x4', label: '+5', sub: 'per 4 bars', ramp: { addBpm: 5, everyBars: 4 } },
  { id: 'r10x4', label: '+10', sub: 'per 4 bars', ramp: { addBpm: 10, everyBars: 4 } },
  { id: 'r5x8', label: '+5', sub: 'per 8 bars', ramp: { addBpm: 5, everyBars: 8 } },
];

// Accent modes are available on every rudiment. AS WRITTEN shows the
// rudiment's own written accents; the others let you run it as an accent
// study (accent the beats, strip every accent, or place your own).
export const ACCENT_MODES = [
  { id: 'pattern', label: 'AS WRITTEN' },
  { id: 'pulses', label: 'ON BEAT' },
  { id: 'none', label: 'NONE' },
  { id: 'custom', label: 'CUSTOM' },
];

const MATCH_WINDOW_MS = 90;   // absolute accept cap (slow tempos)
const MISS_SLACK_MS = 55;     // grace past the accept window before a miss
const GRACE_GAP_S = 0.045;    // visual lead of a flam/drag grace before its primary
const GRACE_MIN_EARLY_MS = 8; // an onset earlier than this, before a grace note, may be a grace
const GRACE_LEAD_MS = 18;     // typical grace lead added back when a grace merges into its primary
const GRACE_LEAD_CAP_MS = 24; // never credit back more than this, so it can't mask real rushing
const CLUSTER_SETTLE_MS = 40; // wait past the late window before judging a cluster, so a late
//                               primary (the detector emits ~26 ms after the hit) still lands in it
const BARS_CYCLE = [8, 16, 32, 64];

// Half a gap between notes, capped at 90 ms. Used per-side for the asymmetric
// accept window (early = half the previous gap, late = half the next gap), so
// a hit maps to its nearest note with no dead zone between CLOSE notes. On
// sparse rudiments (gaps > 180 ms) the cap does leave an outer band that reads
// as a stray rather than a graded miss — deliberate wild-hit rejection.
export function matchWindowMs(gapSec) {
  return Math.min(MATCH_WINDOW_MS, 0.5 * gapSec * 1000);
}

// A flam/drag onset cluster resolves to its PRIMARY: the loudest stroke (graces
// are soft). If the grace merged into a single onset, add back a typical grace
// lead per grace so a clean flam reads on-time, not early. Pure + exported so
// the geometry is machine-checked.
export function clusterPrimaryDev(cluster, grace) {
  if (!cluster || !cluster.length) return { dev: 0, level: 0 };
  let prim = cluster[0];
  for (const e of cluster) {
    // loudest is the primary; if two are equally loud, the one nearer the beat
    // (graces sit before it)
    if (e.level > prim.level || (e.level === prim.level && Math.abs(e.dev) < Math.abs(prim.dev))) prim = e;
  }
  let dev = prim.dev;
  if (cluster.length === 1 && dev < -GRACE_MIN_EARLY_MS) {
    // the grace merged into this single onset — add back a typical lead, capped
    // so it can never mask real rushing
    dev = Math.min(0, dev + Math.min(GRACE_LEAD_MS * grace, GRACE_LEAD_CAP_MS));
  }
  return { dev, level: prim.level };
}

// Horizontal zoom for the highway. Dense rudiments (sextuplet rolls, drags)
// pack their notes tightly; scale so the TIGHTEST gap stays legible without
// flying by so fast you can't read ahead. Floor keeps sparse charts calm.
export function highwayPxPerSec(minStep) {
  return Math.max(240, Math.min(440, 46 / (minStep || 0.2)));
}

// Puck radius that never lets two neighbouring notes overlap: at 0.46 of the
// gap each, two adjacent pucks span 0.92 of the gap — a hair of daylight
// between them — and full size (capped) once notes are comfortably spread.
export function puckRadius(stepSec, pxPerSec, accent) {
  return Math.max(14, Math.min(accent ? 27 : 23, 0.46 * stepSec * pxPerSec));
}

function swapLead(ch) {
  const map = { R: 'L', L: 'R' };
  return map[ch] || ch;
}

function accentForNote(rud, accent, note) {
  switch (accent.mode) {
    case 'none': return false;
    case 'pulses': return note.slot % rud.grid === 0;
    case 'custom': return accent.custom.includes(note.phrasePos);
    default: return note.accent; // AS WRITTEN = the rudiment's own accents
  }
}

// Build the full chart: a ramp-aware pulse timeline, the rudiment phrase laid
// repeatedly over it, clicks on the meter's pulses. Returns notes (primaries,
// each with grace times for drawing), clicks, barOffsets, tempo segments.
export function buildChart(rud, groove, bars, ramp, lead = 'R',
  accent = { mode: 'pattern', custom: [] }) {
  const { meter } = groove;
  const accents = meter.accents;
  const pulseStart = [];
  const pulseDur = [];
  const clicks = [];
  const barOffsets = [];
  const segments = [];
  let t = 0;
  let curBpm = groove.bpm;
  for (let bar = 0; bar < bars; bar++) {
    if (ramp && bar > 0 && bar % ramp.everyBars === 0) {
      curBpm = Math.min(ramp.maxBpm || 400, curBpm + ramp.addBpm);
    }
    if (!segments.length || segments[segments.length - 1].bpm !== curBpm) {
      segments.push({ bar, bpm: curBpm, offset: t });
    }
    barOffsets.push(t);
    const pd = 60 / curBpm;
    for (let p = 0; p < meter.pulses; p++) {
      pulseStart.push(t + p * pd);
      pulseDur.push(pd);
      clicks.push({ offset: t + p * pd, accent: accents.includes(p) });
    }
    t += meter.pulses * pd;
  }
  const total = t;

  // per-phrase-position notation info (written value + tuplet), so the
  // scrolling staff can draw the same durations/beams as the static one.
  const model = notationModel(rud, { accentOf: (n, i) => accentForNote(rud, accent, { ...n, phrasePos: i }) });
  const noteInfo = {};
  model.forEach((beat) => beat.notes.forEach((mn) => {
    noteInfo[mn.idx] = { beams: mn.beams, dot: mn.dot, tuplet: beat.tuplet };
  }));

  const totalPulses = pulseStart.length;
  const phraseCount = Math.floor(totalPulses / rud.beats);
  const notes = [];
  let idx = 0;
  for (let ph = 0; ph < phraseCount; ph++) {
    for (let k = 0; k < rud.notes.length; k++) {
      const nd = rud.notes[k];
      const beatInPhrase = Math.floor(nd.slot / rud.grid);
      const gp = ph * rud.beats + beatInPhrase;
      if (gp >= totalPulses) continue;
      const sub = nd.slot % rud.grid;
      const offset = pulseStart[gp] + (sub * pulseDur[gp]) / rud.grid;
      let hand = nd.hand;
      if (lead === 'L') hand = swapLead(hand);
      const info = noteInfo[k] || { beams: 0, dot: false, tuplet: null };
      const note = {
        index: idx++,
        phrasePos: k,
        slot: nd.slot,
        offset,
        stick: hand,
        accent: false, // filled below (needs the note object for the accent mode)
        grace: nd.grace,
        buzz: nd.buzz,
        graceTimes: [],
        beams: info.beams,
        dot: info.dot,
        tuplet: info.tuplet,
        beatGroup: gp, // notes sharing a beat are beamed together on the staff
        state: 'coming',
        devMs: null,
      };
      note.accent = accentForNote(rud, accent, { ...nd, phrasePos: k });
      for (let g = nd.grace; g > 0; g--) note.graceTimes.push(offset - g * GRACE_GAP_S);
      notes.push(note);
    }
  }
  notes.sort((a, b) => a.offset - b.offset);
  for (let i = 0; i < notes.length; i++) {
    // gaps to each neighbour, used for an ASYMMETRIC accept window: a note owns
    // up to half the space to the note before it (early side) and half the
    // space to the note after it (late side). A phrase-leading downbeat after a
    // rest therefore keeps a wide early window even when a fast note follows it.
    notes[i].gapPrev = i > 0 ? notes[i].offset - notes[i - 1].offset : Infinity;
    notes[i].gapNext = i + 1 < notes.length ? notes[i + 1].offset - notes[i].offset : Infinity;
    // step drives rendering spacing/overlap: the tighter adjacent gap so a puck
    // never overlaps either neighbour.
    notes[i].step = Math.min(notes[i].gapPrev, notes[i].gapNext);
    if (!Number.isFinite(notes[i].step)) notes[i].step = 0.2;
  }
  return { notes, clicks, barOffsets, segments, total };
}


const NBSP = ' ';
const one = (x) => Math.abs(x).toFixed(1);
const HAND_WORD = { R: 'right', L: 'left' };
const PUCK_SIZE = 44;    // accent puck, = the 44 px target
const PUCK_PITCH = 46;   // puck + 2 px gap
const PUCK_ROW_MAX = 8;  // never more than one bar of 16ths in a row
const HEAD_DX = 6;       // notation.js draws a notehead 6 px right of its slot
const CYCLE_SVG = '<svg class="icon param-box__cue" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2.8" d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M20.5 3.5v6h-6z"/></svg>';

// Signed tick label for an ms axis: U+2212 minus, '+' on positives, bare 0.
function tickLabel(v) {
  return v === 0 ? '0' : fmtSigned(v, 0);
}

export class RudimentsMode {
  constructor(root, mic, nav = null) {
    this.root = root;
    this.mic = mic;
    this.nav = nav || ((name) => window.__rhythmChecker && window.__rhythmChecker.nav(name));
    this.running = false;
    this.state = 'idle';
    this.lead = 'R';
    this.bars = 16;
    this.rampId = 'off';
    this.accentMode = 'pattern';
    this.customAccents = new Set();
    this.expand = null;
    this.rudimentId = 'single-paradiddle';
    this.readGroove();
    this.tap = new TapTempo();
    this.recentDevs = [];
    this.judged = [];
    this.stopInfo = null;
    this.saved = false;
    this._raf = null;
    this.render();
    mic.addEventListener('onset', (e) => this.onHit(e.detail));
  }

  activate() {
    this.mic.setDetectorOptions({ refractory: 0.03, threshold: 2.5, minLevel: 0.01 });
    this.refresh();
    if (!this._raf) this.loop();
  }

  // the working tempo / meter / grouping from the store (a grouping that is
  // not one of the meter's own falls back to its default)
  readGroove() {
    const saved = store.get('grooveRud');
    const meter = meterById(saved && saved.meterId);
    this.bpm = (saved && saved.bpm) || store.get('preferredBpm') || 120;
    this.meterId = meter.id;
    this.grouping = saved && typeof saved.grouping === 'string' && Object.hasOwn(meter.groupings, saved.grouping)
      ? saved.grouping : defaultGrouping(meter);
  }

  // Re-read what Settings, an import, RESET ALL, Calibrate or a player feel may
  // have changed: tempo, meter, the NOT CALIBRATED chip, the feel's picks and
  // the setup views. The shell calls this after each (activate() too).
  // Targeted updates, so a run report already on screen survives; a run in
  // progress is never touched.
  refresh() {
    if (this.running) return;
    this.readGroove();
    this.updateTempoText();
    const meterChip = this.root.querySelector('#rud-meter-chip');
    if (meterChip) {
      const label = meterById(this.meterId).label;
      meterChip.textContent = label;
      meterChip.setAttribute('aria-label', `Meter: ${label}`);
    }
    if (this.expand) this.renderDisclosure(); // an open TEMPO / METER panel shows the new values
    const sel = this.root.querySelector('#rud-pattern');
    if (sel) sel.innerHTML = this.patternOptionsHTML();
    this.renderTitleSlot();
    this.refreshNotation();
  }

  grooveValue() {
    const meter = meterById(this.meterId);
    return {
      bpm: this.bpm,
      meter: { ...meter, accents: accentsFor(meter, this.grouping) },
      grouping: this.grouping,
    };
  }

  saveGroove() {
    store.set('grooveRud', { bpm: this.bpm, meterId: this.meterId, grouping: this.grouping });
    store.set('preferredBpm', this.bpm);
  }

  // pattern-picker options: when a player feel is loaded, its signature
  // rudiments float to the top in their own group, above the four PAS
  // categories. Kept separate so activate() can refresh it without a full
  // re-render (which would wipe a just-earned run report).
  patternOptionsHTML() {
    const rud = this.currentRudiment();
    const feelId = store.get('feel');
    const feel = feelId && FEELS[feelId];
    const picks = feel && feel.vocab ? feel.vocab.map((id) => rudimentById(id)).filter(Boolean) : [];
    const opt = (r) => `<option value="${r.id}" ${r.id === rud.id ? 'selected' : ''}>${r.num}. ${r.name}</option>`;
    return `${picks.length ? `<optgroup label="★ ${feel.label}'S PICKS">${picks.map(opt).join('')}</optgroup>` : ''}${CATEGORIES.map((c) => `<optgroup label="${c.label}">${RUDIMENTS.filter((r) => r.cat === c.id).map(opt).join('')}</optgroup>`).join('')}`;
  }

  setState(state, label = '') {
    this.state = state;
    setRunState(this.root, state, label);
  }

  // ------------------------------------------------------------ skeleton
  render() {
    const meter = meterById(this.meterId);
    this.root.innerHTML = `
      <div class="screen rud">
        <div class="title-row rud-title">
          <h1 class="stamp">RUDIMENTS</h1>
          <div class="rud-title__slot"></div>
        </div>
        <div class="card card--ink rud-stopped">
          <span class="chip chip--warn">STOPPED · NOT SAVED</span>
          <p class="rud-stopped__line"></p>
        </div>
        <div class="summary rud-lockstrip" role="group" aria-label="Setup locked while playing">
          <span class="rud-sum"></span>
          <span class="summary__lock">${icon('lock')}</span>
        </div>
        <button type="button" class="summary rud-sumbtn"><span class="rud-sum"></span><span class="sr-only">. Edit setup</span></button>

        <div class="rud-setup setup">
          <div class="rud-picker">
            <select id="rud-pattern" aria-label="Rudiment">${this.patternOptionsHTML()}</select>
            ${icon('tri-down')}
          </div>
          <div class="param-row">
            <div class="param-box">
              <span class="param-box__cap" aria-hidden="true">LEAD</span>${CYCLE_SVG}
              <button type="button" id="rud-lead" aria-label="Lead hand: ${HAND_WORD[this.lead]}">${this.lead}</button>
            </div>
            <div class="param-box">
              <span class="param-box__cap" aria-hidden="true">BARS</span>${CYCLE_SVG}
              <button type="button" id="rud-bars" aria-label="Bars: ${this.bars}">${this.bars}</button>
            </div>
            <div class="param-box param-box--menu">
              <span class="param-box__cap" aria-hidden="true">BPM</span>
              <button type="button" id="rud-tempo-chip" aria-expanded="false" aria-controls="rud-disc" aria-label="Tempo: ${this.bpm} BPM">${this.bpm}</button>
            </div>
            <div class="param-box param-box--menu">
              <span class="param-box__cap" aria-hidden="true">METER</span>
              <button type="button" id="rud-meter-chip" aria-expanded="false" aria-controls="rud-disc" aria-label="Meter: ${meter.label}">${meter.label}</button>
            </div>
          </div>
          <p class="param-badge hidden"></p>
          <div id="rud-disc" class="disclosure rud-disc hidden"></div>
          <section class="card rud-pattern-card" aria-labelledby="rud-pattern-head">
            <div class="sec-head">
              <h2 class="sec-head__stamp" id="rud-pattern-head">PATTERN</h2>
              <span class="sec-head__aside">Tap a note to accent it.</span>
            </div>
            <div class="rud-am" role="group" aria-label="Accents"></div>
            <div class="rud-notation" role="group" aria-label="Notation"></div>
            <div id="rud-accent-editor" class="accent-editor"></div>
          </section>
        </div>

        <div class="countin rud-countin">
          <b id="rud-count" aria-hidden="true"></b>
          <div class="countin__dots" aria-hidden="true"></div>
        </div>
        <div id="rud-judge-chip" class="monitor is-idle rud-monitor">
          <p class="monitor__cap" id="rud-judge-label">LAST HIT</p>
          <b id="rud-judge-num">—</b>
          <p class="monitor__side" id="rud-judge-cap"><span class="monitor__wait">LISTENING</span></p>
        </div>
        <div class="card rud-strip">
          <div class="rud-strip__head">
            <span class="rud-strip__dir">${icon('tri-left')}EARLY</span>
            <span class="rud-strip__legend">dots: last 8 · ${icon('tri-down')} average</span>
            <span class="rud-strip__dir">LATE${icon('tri-right')}</span>
          </div>
          <div class="rud-strip__plot"></div>
        </div>
        <div class="highway-panel">
          <canvas id="rud-highway" width="900" height="330" role="img" aria-label="Note highway"></canvas>
          <div class="hw-idle">
            <p class="hw-idle__title">PRESS PLAY</p>
            <p class="hw-idle__hint">One bar of count-in, then the notes scroll to the line.</p>
          </div>
          <p class="hw-legend" aria-hidden="true"><i class="hw-legend__past"></i>played · <i class="hw-legend__next"></i>coming up</p>
        </div>
        <div class="stat-strip rud-tiles">
          <div class="statbox"><b id="rud-spread">—</b><span>SPREAD</span></div>
          <div class="statbox"><b id="rud-avg">—</b><span id="rud-avg-label" aria-hidden="true">AVG</span><em id="rud-avg-sr" class="sr-only">Average</em></div>
          <div class="statbox"><b id="rud-acc">—</b><span>HITS</span><em id="rud-combo" class="hidden"></em></div>
        </div>
        <div id="rud-summary" class="rud-report"></div>
      </div>
      <div class="bar">
        <button type="button" id="rud-edit" class="btn btn--secondary">EDIT SETUP</button>
        <button type="button" id="rud-go" class="btn btn--primary">PLAY${icon('play')}</button>
      </div>`;

    const $ = (sel) => this.root.querySelector(sel);
    $('#rud-pattern').addEventListener('change', (e) => {
      if (this.running) { e.target.value = this.rudimentId; return; }
      this.rudimentId = e.target.value;
      // start each rudiment on its own written accents; custom indices from the
      // previous pattern don't carry over
      this.accentMode = 'pattern';
      this.customAccents.clear();
      if (this.amSeg) this.amSeg.set('pattern');
      this.renderAccentEditor();
    });
    $('#rud-lead').addEventListener('click', (e) => {
      // ignored mid-run: the chart was built with the lead at PLAY time, and
      // the run report + saved history label read this.lead afterwards — a
      // mid-run flip would label an R-lead run as L-lead and swap every hand
      // in the per-stroke report
      if (this.running) return;
      this.lead = this.lead === 'R' ? 'L' : 'R';
      e.currentTarget.textContent = this.lead;
      e.currentTarget.setAttribute('aria-label', `Lead hand: ${HAND_WORD[this.lead]}`);
      this.renderAccentEditor();
    });
    $('#rud-bars').addEventListener('click', (e) => {
      if (this.running) return;
      this.bars = BARS_CYCLE[(BARS_CYCLE.indexOf(this.bars) + 1) % BARS_CYCLE.length];
      e.currentTarget.textContent = this.bars;
      e.currentTarget.setAttribute('aria-label', `Bars: ${this.bars}`);
    });
    $('#rud-tempo-chip').addEventListener('click', () => {
      if (this.running) return;
      this.expand = this.expand === 'tempo' ? null : 'tempo';
      this.renderDisclosure();
    });
    $('#rud-meter-chip').addEventListener('click', () => {
      if (this.running) return;
      this.expand = this.expand === 'meter' ? null : 'meter';
      this.renderDisclosure();
    });
    $('.rud-sumbtn').addEventListener('click', () => this.editSetup());
    $('#rud-edit').addEventListener('click', () => this.editSetup());
    $('#rud-go').addEventListener('click', () => this.toggle());

    this.amSeg = seg($('.rud-am'),
      ACCENT_MODES.map((m) => ({ value: m.id, label: m.label, data: { am: m.id } })),
      this.accentMode,
      (mode) => {
        if (this.running) { this.amSeg.set(this.accentMode); return; }
        this.setAccentMode(mode);
      });

    this.hw = createHighway($('#rud-highway'));
    this.hw.draw(null);
    // puck rows and the staff above them follow the PATTERN card's width
    // (rotation, split view, a narrow phone), not just the first render
    this._padW = 0;
    if (typeof ResizeObserver === 'function') {
      if (this._ro) this._ro.disconnect();
      this._ro = new ResizeObserver(() => this.onPatternResize());
      this._ro.observe($('#rud-accent-editor'));
    }
    this.renderAccentEditor();
    this.renderRampBadge();
    this.renderTitleSlot();
    this.resetLive();
    this.setState('idle');
  }

  currentRudiment() {
    return rudimentById(this.rudimentId);
  }

  updateTempoText() {
    const chip = this.root.querySelector('#rud-tempo-chip');
    if (chip) {
      chip.textContent = this.bpm;
      chip.setAttribute('aria-label', `Tempo: ${this.bpm} BPM`);
    }
    const big = this.root.querySelector('#rud-bpm-big');
    if (big) big.textContent = this.bpm;
  }

  setBpm(v) {
    this.bpm = Math.max(20, Math.min(400, Math.round(v)));
    this.saveGroove();
    this.updateTempoText();
  }

  // the active ramp, as a line under the param row (beside the tempo chip,
  // never on a box border); the same words as the RAMP segment it came from
  renderRampBadge() {
    const badge = this.root.querySelector('.param-badge');
    if (!badge) return;
    const r = RAMPS.find((x) => x.id === this.rampId);
    badge.classList.toggle('hidden', !r || !r.ramp);
    if (r && r.ramp) {
      badge.innerHTML = `${icon('ramp')}<b>RAMP</b> ${nbsp(`+${r.ramp.addBpm}`, 'BPM')} per ${nbsp(r.ramp.everyBars, 'bars')}`;
    } else {
      badge.replaceChildren();
    }
  }

  // inline disclosure under the param row: TEMPO or METER, one at a time; a
  // selection inside keeps it open
  renderDisclosure() {
    const disc = this.root.querySelector('#rud-disc');
    const tempoChip = this.root.querySelector('#rud-tempo-chip');
    const meterChip = this.root.querySelector('#rud-meter-chip');
    tempoChip.setAttribute('aria-expanded', String(this.expand === 'tempo'));
    meterChip.setAttribute('aria-expanded', String(this.expand === 'meter'));
    tempoChip.parentElement.classList.toggle('is-open', this.expand === 'tempo');
    meterChip.parentElement.classList.toggle('is-open', this.expand === 'meter');
    this.rampSeg = null;
    this.meterSeg = null;
    if (!this.expand) {
      disc.classList.add('hidden');
      disc.replaceChildren();
      return;
    }
    disc.classList.remove('hidden');
    disc.setAttribute('aria-label', this.expand === 'tempo' ? 'Tempo' : 'Meter');
    if (this.expand === 'tempo') {
      disc.innerHTML = `
        <div class="rud-tempo">
          <div class="rud-steps">
            <button type="button" data-bpm="-5" aria-label="Tempo down 5">−5</button>
            <button type="button" data-bpm="-1" aria-label="Tempo down 1">−1</button>
          </div>
          <p class="rud-bpm"><b id="rud-bpm-big">${this.bpm}</b><span>BPM</span></p>
          <div class="rud-steps">
            <button type="button" data-bpm="1" aria-label="Tempo up 1">+1</button>
            <button type="button" data-bpm="5" aria-label="Tempo up 5">+5</button>
          </div>
          <button type="button" id="rud-tap" class="rud-tap" aria-label="Tap tempo">TAP</button>
        </div>
        <p class="rud-disc__label">RAMP</p>
        <div class="seg--tall rud-ramp"></div>`;
      disc.querySelectorAll('[data-bpm]').forEach((b) => {
        b.addEventListener('click', () => {
          if (this.running) return;
          this.setBpm(this.bpm + +b.dataset.bpm);
        });
      });
      disc.querySelector('#rud-tap').addEventListener('click', () => {
        if (this.running) return;
        const bpm = this.tap.tap(this.mic.now());
        if (bpm) this.setBpm(bpm);
      });
      this.rampSeg = seg(disc.querySelector('.rud-ramp'),
        RAMPS.map((r) => ({
          value: r.id, label: r.label, sub: r.sub, data: { ramp: r.id },
          aria: r.ramp ? `Plus ${r.ramp.addBpm} BPM every ${r.ramp.everyBars} bars` : 'Steady, no ramp',
        })),
        this.rampId,
        (id) => {
          if (this.running) { this.rampSeg.set(this.rampId); return; }
          this.rampId = id;
          this.renderRampBadge();
        });
    } else {
      const meter = meterById(this.meterId);
      disc.innerHTML = '<div class="rud-meters"></div><div class="rud-groupings"></div>';
      this.meterSeg = seg(disc.querySelector('.rud-meters'),
        METERS.map((m) => ({ value: m.id, label: m.label, data: { meter: m.id } })),
        meter.id,
        (id) => {
          if (this.running) { this.meterSeg.set(this.meterId); return; }
          this.meterId = id;
          this.grouping = defaultGrouping(meterById(id));
          this.saveGroove();
          const label = meterById(id).label;
          meterChip.textContent = label;
          meterChip.setAttribute('aria-label', `Meter: ${label}`);
          this.renderGroupings();
        });
      this.renderGroupings();
    }
  }

  renderGroupings() {
    const host = this.root.querySelector('.rud-groupings');
    if (!host) return;
    const groupings = Object.keys(meterById(this.meterId).groupings);
    if (groupings.length < 2) {
      host.className = 'rud-groupings hidden';
      host.replaceChildren();
      return;
    }
    host.className = 'rud-groupings';
    const s = seg(host,
      groupings.map((g) => ({ value: g, label: g, data: { grouping: g }, aria: `Grouping ${g}` })),
      this.grouping,
      (g) => {
        if (this.running) { s.set(this.grouping); return; }
        this.grouping = g;
        this.saveGroove();
      });
  }

  renderTitleSlot() {
    const slot = this.root.querySelector('.rud-title__slot');
    if (!slot) return;
    if (this.state === 'result') {
      slot.innerHTML = this.saved ? `<span class="chip chip--ok">${icon('check')}SAVED TO HISTORY</span>` : '';
      return;
    }
    if (store.get('calibrationMs') === null) {
      slot.innerHTML = '<button type="button" class="chip-btn chip--warn rud-fix">NOT CALIBRATED · FIX</button>';
      slot.querySelector('.rud-fix').addEventListener('click', () => {
        if (this.running) return;
        this.nav('calibrate');
      });
    } else {
      slot.replaceChildren();
    }
  }

  // real rhythm notation for the current rudiment; accents reflect the chosen
  // mode (AS WRITTEN by default) — a sight-reading aid.
  notationSVG(rud, width, grid = null) {
    const accent = this.accentValue();
    return rudimentNotationSVG(rud, {
      width,
      ...(grid || {}),
      accentOf: (n, idx) => accentForNote(rud, accent, { ...n, phrasePos: idx }),
    });
  }

  refreshNotation() {
    const el = this.root.querySelector('.rud-notation');
    if (!el) return;
    const rud = this.currentRudiment();
    const grid = this.notationGrid(rud, el);
    el.classList.toggle('is-aligned', !!grid);
    el.innerHTML = this.notationSVG(rud, el.clientWidth || 340, grid);
    el.scrollLeft = 0;
  }

  // Staff geometry that stacks each notehead over its sticking puck: the
  // first puck's centre (in .rud-notation px) and one puck pitch per note.
  // Only when the whole phrase sits in one puck row and its notes are evenly
  // spaced in time, as the pucks are; otherwise null (proportional spacing).
  notationGrid(rud, host) {
    const rows = this.root.querySelectorAll('#rud-accent-editor .accent-row');
    if (rows.length !== 1 || !host.clientWidth) return null;
    const slots = rud.notes.map((n) => n.slot);
    const step = slots.length > 1 ? slots[1] - slots[0] : 0;
    if (step <= 0 || slots.some((s, i) => i > 0 && s - slots[i - 1] !== step)) return null;
    const first = rows[0].querySelector('.accent-puck');
    if (!first) return null;
    const hr = host.getBoundingClientRect();
    const pr = first.getBoundingClientRect();
    const centre = pr.left + pr.width / 2 - (hr.left + host.clientLeft);
    const beatW = (rud.grid / step) * PUCK_PITCH;
    return { padL: centre - HEAD_DX - (slots[0] / rud.grid) * beatW, beatW };
  }

  // how many pucks fit one row of the PATTERN card (null while it is hidden)
  puckRowCap() {
    const el = this.root.querySelector('#rud-accent-editor');
    if (!el || !el.clientWidth) return null;
    const cs = getComputedStyle(el);
    const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return Math.max(1, Math.min(PUCK_ROW_MAX, Math.floor((inner + PUCK_PITCH - PUCK_SIZE) / PUCK_PITCH)));
  }

  onPatternResize() {
    const el = this.root.querySelector('#rud-accent-editor');
    const w = el ? el.clientWidth : 0;
    if (!w) { this._padW = 0; return; } // hidden: lay out again once shown
    if (w === this._padW) return;       // only the height changed
    this._padW = w;
    if (this.puckRowCap() !== this._rowCap) this.renderAccentEditor();
    else this.refreshNotation();
  }

  accentValue() {
    return { mode: this.accentMode, custom: [...this.customAccents] };
  }

  setAccentMode(mode) {
    if (mode === 'custom' && this.customAccents.size === 0) {
      // seed custom from whatever is currently SHOWN (on beat/none/as written),
      // not always the written pattern, so switching to custom continues from
      // the accents you were just looking at.
      const rud = this.currentRudiment();
      const shown = this.accentValue();
      rud.notes.forEach((n, i) => { if (accentForNote(rud, shown, { ...n, phrasePos: i })) this.customAccents.add(i); });
    }
    this.accentMode = mode;
    if (this.amSeg) this.amSeg.set(mode);
    this.renderAccentEditor();
  }

  // One 44 px puck per note. A row holds as many as the card fits (8 on a
  // 390 phone, 6 at 320) and breaks on a beat boundary; a beat too long for
  // one row splits into even halves (or thirds).
  renderAccentEditor() {
    const el = this.root.querySelector('#rud-accent-editor');
    if (!el) return;
    const rud = this.currentRudiment();
    const accent = this.accentValue();
    const cap = this.puckRowCap() || this._rowCap || PUCK_ROW_MAX;
    this._rowCap = cap;
    const focusStep = el.contains(document.activeElement) ? document.activeElement.dataset.step : null;
    const beats = [];
    rud.notes.forEach((n, i) => {
      const b = Math.floor(n.slot / rud.grid);
      const last = beats[beats.length - 1];
      if (last && last.beat === b) last.idx.push(i);
      else beats.push({ beat: b, idx: [i] });
    });
    const rows = [[]];
    for (const b of beats) {
      const size = Math.ceil(b.idx.length / Math.ceil(b.idx.length / cap));
      for (let k = 0; k < b.idx.length; k += size) {
        const part = b.idx.slice(k, k + size);
        const row = rows[rows.length - 1];
        if (row.length && row.length + part.length > cap) rows.push(part);
        else row.push(...part);
      }
    }
    const puck = (i) => {
      const n = rud.notes[i];
      const hand = this.lead === 'L' ? swapLead(n.hand) : n.hand;
      const on = accentForNote(rud, accent, { ...n, phrasePos: i });
      const cls = ['accent-puck', hand === 'R' ? 'r' : 'l', on ? 'on' : '', n.slot % rud.grid === 0 ? 'pulse-start' : '']
        .filter(Boolean).join(' ');
      return `<button type="button" class="${cls}" data-step="${i}" aria-pressed="${on}"
        aria-label="Note ${i + 1}, ${HAND_WORD[hand]} hand, ${on ? 'accented' : 'not accented'}">${hand}</button>`;
    };
    el.innerHTML = rows.map((r) => `<div class="accent-row">${r.map(puck).join('')}</div>`).join('');
    if (focusStep !== null && focusStep !== undefined) {
      const again = el.querySelector(`.accent-puck[data-step="${focusStep}"]`);
      if (again) again.focus({ preventScroll: true });
    }
    this.refreshNotation();
    el.querySelectorAll('.accent-puck').forEach((p) => {
      p.addEventListener('click', () => {
        if (this.running) return;
        const step = +p.dataset.step;
        const hadFocus = document.activeElement === p;
        if (this.accentMode !== 'custom') {
          this.customAccents = new Set();
          rud.notes.forEach((n, i) => { if (accentForNote(rud, this.accentValue(), { ...n, phrasePos: i })) this.customAccents.add(i); });
          this.accentMode = 'custom';
          if (this.amSeg) this.amSeg.set('custom');
        }
        if (this.customAccents.has(step)) this.customAccents.delete(step);
        else this.customAccents.add(step);
        this.renderAccentEditor();
        const again = this.root.querySelector(`.accent-puck[data-step="${step}"]`);
        if (again && hadFocus) again.focus();
      });
    });
  }

  // the collapsed setup line shown while playing and on the result
  renderSummaryStrip(bpm) {
    const s = this.runSetup;
    if (!s) return;
    const sep = '<span class="summary__sep">·</span>';
    const html = `<span class="summary__name">${s.name.toUpperCase()}</span>${sep}<span>${s.lead} LEAD</span>${sep}<span>${nbsp(bpm || s.bpm, 'BPM')}</span>${sep}<span>${s.meter}</span>`;
    this.root.querySelectorAll('.rud-sum').forEach((el) => { el.innerHTML = html; });
  }

  renderStopped() {
    const line = this.root.querySelector('.rud-stopped__line');
    const info = this.stopInfo || { why: 'stopped', bar: 0, bars: this.bars };
    let text;
    if (info.why === 'cancelled') text = 'Run cancelled. You left mid-run. Not saved.';
    else if (info.why === 'invalidated') text = 'Mic lost. Run stopped, not saved.';
    else if (!info.bar) text = 'Stopped at count-in. Not saved.';
    else text = `Stopped at bar ${info.bar} of ${info.bars}. Not saved.`;
    line.textContent = text;
  }

  // summary strip / EDIT SETUP: back to setup. Both controls are hidden in
  // idle, so focus moves to the first setup control instead of <body>.
  editSetup() {
    if (this.running) return;
    this.setState('idle');
    this.renderTitleSlot();
    this.hw.draw(null);
    this.refreshNotation();
    const main = this.root.closest('main');
    if (main) main.scrollTop = 0;
    const first = this.root.querySelector('#rud-pattern');
    if (first) first.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------- live
  resetLive() {
    const $ = (sel) => this.root.querySelector(sel);
    const mon = $('#rud-judge-chip');
    mon.className = 'monitor is-idle rud-monitor';
    $('#rud-judge-label').textContent = 'LAST HIT';
    const num = $('#rud-judge-num');
    num.textContent = '—';
    num.style.setProperty('--mon-fs', `${monitorSize('—')}px`);
    $('#rud-judge-cap').innerHTML = '<span class="monitor__wait">LISTENING</span>';
    for (const id of ['#rud-spread', '#rud-avg', '#rud-acc']) {
      const b = $(id);
      b.textContent = '—';
      b.parentElement.classList.add('is-empty');
    }
    $('#rud-avg-label').textContent = 'AVG';
    $('#rud-avg-sr').textContent = 'Average';
    $('#rud-combo').classList.add('hidden');
  }

  toggle() {
    if (this.running) { this.stop(true); return; }
    const rud = this.currentRudiment();
    this.rudiment = rud;
    const rampDef = RAMPS.find((r) => r.id === this.rampId);
    const groove = this.grooveValue();
    this.accentUsed = this.accentValue();
    this.chart = buildChart(rud, groove, this.bars, rampDef.ramp, this.lead, this.accentUsed);
    this.grooveUsed = groove;
    this.barsUsed = this.bars;
    this.saveGroove();
    // judge settings are fixed for the whole run
    this.judgeMode = store.get('judgeMode');
    this.judgeWindows = JUDGE_WINDOWS[this.judgeMode] || JUDGE_WINDOWS.standard;
    this.pocketMs = store.get('pocketMs');
    this.showGradesRun = !!store.get('showGrades');
    this.runSetup = { name: rud.name, lead: this.lead, bpm: groove.bpm, meter: groove.meter.label };

    const pulseDur = 60 / groove.bpm;
    const countIn = [];
    for (let p = 0; p < groove.meter.pulses; p++) countIn.push({ offset: p * pulseDur, accent: p === 0 });
    const countInDur = groove.meter.pulses * pulseDur;
    const clicks = [
      ...countIn,
      ...this.chart.clicks.map((c) => ({ offset: c.offset + countInDur, accent: c.accent })),
    ];
    this.player = new ChartPlayer(this.mic.audioContext, clicks);
    this.player.start(0.2);
    this.chartStart = this.player.t0 + countInDur;
    this.countInDur = countInDur;

    // highway frame data: absolute times, radii and windows fixed per run
    const steps = this.chart.notes.map((n) => n.step).filter((s) => s > 0);
    this.pxPerSec = highwayPxPerSec(steps.length ? Math.min(...steps) : 0.2);
    const t0 = this.chartStart;
    this.hwNotes = this.chart.notes.map((n) => ({
      t: t0 + n.offset,
      hand: n.stick,
      accent: n.accent,
      grace: n.grace,
      graceTimes: n.graceTimes.map((g) => t0 + g),
      buzz: n.buzz,
      r: puckRadius(n.step, this.pxPerSec, n.accent),
      lateMs: matchWindowMs(n.gapNext),
      beams: n.beams,
      dot: n.dot,
      tuplet: n.tuplet,
      beatGroup: n.beatGroup,
      get state() { return n.state; },
      get devMs() { return n.devMs; },
    }));
    const downs = new Set(this.chart.barOffsets);
    this.hwBeats = this.chart.clicks.map((c) => ({ t: t0 + c.offset, down: downs.has(c.offset) }));

    this.combo = 0;
    this.bestCombo = 0;
    this.strays = 0;
    this.judged = [];
    this.recentDevs = [];
    this.bleed = new BleedGuard();
    this._clickPtr = 0;
    this._bar = 0;
    this._countLeft = null;
    this.saved = false;
    this.stopInfo = null;
    this.running = true;
    this.mic.lockDetector(this, { refractory: 0.03, threshold: 2.5, minLevel: 0.01 });
    wakeLock.acquire();
    this._lostHandler = () => this.stop(true, 'invalidated');
    this.mic.addEventListener('lost', this._lostHandler);

    this.expand = null;
    this.renderDisclosure();
    this.root.querySelector('#rud-summary').replaceChildren();
    this.root.querySelector('#rud-go').innerHTML = `${icon('stop')}STOP`;
    // fresh run, fresh boxes — run 1's numbers must not linger into run 2
    this.resetLive();
    this.renderSummaryStrip();
    this.setState('countin', `COUNT-IN · ${nbsp(groove.bpm, 'BPM')}`);
    this.renderCountIn(groove.meter.pulses);
    this.renderStrip();
    this.updateStats();
    this.root.closest('main')?.scrollTo?.(0, 0);
    const runSecs = countInDur + this.chart.total + 1;
    this._endTimer = setTimeout(() => this.stop(false), (runSecs + 0.4) * 1000);
  }

  stop(cancelled, why = 'stopped') {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this._endTimer);
    if (this.player) this.player.stop();
    this.mic.unlockDetector(this);
    wakeLock.release();
    if (this._lostHandler) this.mic.removeEventListener('lost', this._lostHandler);
    this._lostHandler = null;
    const go = this.root.querySelector('#rud-go');
    if (!cancelled) {
      for (const n of this.chart.notes) {
        if (n.state !== 'coming') continue;
        if (n._cluster && n._cluster.length) this.finalizeCluster(n); // a flam/drag hit at the very end
        else n.state = 'miss';
      }
      this.showSummary();
      const segs = this.chart.segments;
      const last = segs[segs.length - 1].bpm;
      this.renderSummaryStrip(last !== segs[0].bpm ? `${segs[0].bpm}–${last}` : segs[0].bpm);
      go.innerHTML = `PLAY AGAIN${icon('play')}`;
      this.setState('result');
      this.renderTitleSlot();
      const main = this.root.closest('main');
      if (main) main.scrollTop = 0;
    } else {
      this.stopInfo = { why, bar: this._bar, bars: this.barsUsed };
      this.renderStopped();
      this.resetLive();
      go.innerHTML = `PLAY${icon('play')}`;
      this.setState('stopped');
      this.renderTitleSlot();
      this.refreshNotation();
    }
    this.hw.draw(null);
  }

  deactivate() {
    if (this.running) this.stop(true, 'cancelled');
    // stop the highway animation loop when off-screen — otherwise it keeps
    // rescheduling every frame for the life of the page after the first visit
    cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  onHit(onset) {
    if (!this.running || !this.root.classList.contains('active')) return;
    const cal = (store.get('calibrationMs') || 0) / 1000;
    const t = onset.time - cal;
    if (t < this.chartStart - 0.2) return;
    const clicks = this.player.clicks;
    while (this._clickPtr + 1 < clicks.length
      && this.player.t0 + clicks[this._clickPtr + 1].offset < onset.time) this._clickPtr++;
    const nearClick = [this._clickPtr, this._clickPtr + 1].some((k) => {
      const c = clicks[k];
      return c && Math.abs(this.player.t0 + c.offset - onset.time) < 0.03 + Math.abs(cal);
    });
    if (this.bleed.shouldDrop(onset.level || 0, nearClick)) return;
    let best = null;
    let bestAbs = Infinity;
    let bestDev = 0;
    for (const n of this.chart.notes) {
      if (n.state !== 'coming') continue;
      const dev = (t - (this.chartStart + n.offset)) * 1000;
      if (Math.abs(dev) < bestAbs) { bestAbs = Math.abs(dev); bestDev = dev; best = n; }
      if (dev < -MATCH_WINDOW_MS) break;
    }
    // asymmetric window: half the gap to the previous note on the early side,
    // half the gap to the next note on the late side (each capped). Keeps the
    // window from collapsing on a note that sits after a big gap but before a
    // fast one — the phrase-leading downbeat of every roll.
    const earlyMs = matchWindowMs(best ? best.gapPrev : 0);
    const lateMs = matchWindowMs(best ? best.gapNext : 0);
    if (!best || bestDev < -earlyMs || bestDev > lateMs) { this.strays++; return; }
    if (best.grace > 0) {
      // Flam/drag: soft grace note(s) land just before the loud primary. Collect
      // the whole cluster and judge it once the late window closes (in tick),
      // taking the LOUDEST onset as the primary — so the graces aren't scored
      // as early hits or strays. (tick's finalizeCluster does the judging.)
      (best._cluster || (best._cluster = [])).push({ dev: bestDev, level: onset.level || 0 });
      return;
    }
    this.commitHit(best, bestDev, onset.level || 0);
  }

  // score one primary against the beat: grade, streak, monitor, per-stroke stat
  commitHit(note, dev, level) {
    const windows = this.judgeWindows || JUDGE_WINDOWS[store.get('judgeMode')] || JUDGE_WINDOWS.standard;
    const judge = judgeHit(dev, windows);
    note.state = judge === 'miss' ? 'miss' : `hit-${judge}`;
    note.devMs = dev;
    this.judged.push({ note, judge, devMs: dev, level });
    if (judge === 'perfect' || judge === 'good') {
      this.combo++;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
    } else {
      this.combo = 0;
    }
    this.recentDevs.push(dev);
    if (this.recentDevs.length > 8) this.recentDevs.shift();
    this.flashJudge(judge, dev);
  }

  // A flam/drag cluster is done (its late window has passed): the LOUDEST onset
  // is the primary; the soft ones were the graces. If the grace merged into a
  // single onset, add back a typical grace lead so a clean flam reads on-time.
  finalizeCluster(note) {
    const { dev, level } = clusterPrimaryDev(note._cluster, note.grace);
    this.commitHit(note, dev, level);
  }

  liveStats() {
    const devs = this.judged.filter((j) => j.judge !== 'miss').map((j) => j.devMs);
    const missed = this.chart ? this.chart.notes.filter((n) => n.state === 'miss').length : 0;
    return { devs, s: summarize(devs), hits: devs.length, seen: devs.length + missed };
  }

  // spread / avg / hits tiles, shared by matched hits and timed-out misses
  updateStats() {
    const $ = (sel) => this.root.querySelector(sel);
    const { s, hits, seen } = this.liveStats();
    const set = (id, html, empty) => {
      const b = $(id);
      b.innerHTML = html;
      b.parentElement.classList.toggle('is-empty', empty);
    };
    if (s && s.n >= 2) set('#rud-spread', `±${Math.round(s.sd)}<i class="unit">ms</i>`, false);
    else set('#rud-spread', '—', true);
    if (s) {
      set('#rud-avg', `${Math.abs(s.mean).toFixed(0)}<i class="unit">ms</i>`, false);
      const dir = dirWord(s.mean, 0);
      $('#rud-avg-label').textContent = dir ? `AVG ${dir.toUpperCase()}` : 'AVG';
      $('#rud-avg-sr').textContent = dir ? `Average ${dir}` : 'Average';
    }
    if (seen) set('#rud-acc', `${hits}<i class="unit">/${seen}</i>`, false);
    else set('#rud-acc', '—', true);
    const combo = $('#rud-combo');
    combo.classList.toggle('hidden', !this.showGradesRun);
    if (this.showGradesRun) combo.textContent = `streak ${this.combo}`;
  }

  flashJudge(judge, devMs) {
    const $ = (sel) => this.root.querySelector(sel);
    const mon = $('#rud-judge-chip');
    const num = $('#rud-judge-num');
    const cap = $('#rud-judge-cap');
    mon.classList.remove('is-idle');
    mon.classList.toggle('is-miss', judge === 'miss');
    if (judge === 'miss') {
      num.innerHTML = `${icon('cross')}<span class="sr-only">Missed</span>`;
      num.style.setProperty('--mon-fs', `${monitorSize('000')}px`);
      cap.innerHTML = '<span class="dir">MISSED</span>';
    } else {
      const text = fmtSigned(devMs, 0);
      num.textContent = text;
      num.style.setProperty('--mon-fs', `${monitorSize(text)}px`);
      // a hit that reads 0 is on the click: no EARLY / LATE beside it
      const word = dirWord(devMs, 0).toUpperCase();
      cap.innerHTML = `<span class="unit">ms</span>${word ? ` <span class="dir">${word}</span>` : ''}`;
    }
    $('#rud-judge-label').textContent = this.showGradesRun && judge !== 'miss'
      ? `LAST HIT · ${judge.toUpperCase()}` : 'LAST HIT';
    this.updateStats();
    this.renderStrip();
  }

  // ------------------------------------------------- early/late strip (8.2)
  renderStrip() {
    const host = this.root.querySelector('.rud-strip__plot');
    if (!host) return;
    const W = Math.max(240, Math.round(host.clientWidth || 330));
    const H = 58;
    const x0 = 14;
    const x1 = W - 14;
    const span = 60;
    const X = (ms) => x0 + ((Math.max(-span, Math.min(span, ms)) + span) / (2 * span)) * (x1 - x0);
    const y = 20;
    const win = this.running ? this.judgeWindows : (JUDGE_WINDOWS[store.get('judgeMode')] || JUDGE_WINDOWS.standard);
    const grades = this.running ? this.showGradesRun : !!store.get('showGrades');
    const p = [];
    const band = (ms, fill) => p.push(`<rect x="${X(-ms)}" y="${y - 10}" width="${X(ms) - X(-ms)}" height="20" fill="${fill}"/>`);
    if (grades) {
      band(win.ok, '#f3f3f2');
      band(win.good, '#ececeb');
      band(win.perfect, '#e3e3e2');
    } else {
      band(win.ok, 'var(--tint)');
      for (const e of [-win.ok, win.ok]) {
        p.push(`<line x1="${X(e)}" x2="${X(e)}" y1="${y - 10}" y2="${y + 10}" stroke="var(--ink)" stroke-opacity=".3" stroke-width="1"/>`);
      }
    }
    p.push(`<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="var(--ink)" stroke-width="2"/>`);
    for (let t = -span; t <= span; t += 20) {
      const zero = t === 0;
      p.push(`<line x1="${X(t)}" x2="${X(t)}" y1="${y - (zero ? 11 : 6)}" y2="${y + (zero ? 11 : 6)}" stroke="var(--ink)" stroke-width="${zero ? 3 : 1.5}"/>`);
      p.push(`<text x="${X(t)}" y="${y + 23}" text-anchor="middle" class="rud-strip__tick">${tickLabel(t)}</text>`);
    }
    if (grades) {
      // each tier name sits inside its own band, so narrow strict bands never collide
      const tier = (x, name) => p.push(`<text x="${x}" y="${y + 35}" text-anchor="middle" class="rud-strip__tier">${name}</text>`);
      tier(X(0), 'PERFECT');
      for (const sgn of [-1, 1]) {
        tier(X((sgn * (win.perfect + win.good)) / 2), 'GOOD');
        tier(X((sgn * (win.good + win.ok)) / 2), 'OK');
      }
    } else {
      p.push(`<text x="${W / 2}" y="${y + 35}" text-anchor="middle" class="rud-strip__tier">counted ±${nbsp(win.ok, 'ms')}</text>`);
    }
    const devs = this.recentDevs || [];
    const mark = (ms, r, fill, ring) => {
      if (Math.abs(ms) > span) { // clamped: an arrowhead on the edge
        const xe = ms < 0 ? x0 : x1;
        const d = ms < 0 ? -1 : 1;
        p.push(`<path d="M${xe + d * 7} ${y} L${xe - d * 3} ${y - 7} L${xe - d * 3} ${y + 7}z" fill="${fill}"/>`);
        return;
      }
      p.push(`<circle cx="${X(ms)}" cy="${y}" r="${r}" fill="${fill}"${ring ? ' stroke="#fff" stroke-width="2"' : ''}/>`);
    };
    devs.slice(0, -1).forEach((d) => mark(d, 4, 'var(--dot)', false));
    if (devs.length) mark(devs[devs.length - 1], 6.5, 'var(--ink)', true);
    const { s } = this.chart && this.running ? this.liveStats() : { s: null };
    if (s) {
      const xm = X(s.mean);
      p.push(`<path id="jb-needle" d="M${xm - 7} ${y - 20} h14 l-7 8z" fill="var(--ink)"/>`);
    } else {
      p.push('<path id="jb-needle" d="" fill="var(--ink)"/>');
    }
    const label = s
      ? `Early or late, last ${devs.length} hits. Average ${offsetText(s.mean, 1)}.`
      : 'Early or late strip, no hits yet.';
    host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">${p.join('')}</svg>`;
  }

  renderCountIn(pulses) {
    const dots = this.root.querySelector('.rud-countin .countin__dots');
    dots.innerHTML = '<i></i>'.repeat(pulses);
    dots.classList.toggle('is-wide', pulses > 6);
    this.root.querySelector('#rud-count').textContent = pulses;
  }

  loop() {
    this._raf = requestAnimationFrame(() => this.loop());
    if (!this.root.classList.contains('active')) return;
    this.tick();
  }

  // per-frame: time out unplayed notes, settle flam/drag clusters, drive the
  // count-in / bar label, then paint the highway
  tick() {
    if (!this.running) return;
    const now = this.mic.now();
    const cal = (store.get('calibrationMs') || 0) / 1000;
    for (const n of this.chart.notes) {
      if (n.state !== 'coming') continue;
      const past = now - cal - (this.chartStart + n.offset);
      const lateSec = matchWindowMs(n.gapNext) / 1000;
      // a flam/drag cluster: judge once its late window has closed AND the
      // detector has had time to deliver a late primary (it emits ~26 ms after
      // the hit) — otherwise a late primary would land after we'd already
      // scored the grace, reading falsely on-time plus a phantom stray.
      if (n._cluster && n._cluster.length && past > lateSec + CLUSTER_SETTLE_MS / 1000) {
        this.finalizeCluster(n);
        continue;
      }
      if (past > lateSec + MISS_SLACK_MS / 1000) {
        n.state = 'miss';
        this.combo = 0;
        this.updateStats(); // a timed-out miss must reset the visible streak too
      }
    }

    if (now < this.chartStart) {
      // clamp: the 0.2 s player start delay is inside chartStart - now, which
      // otherwise flashes "5" before a 4-beat count-in (or "6" at 300+ BPM)
      const pulses = this.grooveUsed.meter.pulses;
      const left = Math.min(pulses, Math.ceil((this.chartStart - now) / (this.countInDur / pulses)));
      if (left !== this._countLeft) {
        this._countLeft = left;
        this.root.querySelector('#rud-count').textContent = left;
        const dots = this.root.querySelectorAll('.rud-countin .countin__dots i');
        dots.forEach((d, k) => d.classList.toggle('on', k < pulses - left + 1));
        announce(String(left));
      }
    } else {
      const rel = now - this.chartStart;
      let bar = 0;
      for (const off of this.chart.barOffsets) { if (off <= rel + 1e-9) bar++; else break; }
      bar = Math.max(1, Math.min(this.barsUsed, bar));
      if (bar !== this._bar) {
        this._bar = bar;
        this.setState('running', `LIVE · BAR ${bar} OF ${this.barsUsed}`);
        const seg0 = segmentAt(this.chart.segments, this.chart.barOffsets[bar - 1]);
        this.renderSummaryStrip(seg0.bpm);
        const { s } = this.liveStats();
        announce(s && s.n >= 2
          ? `Bar ${bar}. Spread ${nbsp(Math.round(s.sd), 'ms')}. Average ${offsetText(s.mean, 0)}.`
          : `Bar ${bar}.`);
      }
    }

    this.hw.draw({
      t: now,
      pxPerSec: this.pxPerSec,
      notes: this.hwNotes,
      beats: this.hwBeats,
      showGrades: this.showGradesRun,
    });
  }

  // ----------------------------------------------------------- result (5.9)
  showSummary() {
    const el = this.root.querySelector('#rud-summary');
    const devs = this.judged.filter((j) => j.judge !== 'miss').map((j) => j.devMs);
    const missed = this.chart.notes.filter((n) => n.state === 'miss').length;
    const s = summarize(devs);
    if (!s) {
      el.innerHTML = '<div class="card rud-note"><p class="t-body">No hits heard. Check the mic meter, then try a slower tempo.</p></div>';
      return;
    }

    const rud = this.rudiment;
    const perPhrase = rud.notes.length;
    const handAt = (p) => (this.lead === 'L' ? swapLead(rud.notes[p].hand) : rud.notes[p].hand);

    // per-position: which stroke of the phrase rushes/drags?
    const strokes = [];
    for (let p = 0; p < perPhrase; p++) {
      const sd = this.judged
        .filter((j) => j.judge !== 'miss' && j.note.phrasePos === p)
        .map((j) => j.devMs);
      const ss = summarize(sd);
      if (ss && ss.n >= 3) strokes.push({ name: `${handAt(p)}${p + 1}`, hand: handAt(p), mean: ss.mean, sd: ss.sd });
    }

    let accentRow = '';
    const accHits = this.judged.filter((j) => j.judge !== 'miss' && j.note.accent && j.level > 0);
    const tapHits = this.judged.filter((j) => j.judge !== 'miss' && !j.note.accent && j.level > 0);
    if (accHits.length >= 3 && tapHits.length >= 3) {
      const med = (arr) => {
        const sorted = arr.map((j) => j.level).sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
      };
      const db = 20 * Math.log10(med(accHits) / Math.max(med(tapHits), 1e-9));
      const silent = accHits.filter((j) => j.level < med(tapHits)).length;
      accentRow = `<p class="rud-accents"><b>ACCENTS</b> ${nbsp(fmtSigned(db, 1), 'dB')} over taps${silent ? ` · ${silent} no louder` : ''}</p>`;
      this._accentDb = +db.toFixed(1);
    } else {
      this._accentDb = null;
    }

    const segs = this.chart.segments;
    const perTempo = [];
    for (const sg of segs) {
      const segDevs = this.judged
        .filter((j) => j.judge !== 'miss' && segmentAt(segs, j.note.offset).bpm === sg.bpm)
        .map((j) => j.devMs);
      const segMiss = this.chart.notes
        .filter((n) => n.state === 'miss' && segmentAt(segs, n.offset).bpm === sg.bpm).length;
      const ss = summarize(segDevs);
      if (ss) perTempo.push({ bpm: sg.bpm, sd: ss.sd, missed: segMiss });
    }

    const cal = store.get('calibrationMs');
    let offsetHint = '';
    if (s.n >= 8 && Math.abs(s.mean) > 25 && s.sd < Math.abs(s.mean)) {
      const tail = cal === null ? 'Likely phone lag.' : 'If the phone moved, recalibrate.';
      offsetHint = `<div class="card rud-note"><p class="t-body">Hits sit ${offsetText(s.mean, 1)} as a group. ${tail}</p>
        <button type="button" class="btn btn--quiet rud-cal">CALIBRATE${icon('tri-right')}</button></div>`;
    }
    const bleedNote = this.bleed.warning();

    // fact line inputs
    const barOf = (offset) => {
      let b = 0;
      for (const off of this.chart.barOffsets) { if (off <= offset + 1e-9) b++; else break; }
      return Math.max(1, b);
    };
    const missBars = this.chart.notes.filter((n) => n.state === 'miss').map((n) => barOf(n.offset));
    let missedBars = null;
    if (missBars.length) {
      // the shortest run of bars holding at least half the misses
      const counts = new Array(this.barsUsed + 2).fill(0);
      missBars.forEach((b) => { counts[b]++; });
      const need = Math.ceil(missBars.length / 2);
      let bestLen = Infinity;
      for (let a = 1; a <= this.barsUsed; a++) {
        let sum = 0;
        for (let b = a; b <= this.barsUsed; b++) {
          sum += counts[b];
          if (sum >= need) {
            if (b - a < bestLen) { bestLen = b - a; missedBars = [a, b]; }
            break;
          }
        }
      }
      if (missedBars && missedBars[1] - missedBars[0] + 1 > this.barsUsed / 2) missedBars = null;
    }
    const first = perTempo[0];
    const lastT = perTempo[perTempo.length - 1];
    const windowMs = this.judgeWindows.perfect;
    const fact = factLine('rudiments', {
      notes: this.chart.notes.length,
      missed,
      missedBars,
      mean: s.mean,
      sd: s.sd,
      calibrationMs: cal,
      strokes: strokes.map((k) => ({ name: k.name, mean: k.mean })),
      ramp: perTempo.length > 1 ? { sdFrom: first.sd, bpmFrom: first.bpm, sdTo: lastT.sd, bpmTo: lastT.bpm } : null,
      hits: s.n,
      within: devs.filter((d) => Math.abs(d) <= windowMs).length,
      windowMs,
    });

    // BY STROKE: dot = avg, bar = ±spread, on a symmetric ms axis
    let byStroke;
    if (strokes.length) {
      const reach = Math.max(...strokes.map((k) => Math.abs(k.mean) + k.sd));
      const R = Math.min(60, Math.max(20, Math.ceil(reach / 10) * 10));
      const P = (ms) => (((Math.max(-R, Math.min(R, ms)) + R) / (2 * R)) * 100).toFixed(2);
      const ticks = [-R, -R / 2, 0, R / 2, R];
      const grid = ticks.map((t) => `<i class="${t === 0 ? 'bs-zero' : 'bs-grid'}" style="left:${P(t)}%"></i>`).join('');
      const rows = strokes.map((k) => {
        const dir = dirWord(k.mean, 1);
        const val = dir ? `${one(k.mean)} ${dir}` : one(k.mean);
        const lo = P(k.mean - k.sd);
        const hi = P(k.mean + k.sd);
        const hand = k.hand === 'R' ? 'r' : 'l';
        return `<div class="bs-row" role="row">
          <span class="bs-name" role="rowheader"><i class="bs-sw ${hand}"></i>${k.name}</span>
          <span class="bs-plot" aria-hidden="true">${grid}<i class="bs-bar" style="left:${lo}%;width:${(hi - lo).toFixed(2)}%"></i><i class="bs-dot ${hand}" style="left:${P(k.mean)}%"></i></span>
          <span class="bs-val" role="cell">${val}</span>
        </div>`;
      }).join('');
      byStroke = `
        <div class="bs-rows" role="table" aria-label="Average offset by stroke">${rows}</div>
        <div class="bs-axis" aria-hidden="true"><span class="bs-axis__plot">${ticks.map((t) => `<span style="left:${P(t)}%">${tickLabel(t)}</span>`).join('')}</span><span class="bs-axis__unit">ms</span></div>
        <div class="bs-dirs" aria-hidden="true"><span>${icon('tri-left')}EARLY</span><span>LATE${icon('tri-right')}</span></div>`;
    } else {
      byStroke = '<p class="t-body">Not enough hits per stroke.</p>';
    }

    const byTempo = perTempo.length > 1
      ? `<section class="card rud-bytempo">
          <div class="sec-head"><h2 class="sec-head__stamp">SPREAD BY TEMPO</h2></div>
          <ul>${perTempo.map((r) => `<li>${nbsp(r.bpm, 'BPM')} · ±${nbsp(one(r.sd), 'ms')}${r.missed ? ` · ${r.missed} missed` : ''}</li>`).join('')}</ul>
        </section>`
      : '';

    const sdText = one(s.sd);
    const foot = [`${this.strays} extra hits not counted`];
    if (cal !== null) foot.push(`latency ${nbsp(fmtSigned(-cal, 0), 'ms')} applied`);

    el.innerHTML = `
      <div class="hero rud-hero">
        <p class="hero__cap">SPREAD · ${this.barsUsed} BARS · ${s.n} HITS</p>
        <p class="rud-hero__num"><b><span aria-hidden="true">±${sdText}</span><span class="sr-only">plus or minus ${sdText}</span></b><span class="unit">ms</span></p>
        <p class="hero__def">How tightly the hits group.</p>
        <p class="hero__avg"><span aria-hidden="true">AVG</span><span class="sr-only">Average</span> ${offsetText(s.mean, 1, { upper: true })}</p>
      </div>
      <p class="fact" role="status">${fact}</p>
      <div class="stat-strip">
        <div class="statbox"><b>${s.n}</b><span>HITS</span></div>
        <div class="statbox"><b>${missed}</b><span>MISSED</span></div>
        <div class="statbox"><b>${this.strays}</b><span>EXTRA HITS</span><em>not counted</em></div>
      </div>
      ${accentRow}
      <section class="card rud-bystroke" aria-labelledby="rud-bs-head">
        <div class="sec-head"><h2 class="sec-head__stamp" id="rud-bs-head">BY STROKE</h2><span class="sec-head__aside">dot = avg · bar = ±spread</span></div>
        ${byStroke}
      </section>
      ${byTempo}
      ${offsetHint}
      ${bleedNote ? `<div class="card rud-note"><p class="t-body">${bleedNote}</p></div>` : ''}
      <p class="rud-foot">${foot.join(' · ')}</p>`;
    const calBtn = el.querySelector('.rud-cal');
    if (calBtn) calBtn.addEventListener('click', () => { if (!this.running) this.nav('calibrate'); });
    announce(`Run done. Spread ${nbsp(sdText, 'ms')}. Average ${offsetText(s.mean, 1)}.`);

    store.addRun({
      kind: 'rudiment',
      label: `${rud.name} (${this.lead}-lead)`,
      accentDb: this._accentDb,
      meter: `${this.grooveUsed.meter.label} ${this.grooveUsed.grouping}`,
      bpmStart: segs[0].bpm,
      bpmEnd: segs[segs.length - 1].bpm,
      n: s.n,
      mean: +s.mean.toFixed(2),
      sd: +s.sd.toFixed(2),
      missed,
      strays: this.strays,
      accuracy: +((100 * s.n) / (s.n + missed)).toFixed(1),
    });
    this.saved = true;
  }
}
