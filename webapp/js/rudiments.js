// Rudiment trainer — the hero screen. A horizontal scroll strip: R/L pucks
// ride right-to-left past a fixed NOW read-head and are judged live as they
// cross it. Now drives all 40 PAS/Vic Firth essential rudiments from
// rudiment-data.js: sparse rhythms, flams, drags, buzz rolls, odd counts.
// The mic hears WHEN, not WHICH HAND — sticking letters are guidance, and
// grace notes (flams/drags) render for feel but are scored at their primary.

import { ChartPlayer } from './metronome.js';
import { METERS, meterById, defaultGrouping, accentsFor, segmentAt, unitGlyph, TapTempo } from './meter.js';
import { RUDIMENTS, CATEGORIES, rudimentById } from './rudiment-data.js';
import { BleedGuard, judgeHit, JUDGE_WINDOWS, summarize } from './dsp.js';
import { store } from './store.js';
import { theme } from './theme.js';
import { wakeLock } from './audio.js';

export { RUDIMENTS };

export const RAMPS = [
  { id: 'off', label: 'steady', ramp: null },
  { id: 'r5x4', label: '+5 / 4 bars', ramp: { addBpm: 5, everyBars: 4 } },
  { id: 'r10x4', label: '+10 / 4 bars', ramp: { addBpm: 10, everyBars: 4 } },
  { id: 'r5x8', label: '+5 / 8 bars', ramp: { addBpm: 5, everyBars: 8 } },
];

// Accent modes apply only to the editable pure patterns (accent studies);
// standard rudiments carry their own intrinsic accents.
export const ACCENT_MODES = [
  { id: 'pattern', label: 'built-in' },
  { id: 'pulses', label: 'pulses' },
  { id: 'none', label: 'none' },
  { id: 'custom', label: 'custom' },
];

const MATCH_WINDOW_MS = 90;   // absolute accept cap (slow tempos)
const MISS_SLACK_MS = 55;     // grace past the accept window before a miss
const GRACE_GAP_S = 0.045;    // visual lead of a flam/drag grace before its primary
const BARS_CYCLE = [8, 16, 32, 64];

// Half the local note spacing: every hit maps to its NEAREST note, so there
// is no dead zone between notes, capped so a slow tempo can't accept a wild
// hit. Used by both the accept test and the miss deadline.
export function matchWindowMs(stepSec) {
  return Math.min(MATCH_WINDOW_MS, 0.5 * stepSec * 1000);
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
  if (!rud.editable) return note.accent; // intrinsic
  switch (accent.mode) {
    case 'none': return false;
    case 'pulses': return note.slot % rud.grid === 0;
    case 'custom': return accent.custom.includes(note.phrasePos);
    default: return note.accent; // 'pattern' = built-in
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

  const totalPulses = pulseStart.length;
  const phraseCount = Math.floor(totalPulses / rud.beats);
  const notes = [];
  let idx = 0;
  for (let ph = 0; ph < phraseCount; ph++) {
    for (let k = 0; k < rud.notes.length; k++) {
      const nd = rud.notes[k];
      const gp = ph * rud.beats + Math.floor(nd.slot / rud.grid);
      if (gp >= totalPulses) continue;
      const sub = nd.slot % rud.grid;
      const offset = pulseStart[gp] + (sub * pulseDur[gp]) / rud.grid;
      let hand = nd.hand;
      if (lead === 'L') hand = swapLead(hand);
      const note = {
        index: idx++,
        phrasePos: k,
        slot: nd.slot,
        offset,
        stick: hand,
        accent: false, // filled below (needs the note object for editable modes)
        grace: nd.grace,
        buzz: nd.buzz,
        graceTimes: [],
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
    notes[i].step = i + 1 < notes.length
      ? notes[i + 1].offset - notes[i].offset
      : (notes[i].offset - (notes[i - 1] ? notes[i - 1].offset : notes[i].offset)) || 0.2;
  }
  return { notes, clicks, barOffsets, segments, total };
}

export class RudimentsMode {
  constructor(root, mic) {
    this.root = root;
    this.mic = mic;
    this.running = false;
    this.lead = 'R';
    this.bars = 16;
    this.rampId = 'off';
    this.accentMode = 'pattern';
    this.customAccents = new Set();
    this.expand = null;
    this.rudimentId = 'single-paradiddle';
    const saved = store.get('grooveRud');
    this.bpm = (saved && saved.bpm) || store.get('preferredBpm') || 120;
    this.meterId = (saved && saved.meterId) || '4/4';
    this.grouping = (saved && saved.grouping) || defaultGrouping(meterById('4/4'));
    this.tap = new TapTempo();
    this.recentDevs = [];
    this._raf = null;
    this.render();
    mic.addEventListener('onset', (e) => this.onHit(e.detail));
  }

  activate() {
    this.mic.setDetectorOptions({ refractory: 0.03, threshold: 4, minLevel: 0.01 });
    if (!this._raf) this.loop();
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

  render() {
    const rud = this.currentRudiment();
    const meter = meterById(this.meterId);
    const groupings = Object.keys(meter.groupings);
    this.root.innerHTML = `
      <div class="title-stamp" style="font-size:36px">RUDIMENTS</div>

      <div class="rud-controls">
        <div class="rud-picker">
          <select id="rud-pattern" aria-label="rudiment">
            ${CATEGORIES.map((c) => `<optgroup label="${c.label}">
              ${RUDIMENTS.filter((r) => r.cat === c.id).map((r) => `<option value="${r.id}" ${r.id === rud.id ? 'selected' : ''}>${r.num}. ${r.name}</option>`).join('')}
            </optgroup>`).join('')}
          </select>
        </div>
        <div class="param-grid">
          <div class="param"><div class="param-cap">LEAD</div><button id="rud-lead" class="param-box">${this.lead}</button></div>
          <div class="param"><div class="param-cap">BARS</div><button id="rud-bars" class="param-box">${this.bars}</button></div>
          <div class="param"><div class="param-cap">TEMPO</div><button id="rud-tempo-chip" class="param-box ${this.expand === 'tempo' ? 'open' : ''}">${this.bpm}</button></div>
          <div class="param"><div class="param-cap">METER</div><button id="rud-meter-chip" class="param-box ${this.expand === 'meter' ? 'open' : ''}">${meter.label}</button></div>
        </div>
        ${this.expand === 'tempo' ? `
          <div class="expand-row">
            <button class="pill" data-bpm="-5">&#8722;5</button>
            <button class="pill" data-bpm="-1">&#8722;1</button>
            <button class="pill" data-bpm="1">+1</button>
            <button class="pill" data-bpm="5">+5</button>
            <button class="pill" id="rud-tap">TAP</button>
            <span class="expand-sep"></span>
            ${RAMPS.map((r) => `<button class="pill ${this.rampId === r.id ? 'on' : ''}" data-ramp="${r.id}">${r.label}</button>`).join('')}
          </div>` : ''}
        ${this.expand === 'meter' ? `
          <div class="expand-row">
            ${METERS.map((m) => `<button class="pill ${m.id === this.meterId ? 'on' : ''}" data-meter="${m.id}">${m.label}</button>`).join('')}
            ${groupings.length > 1 ? `<span class="expand-sep"></span>
              ${groupings.map((g) => `<button class="pill ${g === this.grouping ? 'on' : ''}" data-grouping="${g}">${g}</button>`).join('')}` : ''}
          </div>` : ''}
        ${rud.editable ? `
          <div class="expand-row accents-row">
            <span class="param-cap" style="margin:0 4px 0 0">ACCENTS</span>
            ${ACCENT_MODES.map((m) => `<button class="pill ${m.id === this.accentMode ? 'on' : ''}" data-am="${m.id}">${m.label}</button>`).join('')}
          </div>
          <div id="rud-accent-editor" class="accent-editor"></div>`
    : `<div class="rud-sticking">${this.stickingLine(rud)}</div>`}
      </div>

      <div class="highway-panel">
        <div class="hw-hatch"></div>
        <div class="hw-now"></div>
        <canvas id="rud-highway" width="900" height="330"></canvas>
        <div class="hw-frost"></div>
      </div>

      <div class="judge-bar">
        <div class="jb-gauge">
          <div class="jb-labels"><span>&#9668; EARLY</span><span class="mid">0</span><span>LATE &#9658;</span></div>
          <div class="jb-track">
            <div class="jb-center"></div>
            <div id="jb-needle" class="jb-needle"><div class="tri-up"></div></div>
          </div>
          <div class="jb-zones"><span>OK</span><span class="g">GOOD</span><span class="p">PERFECT</span><span class="g">GOOD</span><span>OK</span></div>
        </div>
        <div id="rud-judge-chip" class="judge-chip idle">
          <div class="jc-num" id="rud-judge-num">&mdash;</div>
          <div class="jc-cap" id="rud-judge-cap">WAITING</div>
        </div>
      </div>

      <div class="rud-bottom">
        <div class="statbox"><b id="rud-combo">0</b><span>Streak</span></div>
        <div class="statbox"><b id="rud-acc">&mdash;</b><span>Accuracy</span></div>
        <button id="rud-go" class="btn red rud-play">PLAY<span class="tri"></span></button>
      </div>
      <div id="rud-summary" class="rud-summary hidden"></div>`;

    this.root.querySelector('#rud-pattern').addEventListener('change', (e) => {
      this.rudimentId = e.target.value;
      this.customAccents.clear();
      this.render();
    });
    this.root.querySelector('#rud-lead').addEventListener('click', (e) => {
      this.lead = this.lead === 'R' ? 'L' : 'R';
      e.currentTarget.textContent = this.lead;
      if (this.currentRudiment().editable) this.renderAccentEditor();
      else this.render();
    });
    this.root.querySelector('#rud-bars').addEventListener('click', (e) => {
      this.bars = BARS_CYCLE[(BARS_CYCLE.indexOf(this.bars) + 1) % BARS_CYCLE.length];
      e.currentTarget.textContent = this.bars;
    });
    this.root.querySelector('#rud-tempo-chip').addEventListener('click', () => {
      this.expand = this.expand === 'tempo' ? null : 'tempo';
      this.render();
    });
    this.root.querySelector('#rud-meter-chip').addEventListener('click', () => {
      this.expand = this.expand === 'meter' ? null : 'meter';
      this.render();
    });
    this.root.querySelectorAll('[data-bpm]').forEach((b) => {
      b.addEventListener('click', () => {
        this.bpm = Math.max(20, Math.min(400, this.bpm + +b.dataset.bpm));
        this.saveGroove();
        this.root.querySelector('#rud-tempo-chip').textContent = this.bpm;
      });
    });
    const tapBtn = this.root.querySelector('#rud-tap');
    if (tapBtn) tapBtn.addEventListener('click', () => {
      const bpm = this.tap.tap(this.mic.now());
      if (bpm) {
        this.bpm = Math.max(20, Math.min(400, Math.round(bpm)));
        this.saveGroove();
        this.root.querySelector('#rud-tempo-chip').textContent = this.bpm;
      }
    });
    this.root.querySelectorAll('[data-ramp]').forEach((b) => {
      b.addEventListener('click', () => {
        this.rampId = b.dataset.ramp;
        this.root.querySelectorAll('[data-ramp]').forEach((x) => x.classList.toggle('on', x === b));
      });
    });
    this.root.querySelectorAll('[data-meter]').forEach((b) => {
      b.addEventListener('click', () => {
        this.meterId = b.dataset.meter;
        this.grouping = defaultGrouping(meterById(this.meterId));
        this.saveGroove();
        this.render();
        this.expand = 'meter';
      });
    });
    this.root.querySelectorAll('[data-grouping]').forEach((b) => {
      b.addEventListener('click', () => {
        this.grouping = b.dataset.grouping;
        this.saveGroove();
        this.root.querySelectorAll('[data-grouping]').forEach((x) => x.classList.toggle('on', x === b));
      });
    });
    this.root.querySelectorAll('[data-am]').forEach((b) => {
      b.addEventListener('click', () => this.setAccentMode(b.dataset.am));
    });
    this.root.querySelector('#rud-go').addEventListener('click', () => this.toggle());
    if (rud.editable) this.renderAccentEditor();
  }

  currentRudiment() {
    return rudimentById(this.rudimentId);
  }

  // one-line sticking readout for non-editable rudiments (flams/drags marked)
  stickingLine(rud) {
    return rud.notes.map((n) => {
      let g = '';
      if (n.grace === 1) g = '<i class="gr">fl</i>';
      else if (n.grace === 2) g = '<i class="gr">dr</i>';
      else if (n.buzz) g = '<i class="gr">bz</i>';
      const cls = `stk ${n.hand === 'R' ? 'r' : 'l'}${n.accent ? ' acc' : ''}`;
      return `<span class="${cls}">${g}${n.hand}</span>`;
    }).join('');
  }

  accentValue() {
    return { mode: this.accentMode, custom: [...this.customAccents] };
  }

  setAccentMode(mode) {
    this.accentMode = mode;
    if (mode === 'custom' && this.customAccents.size === 0) {
      const rud = this.currentRudiment();
      rud.notes.forEach((n, i) => { if (n.accent) this.customAccents.add(i); });
    }
    this.root.querySelectorAll('[data-am]')
      .forEach((b) => b.classList.toggle('on', b.dataset.am === mode));
    this.renderAccentEditor();
  }

  renderAccentEditor() {
    const el = this.root.querySelector('#rud-accent-editor');
    if (!el) return;
    const rud = this.currentRudiment();
    const accent = this.accentValue();
    const pucks = rud.notes.map((n, i) => {
      let hand = n.hand;
      if (this.lead === 'L') hand = swapLead(hand);
      const on = accentForNote(rud, accent, { ...n, phrasePos: i });
      return `<button class="accent-puck ${hand === 'R' ? 'r' : 'l'} ${on ? 'on' : ''} ${n.slot % rud.grid === 0 ? 'pulse-start' : ''}"
        data-step="${i}" aria-pressed="${on}">${hand}</button>`;
    });
    el.innerHTML = pucks.join('')
      + '<span class="accent-note">tap notes to place accents</span>';
    el.querySelectorAll('.accent-puck').forEach((p) => {
      p.addEventListener('click', () => {
        const step = +p.dataset.step;
        if (this.accentMode !== 'custom') {
          this.customAccents = new Set();
          rud.notes.forEach((n, i) => { if (accentForNote(rud, this.accentValue(), { ...n, phrasePos: i })) this.customAccents.add(i); });
          this.accentMode = 'custom';
          this.root.querySelectorAll('[data-am]')
            .forEach((b) => b.classList.toggle('on', b.dataset.am === 'custom'));
        }
        if (this.customAccents.has(step)) this.customAccents.delete(step);
        else this.customAccents.add(step);
        this.renderAccentEditor();
      });
    });
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
    this.saveGroove();

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

    this.combo = 0;
    this.bestCombo = 0;
    this.strays = 0;
    this.judged = [];
    this.recentDevs = [];
    this.bleed = new BleedGuard();
    this._clickPtr = 0;
    this.root.querySelector('#rud-summary').classList.add('hidden');
    this.running = true;
    this.mic.lockDetector(this, { refractory: 0.03, threshold: 4, minLevel: 0.01 });
    wakeLock.acquire();
    this._lostHandler = () => {
      this.stop(true);
      const el = this.root.querySelector('#rud-summary');
      el.classList.remove('hidden');
      el.textContent = 'run invalidated: microphone lost — reconnect and play it again.';
    };
    this.mic.addEventListener('lost', this._lostHandler);
    this.root.querySelector('#rud-go').innerHTML = 'STOP';
    const runSecs = countInDur + this.chart.total + 1;
    this._endTimer = setTimeout(() => this.stop(false), (runSecs + 0.4) * 1000);
  }

  stop(cancelled) {
    this.running = false;
    clearTimeout(this._endTimer);
    if (this.player) this.player.stop();
    this.mic.unlockDetector(this);
    wakeLock.release();
    if (this._lostHandler) this.mic.removeEventListener('lost', this._lostHandler);
    const go = this.root.querySelector('#rud-go');
    if (go) go.innerHTML = 'PLAY<span class="tri"></span>';
    if (!cancelled) {
      for (const n of this.chart.notes) if (n.state === 'coming') n.state = 'miss';
      this.showSummary();
    }
  }

  deactivate() {
    if (this.running) {
      this.stop(true);
      const el = this.root.querySelector('#rud-summary');
      el.classList.remove('hidden');
      el.textContent = 'run cancelled — you left the Rudiments tab mid-run.';
    }
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
    for (const n of this.chart.notes) {
      if (n.state !== 'coming') continue;
      const dev = (t - (this.chartStart + n.offset)) * 1000;
      if (Math.abs(dev) < bestAbs) { bestAbs = Math.abs(dev); best = n; }
      if (dev < -MATCH_WINDOW_MS) break;
    }
    const winMs = matchWindowMs(best ? best.step : 1);
    if (!best || bestAbs > winMs) { this.strays++; return; }
    const windows = JUDGE_WINDOWS[store.get('judgeMode')] || JUDGE_WINDOWS.standard;
    const dev = (t - (this.chartStart + best.offset)) * 1000;
    const judge = judgeHit(dev, windows);
    best.state = judge === 'miss' ? 'miss' : `hit-${judge}`;
    best.devMs = dev;
    this.judged.push({ note: best, judge, devMs: dev, level: onset.level || 0 });
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

  flashJudge(judge, devMs) {
    const chip = this.root.querySelector('#rud-judge-chip');
    const num = this.root.querySelector('#rud-judge-num');
    const cap = this.root.querySelector('#rud-judge-cap');
    num.textContent = judge === 'miss' ? '✗' : `${devMs >= 0 ? '+' : ''}${devMs.toFixed(0)}`;
    cap.textContent = judge === 'miss' ? 'MISS' : `${judge.toUpperCase()}·MS`;
    chip.className = `judge-chip ${judge}`;
    this.root.querySelector('#rud-combo').textContent = String(this.combo);
    const hits = this.judged.filter((j) => j.judge !== 'miss').length;
    const seen = hits + this.chart.notes.filter((n) => n.state === 'miss').length;
    if (seen) this.root.querySelector('#rud-acc').textContent = `${((100 * hits) / seen).toFixed(0)}%`;
    const mean = this.recentDevs.reduce((a, b) => a + b, 0) / this.recentDevs.length;
    const needle = this.root.querySelector('#jb-needle');
    if (needle) needle.style.left = `${50 + Math.max(-42, Math.min(42, (mean / 60) * 42))}%`;
  }

  loop() {
    this._raf = requestAnimationFrame(() => this.loop());
    if (!this.root.classList.contains('active')) return;
    this.draw();
  }

  draw() {
    const cv = this.root.querySelector('#rud-highway');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const w = cv.width;
    const h = cv.height;
    ctx.clearRect(0, 0, w, h);
    const T = theme();
    const nowX = 0.42 * w;
    // Adaptive horizontal zoom. Dense rudiments (sextuplet rolls, drags) pack
    // their notes tightly; at a fixed scale the pucks would overlap into an
    // unreadable smear. Zoom so the TIGHTEST gap in this chart stays legible,
    // without flying by so fast you can't read ahead.
    const steps = this.chart ? this.chart.notes.map((n) => n.step).filter((s) => s > 0) : [];
    const minStep = steps.length ? Math.min(...steps) : 0.2;
    const pxPerSec = highwayPxPerSec(minStep);

    if (!this.running) {
      ctx.textAlign = 'center';
      ctx.fillStyle = T.ink;
      ctx.font = "68px 'Anton', system-ui";
      ctx.fillText('LOAD IN', w / 2, h / 2 - 8);
      ctx.fillStyle = T.dim;
      ctx.font = "22px 'Space Mono', monospace";
      ctx.fillText('dial it in above · hit PLAY · one bar of count-in', w / 2, h / 2 + 34);
      return;
    }
    const now = this.mic.now();
    const cal = (store.get('calibrationMs') || 0) / 1000;
    for (const n of this.chart.notes) {
      if (n.state !== 'coming') continue;
      const deadline = matchWindowMs(n.step) / 1000 + MISS_SLACK_MS / 1000;
      if (now - cal - (this.chartStart + n.offset) > deadline) {
        n.state = 'miss';
        this.combo = 0;
      }
    }
    const rel = now - this.chartStart;
    const seg = rel >= 0 ? segmentAt(this.chart.segments, rel) : this.chart.segments[0];
    const chipEl = this.root.querySelector('#rud-tempo-chip');
    if (chipEl && this.running) chipEl.textContent = seg.bpm;

    const xOf = (tt) => nowX + (tt - now) * pxPerSec;
    const midY = h / 2;

    // beat grid: a line on EVERY pulse so the beat is always visible, with the
    // downbeat (bar start) emphasized in red. The on-beat notes ride these
    // lines, and each line falls exactly when its click sounds — so you can
    // both see and hear where the beat is.
    for (const c of this.chart.clicks) {
      const x = xOf(this.chartStart + c.offset);
      if (x < -4 || x > w + 4) continue;
      ctx.strokeStyle = c.accent ? 'rgba(224,48,30,.55)' : 'rgba(20,18,16,.3)';
      ctx.lineWidth = c.accent ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(x, h * (c.accent ? 0.1 : 0.18));
      ctx.lineTo(x, h * (c.accent ? 0.9 : 0.82));
      ctx.stroke();
    }

    for (const n of this.chart.notes) {
      const x = xOf(this.chartStart + n.offset);
      if (x < -70 || x > w + 70) continue;
      // radius rides the local spacing: full-size when notes are far apart,
      // tucked down to fit when they're tight (sextuplets, drags) so two pucks
      // never overlap — 0.46 of the gap each leaves a hair of daylight between.
      const rad = puckRadius(n.step, pxPerSec, n.accent);
      const isR = n.stick === 'R';
      const base = isR ? T.pink : T.blue;
      // grace notes (flam/drag) — small, above and just before the primary
      const graceR = Math.max(6, rad * 0.4);
      for (const gt of n.graceTimes) {
        const gx = xOf(this.chartStart + gt);
        ctx.globalAlpha = n.state === 'miss' ? 0.3 : 0.85;
        ctx.fillStyle = base;
        ctx.beginPath();
        ctx.arc(gx, midY - rad - graceR - 2, graceR, 0, 7);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = T.ink;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      let ring = null;
      let alpha = 1;
      if (n.state === 'hit-perfect' || n.state === 'hit-good') ring = T.green;
      else if (n.state === 'hit-ok') ring = '#b5891f';
      else if (n.state === 'miss') alpha = 0.35;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = base;
      ctx.beginPath();
      ctx.arc(x, midY, rad, 0, 7);
      ctx.fill();
      ctx.lineWidth = Math.max(2.5, rad * 0.16);
      ctx.strokeStyle = T.ink;
      ctx.stroke();
      if (n.accent) {
        ctx.beginPath();
        ctx.arc(x, midY, rad + 5, 0, 7);
        ctx.lineWidth = 4;
        ctx.strokeStyle = T.ink;
        ctx.stroke();
      }
      if (n.buzz) { // multiple-bounce: dashed halo
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(x, midY, rad + 8, 0, 7);
        ctx.lineWidth = 3;
        ctx.strokeStyle = T.ink;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (ring) {
        ctx.beginPath();
        ctx.arc(x, midY, rad + (n.accent ? 10 : 7), 0, 7);
        ctx.lineWidth = 4;
        ctx.strokeStyle = ring;
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.round(rad * 1.5)}px 'Anton', system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText(n.stick, x, midY + rad * 0.55);
      if (n.state === 'miss') {
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = T.pink;
        ctx.lineWidth = Math.max(3, rad * 0.18);
        const d = rad - 4;
        ctx.beginPath();
        ctx.moveTo(x - d, midY - d);
        ctx.lineTo(x + d, midY + d);
        ctx.moveTo(x + d, midY - d);
        ctx.lineTo(x - d, midY + d);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    if (now < this.chartStart) {
      const pulsesLeft = Math.ceil((this.chartStart - now) / (this.countInDur / this.grooveUsed.meter.pulses));
      ctx.fillStyle = T.ink;
      ctx.font = "110px 'Anton', system-ui";
      ctx.textAlign = 'center';
      ctx.fillText(String(pulsesLeft), w / 2, midY + 38);
    }
  }

  showSummary() {
    const el = this.root.querySelector('#rud-summary');
    el.classList.remove('hidden');
    const devs = this.judged.filter((j) => j.judge !== 'miss').map((j) => j.devMs);
    const missed = this.chart.notes.filter((n) => n.state === 'miss').length;
    const s = summarize(devs);
    if (!s) { el.textContent = 'No notes hit. Check the mic meter, then try a slower tempo.'; return; }

    const rud = this.rudiment;
    const glyph = unitGlyph(this.grooveUsed.meter);
    const perPhrase = rud.notes.length;

    // per-position: which stroke of the phrase rushes/drags?
    const perStep = [];
    for (let p = 0; p < perPhrase; p++) {
      const sd = this.judged
        .filter((j) => j.judge !== 'miss' && j.note.phrasePos === p)
        .map((j) => j.devMs);
      const ss = summarize(sd);
      if (ss && ss.n >= 3) {
        let hand = rud.notes[p].hand;
        if (this.lead === 'L') hand = swapLead(hand);
        perStep.push(`${hand}${p + 1}: ${ss.mean >= 0 ? '+' : ''}${ss.mean.toFixed(1)}`);
      }
    }

    let accentLine = '';
    const accHits = this.judged.filter((j) => j.judge !== 'miss' && j.note.accent && j.level > 0);
    const tapHits = this.judged.filter((j) => j.judge !== 'miss' && !j.note.accent && j.level > 0);
    if (accHits.length >= 3 && tapHits.length >= 3) {
      const med = (arr) => {
        const sorted = arr.map((j) => j.level).sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
      };
      const db = 20 * Math.log10(med(accHits) / Math.max(med(tapHits), 1e-9));
      const silent = accHits.filter((j) => j.level < med(tapHits)).length;
      accentLine = `accents: ${accHits.length} played · level ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB vs taps`
        + (silent ? ` · ${silent} did not speak (at tap level)` : '') + '<br>';
      this._accentDb = +db.toFixed(1);
    } else {
      this._accentDb = null;
    }

    const perTempo = [];
    for (const seg of this.chart.segments) {
      const segDevs = this.judged
        .filter((j) => j.judge !== 'miss' && segmentAt(this.chart.segments, j.note.offset).bpm === seg.bpm)
        .map((j) => j.devMs);
      const segMiss = this.chart.notes
        .filter((n) => n.state === 'miss' && segmentAt(this.chart.segments, n.offset).bpm === seg.bpm).length;
      const ss = summarize(segDevs);
      if (ss) perTempo.push(`${glyph}${seg.bpm}: ±${ss.sd.toFixed(1)}ms${segMiss ? ` (${segMiss} missed)` : ''}`);
    }

    const cal = store.get('calibrationMs');
    let offsetHint = '';
    if (s.n >= 8 && Math.abs(s.mean) > 25 && s.sd < Math.abs(s.mean)) {
      offsetHint = `<span class="sub">These are tight (±${s.sd.toFixed(0)} ms) but sit ${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(0)} ms as a group — a steady offset, not rushing or dragging. That's almost always system latency${cal === null ? " (you haven't calibrated this phone yet)" : ''}. Run Calibrate and these line up.</span><br>`;
    }
    const bleedNote = this.bleed.warning();
    el.innerHTML = `
      <b>${rud.name} · ${s.n} hits · ${missed} missed · ${this.strays} strays · best streak ${this.bestCombo}</b><br>
      ${bleedNote ? `<span class="sub">NOTE: ${bleedNote}</span><br>` : ''}
      mean ${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(1)} ms · spread ${s.sd.toFixed(1)} ms · ${this.grooveUsed.meter.label} ${this.grooveUsed.grouping !== Object.keys(this.grooveUsed.meter.groupings)[0] ? this.grooveUsed.grouping : ''}<br>
      ${offsetHint}
      ${accentLine}
      ${perTempo.length > 1 ? `<span>spread by tempo: ${perTempo.join(' · ')}</span><br>` : ''}
      <span class="sub">per stroke (mean ms): ${perStep.join(' · ') || 'not enough hits per stroke'}</span><br>
      <span class="sub">negative = early. The judgement is yours; these are just the facts.</span>`;

    const segs = this.chart.segments;
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
  }
}
