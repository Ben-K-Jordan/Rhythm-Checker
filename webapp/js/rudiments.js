// Rudiment trainer: a falling-note highway synced to the audio clock.
// Meter-aware (any time signature, odd groupings), lead-hand switchable,
// with an optional tempo ramp — and per-tempo analysis, so the report shows
// the exact BPM where a rudiment starts to fall apart.
// The mic hears WHEN, not WHICH HAND — sticking letters are guidance.

import { ChartPlayer } from './metronome.js';
import { buildChartTimes, segmentAt, unitGlyph } from './meter.js';
import { GrooveBar } from './groove.js';
import { judgeHit, JUDGE_WINDOWS, summarize } from './dsp.js';
import { store } from './store.js';

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

function swapLead(ch) {
  const map = { R: 'L', L: 'R', r: 'l', l: 'r' };
  return map[ch] || ch;
}

export function buildChart(rudiment, groove, bars, ramp, lead = 'R') {
  const { steps, clicks, barOffsets, segments, total } = buildChartTimes({
    bpm: groove.bpm,
    meter: groove.meter,
    grouping: groove.grouping,
    sub: rudiment.sub,
    bars,
    ramp,
  });
  const notes = steps.map((offset, i) => {
    let ch = rudiment.steps[i % rudiment.steps.length];
    if (lead === 'L') ch = swapLead(ch);
    return {
      index: i,
      stick: ch.toUpperCase(),
      accent: rudiment.accentUpper ? ch === ch.toUpperCase() : false,
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
    this.render();
    this._raf = null;
    mic.addEventListener('onset', (e) => this.onHit(e.detail));
  }

  activate() {
    this.mic.setDetectorOptions({ refractory: 0.03, threshold: 4, minLevel: 0.01 });
    if (!this._raf) this.loop();
  }

  render() {
    this.root.innerHTML = `
      <div class="mode-head">
        <select id="rud-pattern">
          ${RUDIMENTS.map((r) => `<option value="${r.id}">${r.name}</option>`).join('')}
        </select>
        <button id="rud-lead" title="lead hand">lead: R</button>
        <label>Bars <select id="rud-bars">
          <option value="8">8</option><option value="16" selected>16</option>
          <option value="32">32</option><option value="64">64</option>
        </select></label>
        <label>Ramp <select id="rud-ramp">
          ${RAMPS.map((r) => `<option value="${r.id}">${r.label}</option>`).join('')}
        </select></label>
        <button id="rud-go" class="primary">Play</button>
      </div>
      <div id="rud-groove"></div>
      <div class="hud">
        <div class="stat"><span id="rud-combo">0</span><label>streak</label></div>
        <div class="stat"><span id="rud-acc">—</span><label>accuracy</label></div>
        <div class="stat"><span id="rud-tempo">—</span><label>tempo</label></div>
        <div class="stat"><span id="rud-judge" class="judge"></span><label></label></div>
      </div>
      <canvas id="rud-highway" width="900" height="440"></canvas>
      <div id="rud-summary" class="verdict hidden"></div>`;
    this.groove = new GrooveBar(this.root.querySelector('#rud-groove'), {
      storeKey: 'grooveRud',
      now: () => this.mic.now(),
    });
    this.root.querySelector('#rud-go').addEventListener('click', () => this.toggle());
    this.root.querySelector('#rud-lead').addEventListener('click', (e) => {
      this.lead = this.lead === 'R' ? 'L' : 'R';
      e.target.textContent = `lead: ${this.lead}`;
    });
  }

  toggle() {
    if (this.running) { this.stop(true); return; }
    const rud = RUDIMENTS.find((r) => r.id === this.root.querySelector('#rud-pattern').value);
    this.rudiment = rud;
    const bars = +this.root.querySelector('#rud-bars').value;
    const rampDef = RAMPS.find((r) => r.id === this.root.querySelector('#rud-ramp').value);
    const groove = this.groove.value();
    this.chart = buildChart(rud, groove, bars, rampDef.ramp, this.lead);
    this.grooveUsed = groove;

    // one count-in bar of plain pulses at the starting tempo, then the chart
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
    this.root.querySelector('#rud-summary').classList.add('hidden');
    this.running = true;
    this.root.querySelector('#rud-go').textContent = 'Stop';
    const runSecs = countInDur + this.chart.total + 1;
    this._endTimer = setTimeout(() => this.stop(false), (runSecs + 0.4) * 1000);
  }

  stop(cancelled) {
    this.running = false;
    clearTimeout(this._endTimer);
    if (this.player) this.player.stop();
    this.root.querySelector('#rud-go').textContent = 'Play';
    if (!cancelled) this.showSummary();
  }

  onHit(onset) {
    if (!this.running || !this.root.classList.contains('active')) return;
    const cal = (store.get('calibrationMs') || 0) / 1000;
    const t = onset.time - cal;
    if (t < this.chartStart - 0.2) return; // count-in noodling is free
    let best = null;
    let bestAbs = Infinity;
    for (const n of this.chart.notes) {
      if (n.state !== 'coming') continue;
      const dev = (t - (this.chartStart + n.offset)) * 1000;
      if (Math.abs(dev) < bestAbs) { bestAbs = Math.abs(dev); best = n; }
      if (dev < -MATCH_WINDOW_MS) break; // notes are ordered; nothing closer ahead
    }
    if (!best || bestAbs > MATCH_WINDOW_MS) { this.strays++; return; }
    const windows = JUDGE_WINDOWS[store.get('judgeMode')] || JUDGE_WINDOWS.standard;
    const dev = (t - (this.chartStart + best.offset)) * 1000;
    const judge = judgeHit(dev, windows);
    best.state = judge === 'miss' ? 'miss' : `hit-${judge}`;
    best.devMs = dev;
    this.judged.push({ note: best, judge, devMs: dev });
    if (judge === 'perfect' || judge === 'good') {
      this.combo++;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
    } else {
      this.combo = 0;
    }
    this.flashJudge(judge, dev);
  }

  flashJudge(judge, devMs) {
    const el = this.root.querySelector('#rud-judge');
    el.textContent = judge === 'miss' ? 'miss'
      : `${judge} ${devMs >= 0 ? '+' : ''}${devMs.toFixed(0)}ms`;
    el.className = `judge ${judge}`;
    this.root.querySelector('#rud-combo').textContent = String(this.combo);
    const hits = this.judged.filter((j) => j.judge !== 'miss').length;
    const seen = this.judged.length + this.chart.notes.filter((n) => n.state === 'miss').length;
    if (seen) this.root.querySelector('#rud-acc').textContent = `${((100 * hits) / seen).toFixed(0)}%`;
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
    const strikeY = h - 70;
    const pxPerSec = 260;

    ctx.fillStyle = '#151922';
    ctx.fillRect(w / 2 - 130, 0, 260, h);
    ctx.strokeStyle = '#3ddc84';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(w / 2 - 150, strikeY);
    ctx.lineTo(w / 2 + 150, strikeY);
    ctx.stroke();

    if (!this.running) {
      ctx.fillStyle = '#8a919e';
      ctx.font = '18px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('pick a rudiment, dial the groove bar, hit Play — one bar count-in', w / 2, h / 2);
      return;
    }
    const now = this.mic.now();

    for (const n of this.chart.notes) {
      if (n.state === 'coming' && now - (this.chartStart + n.offset) > MATCH_WINDOW_MS / 1000) {
        n.state = 'miss';
        this.combo = 0;
      }
    }

    // live tempo readout (matters during ramps)
    const rel = now - this.chartStart;
    const seg = rel >= 0 ? segmentAt(this.chart.segments, rel) : this.chart.segments[0];
    this.root.querySelector('#rud-tempo').textContent =
      `${unitGlyph(this.grooveUsed.meter)}=${seg.bpm}`;

    // bar lines
    ctx.strokeStyle = '#2a303c';
    ctx.lineWidth = 1;
    for (const b of this.chart.barOffsets) {
      const y = strikeY - (this.chartStart + b - now) * pxPerSec;
      if (y < -10 || y > h + 10) continue;
      ctx.beginPath();
      ctx.moveTo(w / 2 - 130, y);
      ctx.lineTo(w / 2 + 130, y);
      ctx.stroke();
    }

    ctx.textAlign = 'center';
    const colors = {
      'coming': '#4da3ff', 'hit-perfect': '#3ddc84', 'hit-good': '#b8e986',
      'hit-ok': '#ffb04d', 'miss': '#ff5252',
    };
    for (const n of this.chart.notes) {
      const t = this.chartStart + n.offset;
      const y = strikeY - (t - now) * pxPerSec;
      if (y < -30 || y > h + 30) continue;
      const r = n.accent ? 22 : 15;
      ctx.globalAlpha = n.state === 'coming' ? 1 : 0.45;
      ctx.fillStyle = colors[n.state];
      ctx.beginPath();
      ctx.arc(w / 2, y, r, 0, 7);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0d1015';
      ctx.font = `bold ${n.accent ? 18 : 13}px system-ui`;
      ctx.fillText(n.stick, w / 2, y + 5);
    }

    if (now < this.chartStart) {
      const pulsesLeft = Math.ceil((this.chartStart - now) / (this.countInDur / this.grooveUsed.meter.pulses));
      ctx.fillStyle = '#e8eaf0';
      ctx.font = 'bold 64px system-ui';
      ctx.fillText(String(pulsesLeft), w / 2, h / 2);
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

    // per-step: does step 3 of the paradiddle rush?
    const perStep = [];
    for (let p = 0; p < rud.steps.length; p++) {
      const stepDevs = this.judged
        .filter((j) => j.judge !== 'miss' && j.note.index % rud.steps.length === p)
        .map((j) => j.devMs);
      const ss = summarize(stepDevs);
      if (ss && ss.n >= 3) perStep.push(`${rud.steps[p].toUpperCase()}${p + 1}: ${ss.mean >= 0 ? '+' : ''}${ss.mean.toFixed(1)}`);
    }

    // per-tempo: where does it fall apart? (the ramp's whole point)
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

    el.innerHTML = `
      <b>${s.n} hits · ${missed} missed · ${this.strays} strays · best streak ${this.bestCombo}</b><br>
      mean ${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(1)} ms · spread ${s.sd.toFixed(1)} ms · ${this.grooveUsed.meter.label} ${this.grooveUsed.grouping !== Object.keys(this.grooveUsed.meter.groupings)[0] ? this.grooveUsed.grouping : ''}<br>
      ${perTempo.length > 1 ? `<span>spread by tempo: ${perTempo.join(' · ')}</span><br>` : ''}
      <span class="dim">per step (mean ms): ${perStep.join(' · ') || 'not enough hits per step'}</span><br>
      <span class="dim">negative = early. The judgement is yours; these are just the facts.</span>`;

    const segs = this.chart.segments;
    store.addRun({
      kind: 'rudiment',
      label: `${rud.name} (${this.lead}-lead)`,
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
