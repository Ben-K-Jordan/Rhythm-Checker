// Rudiment trainer: a falling-note highway synced to the metronome's audio
// clock. Every mic hit is matched to its nearest expected note and judged.
// The mic hears WHEN, not WHICH HAND — sticking letters are guidance, timing
// is what's scored.

import { Metronome } from './metronome.js';
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

const MATCH_WINDOW_MS = 90;

export class RudimentsMode {
  constructor(root, mic) {
    this.root = root;
    this.mic = mic;
    this.running = false;
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
        <label>BPM <input id="rud-bpm" type="number" min="20" max="400" value="${store.get('preferredBpm')}"></label>
        <label>Bars <select id="rud-bars">
          <option value="8">8</option><option value="16" selected>16</option><option value="32">32</option>
        </select></label>
        <button id="rud-go" class="primary">Play</button>
      </div>
      <div class="hud">
        <div class="stat"><span id="rud-combo">0</span><label>streak</label></div>
        <div class="stat"><span id="rud-acc">—</span><label>accuracy</label></div>
        <div class="stat"><span id="rud-judge" class="judge"></span><label></label></div>
      </div>
      <canvas id="rud-highway" width="900" height="440"></canvas>
      <div id="rud-summary" class="verdict hidden"></div>`;
    this.root.querySelector('#rud-go').addEventListener('click', () => this.toggle());
  }

  buildChart(rudiment, bpm, bars) {
    // one note per subdivision step, looping the sticking pattern across bars
    const notes = [];
    const stepDur = 60 / bpm / rudiment.sub;
    const stepsPerBar = rudiment.sub * 4;
    const total = bars * stepsPerBar;
    for (let i = 0; i < total; i++) {
      const ch = rudiment.steps[i % rudiment.steps.length];
      notes.push({
        index: i,
        stick: ch.toUpperCase(),
        accent: rudiment.accentUpper ? ch === ch.toUpperCase() : false,
        offset: i * stepDur, // relative to chart start
        state: 'coming',     // coming | hit-perfect | hit-good | hit-ok | miss
        devMs: null,
      });
    }
    return notes;
  }

  toggle() {
    if (this.running) { this.stop(true); return; }
    const rud = RUDIMENTS.find((r) => r.id === this.root.querySelector('#rud-pattern').value);
    const bpm = Math.min(400, Math.max(20, +this.root.querySelector('#rud-bpm').value || 120));
    store.set('preferredBpm', bpm);
    const bars = +this.root.querySelector('#rud-bars').value;
    this.metro = new Metronome(this.mic.audioContext);
    this.metro.bpm = bpm;
    this.metro.subdivision = rud.sub;
    this.notes = this.buildChart(rud, bpm, bars);
    this.combo = 0;
    this.bestCombo = 0;
    this.strays = 0;
    this.judged = [];
    this.root.querySelector('#rud-summary').classList.add('hidden');
    this.metro.start(0.2);
    // chart begins after a one-bar count-in
    this.chartStart = this.metro.startTime + 4 * (60 / bpm);
    this.chartEnd = this.chartStart + this.notes[this.notes.length - 1].offset + 0.5;
    this.running = true;
    this.root.querySelector('#rud-go').textContent = 'Stop';
    this._endTimer = setTimeout(() => this.stop(false), (this.chartEnd - this.mic.now() + 0.8) * 1000);
  }

  stop(cancelled) {
    this.running = false;
    clearTimeout(this._endTimer);
    if (this.metro) this.metro.stop();
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
    for (const n of this.notes) {
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
    const seen = this.judged.length + this.notes.filter((n) => n.state === 'miss').length;
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

    // lane + strike line
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
      ctx.fillText('pick a rudiment and hit Play — one bar of count-in, then notes', w / 2, h / 2);
      return;
    }
    const now = this.mic.now();

    // sweep passed notes into misses
    for (const n of this.notes) {
      if (n.state === 'coming' && now - (this.chartStart + n.offset) > MATCH_WINDOW_MS / 1000) {
        n.state = 'miss';
        this.combo = 0;
      }
    }

    ctx.textAlign = 'center';
    for (const n of this.notes) {
      const t = this.chartStart + n.offset;
      const y = strikeY - (t - now) * pxPerSec;
      if (y < -30 || y > h + 30) continue;
      const r = n.accent ? 22 : 15;
      const colors = {
        'coming': '#4da3ff',
        'hit-perfect': '#3ddc84',
        'hit-good': '#b8e986',
        'hit-ok': '#ffb04d',
        'miss': '#ff5252',
      };
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

    // count-in indicator
    if (now < this.chartStart) {
      const beatsLeft = Math.ceil((this.chartStart - now) / (60 / this.metro.bpm));
      ctx.fillStyle = '#e8eaf0';
      ctx.font = 'bold 64px system-ui';
      ctx.fillText(String(beatsLeft), w / 2, h / 2);
    }
  }

  showSummary() {
    const el = this.root.querySelector('#rud-summary');
    el.classList.remove('hidden');
    const devs = this.judged.filter((j) => j.judge !== 'miss').map((j) => j.devMs);
    const missed = this.notes.filter((n) => n.state === 'miss').length;
    const s = summarize(devs);
    if (!s) { el.textContent = 'No notes hit. Check the mic meter, then try a slower tempo.'; return; }
    // honest per-position readout: does step 3 of the paradiddle rush?
    const rud = RUDIMENTS.find((r) => r.id === this.root.querySelector('#rud-pattern').value);
    const perStep = [];
    for (let p = 0; p < rud.steps.length; p++) {
      const stepDevs = this.judged
        .filter((j) => j.judge !== 'miss' && j.note.index % rud.steps.length === p)
        .map((j) => j.devMs);
      const ss = summarize(stepDevs);
      if (ss && ss.n >= 3) perStep.push(`${rud.steps[p].toUpperCase()}${p + 1}: ${ss.mean >= 0 ? '+' : ''}${ss.mean.toFixed(1)}`);
    }
    el.innerHTML = `
      <b>${s.n} hits · ${missed} missed · ${this.strays} strays · best streak ${this.bestCombo}</b><br>
      mean ${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(1)} ms · spread ${s.sd.toFixed(1)} ms<br>
      <span class="dim">per step (mean ms): ${perStep.join(' · ') || 'not enough hits per step'}</span><br>
      <span class="dim">negative = early. The judgement is yours; these are just the facts.</span>`;
  }
}
