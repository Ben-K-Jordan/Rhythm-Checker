// Rudiment trainer — the hero screen. A horizontal scroll strip: R/L pucks
// ride right-to-left past a fixed NOW read-head and are judged live as they
// cross it. Meter-aware (odd groupings included), lead-hand switchable,
// accent-placeable, optional tempo ramp with per-tempo analysis.
// The mic hears WHEN, not WHICH HAND — sticking letters are guidance.

import { ChartPlayer } from './metronome.js';
import { METERS, meterById, defaultGrouping, accentsFor, buildChartTimes, segmentAt, unitGlyph, TapTempo } from './meter.js';
import { BleedGuard, judgeHit, JUDGE_WINDOWS, summarize } from './dsp.js';
import { store } from './store.js';
import { theme } from './theme.js';
import { wakeLock } from './audio.js';

export const RUDIMENTS = [
  { id: 'singles', name: 'Single Stroke Roll', sub: 2, steps: 'RLRLRLRL' },
  { id: 'doubles', name: 'Double Stroke Roll', sub: 2, steps: 'RRLLRRLL' },
  { id: 'paradiddle', name: 'Single Paradiddle', sub: 4, steps: 'RlrrLrll', accentUpper: true },
  { id: 'dparadiddle', name: 'Double Paradiddle', sub: 3, steps: 'RlrlrrLrlrll', accentUpper: true },
  { id: 'pdd', name: 'Paradiddle-diddle', sub: 3, steps: 'RlrrllRlrrll', accentUpper: true },
  { id: 'trip', name: 'Triplet Singles', sub: 3, steps: 'RlrLrl', accentUpper: true },
  { id: 'sixteenths', name: 'Free Sixteenths', sub: 4, steps: 'RLRL' },
];

export const RAMPS = [
  { id: 'off', label: 'steady', ramp: null },
  { id: 'r5x4', label: '+5 / 4 bars', ramp: { addBpm: 5, everyBars: 4 } },
  { id: 'r10x4', label: '+10 / 4 bars', ramp: { addBpm: 10, everyBars: 4 } },
  { id: 'r5x8', label: '+5 / 8 bars', ramp: { addBpm: 5, everyBars: 8 } },
];

const MATCH_WINDOW_MS = 90;
const BARS_CYCLE = [8, 16, 32, 64];

function swapLead(ch) {
  const map = { R: 'L', L: 'R', r: 'l', l: 'r' };
  return map[ch] || ch;
}

export const ACCENT_MODES = [
  { id: 'pattern', label: 'pattern' },
  { id: 'downbeats', label: 'pulses' },
  { id: 'moving', label: 'moving' },
  { id: 'none', label: 'none' },
  { id: 'custom', label: 'custom' },
];

export function accentFor(rudiment, accent, noteIndex) {
  const len = rudiment.steps.length;
  const step = noteIndex % len;
  switch (accent.mode) {
    case 'none': return false;
    case 'downbeats': return noteIndex % rudiment.sub === 0;
    case 'moving': return step === Math.floor(noteIndex / len) % len;
    case 'custom': return accent.custom.includes(step);
    default: {
      const ch = rudiment.steps[step];
      return rudiment.accentUpper ? ch === ch.toUpperCase() : false;
    }
  }
}

export function buildChart(rudiment, groove, bars, ramp, lead = 'R',
  accent = { mode: 'pattern', custom: [] }) {
  const { steps, clicks, barOffsets, segments, total } = buildChartTimes({
    bpm: groove.bpm,
    meter: groove.meter,
    grouping: groove.grouping,
    sub: rudiment.sub,
    bars,
    ramp,
  });
  const notes = steps.map((offset, i) => {
    const step = i + 1 < steps.length ? steps[i + 1] - offset : offset - steps[i - 1];
    let ch = rudiment.steps[i % rudiment.steps.length];
    if (lead === 'L') ch = swapLead(ch);
    return {
      index: i,
      step,
      stick: ch.toUpperCase(),
      accent: accentFor(rudiment, accent, i),
      offset,
      state: 'coming',
      devMs: null,
    };
  });
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
    this.expand = null; // null | 'tempo' | 'meter'
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
    const rudId = this.rudimentId || 'paradiddle';
    this.rudimentId = rudId;
    const meter = meterById(this.meterId);
    const groupings = Object.keys(meter.groupings);
    this.root.innerHTML = `
      <div class="title-stamp" style="font-size:36px">RUDIMENTS</div>

      <div class="rud-controls">
        <div class="rud-picker">
          <select id="rud-pattern" aria-label="rudiment">
            ${RUDIMENTS.map((r) => `<option value="${r.id}" ${r.id === rudId ? 'selected' : ''}>${r.name}</option>`).join('')}
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
        <div class="expand-row accents-row">
          <span class="param-cap" style="margin:0 4px 0 0">ACCENTS</span>
          ${ACCENT_MODES.map((m) => `<button class="pill ${m.id === this.accentMode ? 'on' : ''}" data-am="${m.id}">${m.label}</button>`).join('')}
        </div>
        <div id="rud-accent-editor" class="accent-editor"></div>
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
      this.renderAccentEditor();
    });
    this.root.querySelector('#rud-lead').addEventListener('click', (e) => {
      this.lead = this.lead === 'R' ? 'L' : 'R';
      e.currentTarget.textContent = this.lead;
      this.renderAccentEditor();
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
        this.expandKeep('meter');
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
    this.renderAccentEditor();
  }

  expandKeep(which) { this.expand = which; }

  currentRudiment() {
    return RUDIMENTS.find((r) => r.id === this.rudimentId);
  }

  accentValue() {
    return { mode: this.accentMode, custom: [...this.customAccents] };
  }

  setAccentMode(mode) {
    this.accentMode = mode;
    if (mode === 'custom' && this.customAccents.size === 0) {
      const rud = this.currentRudiment();
      for (let s = 0; s < rud.steps.length; s++) {
        if (accentFor(rud, { mode: 'pattern', custom: [] }, s)) this.customAccents.add(s);
      }
    }
    this.root.querySelectorAll('[data-am]')
      .forEach((b) => b.classList.toggle('on', b.dataset.am === mode));
    this.renderAccentEditor();
  }

  renderAccentEditor() {
    const el = this.root.querySelector('#rud-accent-editor');
    const rud = this.currentRudiment();
    const accent = this.accentValue();
    const pucks = [];
    for (let s = 0; s < rud.steps.length; s++) {
      let ch = rud.steps[s];
      if (this.lead === 'L') ch = swapLead(ch);
      const on = accentFor(rud, accent, s);
      const hand = ch.toUpperCase();
      pucks.push(`<button class="accent-puck ${hand === 'R' ? 'r' : 'l'} ${on ? 'on' : ''} ${s % rud.sub === 0 ? 'pulse-start' : ''}"
        data-step="${s}" aria-pressed="${on}">${hand}</button>`);
    }
    el.innerHTML = pucks.join('')
      + `<span class="accent-note">${this.accentMode === 'moving' ? 'shifts one step each time through' : 'tap notes to place accents'}</span>`;
    el.querySelectorAll('.accent-puck').forEach((p) => {
      p.addEventListener('click', () => {
        const step = +p.dataset.step;
        if (this.accentMode !== 'custom') {
          this.customAccents = new Set();
          for (let s = 0; s < rud.steps.length; s++) {
            if (accentFor(rud, this.accentValue(), s)) this.customAccents.add(s);
          }
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
    for (let p = 0; p < groove.meter.pulses; p++) {
      countIn.push({ offset: p * pulseDur, accent: p === 0 });
    }
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
    const go = this.root.querySelector('#rud-go');
    go.innerHTML = 'STOP';
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
    const winMs = Math.min(MATCH_WINDOW_MS, 0.45 * (best ? best.step : 1) * 1000);
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
    num.textContent = judge === 'miss' ? '&#10007;'.replace('&#10007;', '✗') : `${devMs >= 0 ? '+' : ''}${devMs.toFixed(0)}`;
    cap.textContent = judge === 'miss' ? 'MISS' : `${judge.toUpperCase()}·MS`;
    chip.className = `judge-chip ${judge}`;
    this.root.querySelector('#rud-combo').textContent = String(this.combo);
    const hits = this.judged.filter((j) => j.judge !== 'miss').length;
    const seen = hits + this.chart.notes.filter((n) => n.state === 'miss').length;
    if (seen) this.root.querySelector('#rud-acc').textContent = `${((100 * hits) / seen).toFixed(0)}%`;
    // needle: rolling mean of the last few hits
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
    const pxPerSec = 300;

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
    const deadline = MATCH_WINDOW_MS / 1000 + 0.05;
    for (const n of this.chart.notes) {
      if (n.state === 'coming' && now - cal - (this.chartStart + n.offset) > deadline) {
        n.state = 'miss';
        this.combo = 0;
      }
    }
    // live tempo readout in the chip (matters during ramps)
    const rel = now - this.chartStart;
    const seg = rel >= 0 ? segmentAt(this.chart.segments, rel) : this.chart.segments[0];
    const chipEl = this.root.querySelector('#rud-tempo-chip');
    if (chipEl && this.running) chipEl.textContent = seg.bpm;

    const xOf = (t) => nowX + (t - now) * pxPerSec;

    // bar lines: dotted verticals
    ctx.strokeStyle = 'rgba(20,18,16,.25)';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 5]);
    for (const b of this.chart.barOffsets) {
      const x = xOf(this.chartStart + b);
      if (x < -10 || x > w + 10) continue;
      ctx.beginPath();
      ctx.moveTo(x, h * 0.12);
      ctx.lineTo(x, h * 0.88);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    const midY = h / 2;
    for (const n of this.chart.notes) {
      const t = this.chartStart + n.offset;
      const x = xOf(t);
      if (x < -60 || x > w + 60) continue;
      const r = n.accent ? 56 : 48;
      const isR = n.stick === 'R';
      const base = isR ? T.pink : T.blue;
      let alpha = 1;
      let ring = null;
      if (n.state === 'hit-perfect' || n.state === 'hit-good') ring = T.green;
      else if (n.state === 'hit-ok') ring = '#b5891f';
      else if (n.state === 'miss') { alpha = 0.35; }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = base;
      ctx.beginPath();
      ctx.arc(x, midY, r / 2, 0, 7);
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = T.ink;
      ctx.stroke();
      if (n.accent) { // double ring for accents
        ctx.beginPath();
        ctx.arc(x, midY, r / 2 + 6, 0, 7);
        ctx.lineWidth = 5;
        ctx.strokeStyle = T.ink;
        ctx.stroke();
      }
      if (ring) {
        ctx.beginPath();
        ctx.arc(x, midY, r / 2 + (n.accent ? 12 : 8), 0, 7);
        ctx.lineWidth = 5;
        ctx.strokeStyle = ring;
        ctx.stroke();
      }
      ctx.fillStyle = '#fff';
      ctx.font = `${n.accent ? 42 : 36}px 'Anton', system-ui`;
      ctx.textAlign = 'center';
      ctx.fillText(n.stick, x, midY + (n.accent ? 15 : 13));
      if (n.state === 'miss') {
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = T.pink;
        ctx.lineWidth = 5;
        const d = r / 2 - 6;
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
      ctx.fillText(String(pulsesLeft), w / 2, h / 2 + 38);
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

    const perStep = [];
    for (let p = 0; p < rud.steps.length; p++) {
      const stepDevs = this.judged
        .filter((j) => j.judge !== 'miss' && j.note.index % rud.steps.length === p)
        .map((j) => j.devMs);
      const ss = summarize(stepDevs);
      if (ss && ss.n >= 3) perStep.push(`${rud.steps[p].toUpperCase()}${p + 1}: ${ss.mean >= 0 ? '+' : ''}${ss.mean.toFixed(1)}`);
    }

    let accentLine = '';
    const accHits = this.judged.filter((j) => j.judge !== 'miss' && j.note.accent && j.level > 0);
    const tapHits = this.judged.filter((j) => j.judge !== 'miss' && !j.note.accent && j.level > 0);
    if (accHits.length >= 3 && tapHits.length >= 3) {
      const med = (arr) => {
        const sorted = arr.map((j) => j.level).sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
      };
      const accMed = med(accHits);
      const tapMed = med(tapHits);
      const db = 20 * Math.log10(accMed / Math.max(tapMed, 1e-9));
      const silent = accHits.filter((j) => j.level < tapMed).length;
      const sAcc = summarize(accHits.map((j) => j.devMs));
      const sTap = summarize(tapHits.map((j) => j.devMs));
      accentLine = `accents: ${accHits.length} played · level ${db >= 0 ? '+' : ''}${db.toFixed(1)} dB vs taps`
        + (silent ? ` · ${silent} did not speak (at tap level)` : '')
        + ` · timing acc ${sAcc.mean >= 0 ? '+' : ''}${sAcc.mean.toFixed(1)}ms / taps ${sTap.mean >= 0 ? '+' : ''}${sTap.mean.toFixed(1)}ms<br>`;
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

    const bleedNote = this.bleed.warning();
    el.innerHTML = `
      <b>${s.n} hits · ${missed} missed · ${this.strays} strays · best streak ${this.bestCombo}</b><br>
      ${bleedNote ? `<span class="sub">NOTE: ${bleedNote}</span><br>` : ''}
      mean ${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(1)} ms · spread ${s.sd.toFixed(1)} ms · ${this.grooveUsed.meter.label} ${this.grooveUsed.grouping !== Object.keys(this.grooveUsed.meter.groupings)[0] ? this.grooveUsed.grouping : ''}<br>
      ${accentLine}
      ${perTempo.length > 1 ? `<span>spread by tempo: ${perTempo.join(' · ')}</span><br>` : ''}
      <span class="sub">per step (mean ms): ${perStep.join(' · ') || 'not enough hits per step'}</span><br>
      <span class="sub">negative = early. The judgement is yours; these are just the facts.</span>`;

    const segs = this.chart.segments;
    store.addRun({
      kind: 'rudiment',
      label: `${rud.name} (${this.lead}-lead${this.accentUsed.mode !== 'pattern' ? `, ${this.accentUsed.mode} accents` : ''})`,
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
