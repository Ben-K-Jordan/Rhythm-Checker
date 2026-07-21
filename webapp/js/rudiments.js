// Rudiment trainer: a falling-note highway synced to the audio clock.
// Meter-aware (any time signature, odd groupings), lead-hand switchable,
// with an optional tempo ramp — and per-tempo analysis, so the report shows
// the exact BPM where a rudiment starts to fall apart.
// The mic hears WHEN, not WHICH HAND — sticking letters are guidance.

import { ChartPlayer } from './metronome.js';
import { buildChartTimes, segmentAt, unitGlyph } from './meter.js';
import { GrooveBar } from './groove.js';
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

function swapLead(ch) {
  const map = { R: 'L', L: 'R', r: 'l', l: 'r' };
  return map[ch] || ch;
}

export const ACCENT_MODES = [
  { id: 'pattern', label: 'pattern' },   // the rudiment's own accents
  { id: 'downbeats', label: 'pulses' },  // first note of every pulse
  { id: 'moving', label: 'moving' },     // classic study: shifts one step per repetition
  { id: 'none', label: 'none' },
  { id: 'custom', label: 'custom' },     // tap notes in the editor to place accents
];

export function accentFor(rudiment, accent, noteIndex) {
  const len = rudiment.steps.length;
  const step = noteIndex % len;
  switch (accent.mode) {
    case 'none': return false;
    case 'downbeats': return noteIndex % rudiment.sub === 0;
    case 'moving': return step === Math.floor(noteIndex / len) % len;
    case 'custom': return accent.custom.includes(step);
    default: { // 'pattern'
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
    let ch = rudiment.steps[i % rudiment.steps.length];
    if (lead === 'L') ch = swapLead(ch);
    return {
      index: i,
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
    this.accentMode = 'pattern';
    this.customAccents = new Set();
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
      <div class="accent-panel">
        <div class="row">
          <span class="dim">accents</span>
          <div class="seg" id="rud-accent-modes">
            ${ACCENT_MODES.map((m) => `<button data-am="${m.id}" class="${m.id === this.accentMode ? 'on' : ''}">${m.label}</button>`).join('')}
          </div>
        </div>
        <div id="rud-accent-editor" class="accent-editor"></div>
      </div>
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
      this.renderAccentEditor();
    });
    this.root.querySelector('#rud-pattern').addEventListener('change', () => {
      this.customAccents.clear();
      this.renderAccentEditor();
    });
    this.root.querySelectorAll('#rud-accent-modes button').forEach((b) => {
      b.addEventListener('click', () => this.setAccentMode(b.dataset.am));
    });
    this.renderAccentEditor();
  }

  currentRudiment() {
    return RUDIMENTS.find((r) => r.id === this.root.querySelector('#rud-pattern').value);
  }

  accentValue() {
    return { mode: this.accentMode, custom: [...this.customAccents] };
  }

  setAccentMode(mode) {
    this.accentMode = mode;
    if (mode === 'custom' && this.customAccents.size === 0) {
      // seed custom from the pattern's own accents so editing starts from sense
      const rud = this.currentRudiment();
      for (let s = 0; s < rud.steps.length; s++) {
        if (accentFor(rud, { mode: 'pattern', custom: [] }, s)) this.customAccents.add(s);
      }
    }
    this.root.querySelectorAll('#rud-accent-modes button')
      .forEach((b) => b.classList.toggle('on', b.dataset.am === mode));
    this.renderAccentEditor();
  }

  // One cycle of the pattern as tappable pucks; tapping any puck switches to
  // custom mode with that accent toggled. 'moving' previews repetition 1.
  renderAccentEditor() {
    const el = this.root.querySelector('#rud-accent-editor');
    const rud = this.currentRudiment();
    const accent = this.accentValue();
    const pucks = [];
    for (let s = 0; s < rud.steps.length; s++) {
      let ch = rud.steps[s];
      if (this.lead === 'L') ch = swapLead(ch);
      const on = accentFor(rud, accent, s);
      const pulseStart = s % rud.sub === 0;
      pucks.push(`<button class="accent-puck ${on ? 'on' : ''} ${pulseStart ? 'pulse-start' : ''}"
        data-step="${s}" aria-pressed="${on}">${ch.toUpperCase()}</button>`);
    }
    el.innerHTML = pucks.join('')
      + `<span class="dim accent-note">${this.accentMode === 'moving' ? 'shifts one step each time through' : 'tap notes to place accents'}</span>`;
    el.querySelectorAll('.accent-puck').forEach((p) => {
      p.addEventListener('click', () => {
        const step = +p.dataset.step;
        if (this.accentMode !== 'custom') {
          // adopt whatever is currently shown, then toggle the tapped step
          this.customAccents = new Set();
          for (let s = 0; s < rud.steps.length; s++) {
            if (accentFor(rud, this.accentValue(), s)) this.customAccents.add(s);
          }
          this.accentMode = 'custom';
          this.root.querySelectorAll('#rud-accent-modes button')
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
    const bars = +this.root.querySelector('#rud-bars').value;
    const rampDef = RAMPS.find((r) => r.id === this.root.querySelector('#rud-ramp').value);
    const groove = this.groove.value();
    this.accentUsed = this.accentValue();
    this.chart = buildChart(rud, groove, bars, rampDef.ramp, this.lead, this.accentUsed);
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
    this.root.querySelector('#rud-go').textContent = 'Stop';
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
    this.root.querySelector('#rud-go').textContent = 'Play';
    if (!cancelled) {
      // every deadline has passed by now: anything still pending is a miss
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
    if (t < this.chartStart - 0.2) return; // count-in noodling is free
    // quiet "hits" landing exactly on the app's own clicks are bleed, not play
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
      if (dev < -MATCH_WINDOW_MS) break; // notes are ordered; nothing closer ahead
    }
    if (!best || bestAbs > MATCH_WINDOW_MS) { this.strays++; return; }
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
    this.flashJudge(judge, dev);
  }

  flashJudge(judge, devMs) {
    const el = this.root.querySelector('#rud-judge');
    el.textContent = judge === 'miss' ? 'miss'
      : `${judge} ${devMs >= 0 ? '+' : ''}${devMs.toFixed(0)}ms`;
    el.className = `judge ${judge}`;
    this.root.querySelector('#rud-combo').textContent = String(this.combo);
    const hits = this.judged.filter((j) => j.judge !== 'miss').length;
    // note states already include judged misses — adding judged.length back
    // in would double-count them
    const seen = hits + this.chart.notes.filter((n) => n.state === 'miss').length;
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

    const T = theme();
    ctx.fillStyle = T.panel;
    ctx.fillRect(w / 2 - 130, 0, 260, h);
    // hatched shoulders, like the printed edge of a ticket
    ctx.strokeStyle = T.line;
    ctx.lineWidth = 1;
    for (const [x0, x1] of [[0, w / 2 - 150], [w / 2 + 150, w]]) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, x1 - x0, h);
      ctx.clip();
      for (let x = x0 - h; x < x1; x += 14) {
        ctx.beginPath();
        ctx.moveTo(x, h);
        ctx.lineTo(x + h, 0);
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.strokeStyle = T.ink;
    ctx.lineWidth = 2;
    ctx.strokeRect(w / 2 - 130, 0, 260, h);
    ctx.strokeStyle = T.pink;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(w / 2 - 150, strikeY);
    ctx.lineTo(w / 2 + 150, strikeY);
    ctx.stroke();

    if (!this.running) {
      ctx.textAlign = 'center';
      ctx.fillStyle = T.ink;
      ctx.font = "64px 'Anton', system-ui";
      ctx.fillText('LOAD IN', w / 2, h / 2 - 18);
      ctx.fillStyle = T.dim;
      ctx.font = '14px ' + T.mono;
      ctx.fillText('pick a rudiment · dial the groove bar · hit play', w / 2, h / 2 + 22);
      ctx.fillText('one bar of count-in, then the notes come down', w / 2, h / 2 + 44);
      return;
    }
    const now = this.mic.now();

    // sweep on the CALIBRATED clock (as onHit scores) plus delivery slack —
    // otherwise a device's fixed latency eats into the late judgement window
    const cal = (store.get('calibrationMs') || 0) / 1000;
    const deadline = MATCH_WINDOW_MS / 1000 + 0.05;
    for (const n of this.chart.notes) {
      if (n.state === 'coming' && now - cal - (this.chartStart + n.offset) > deadline) {
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
    ctx.strokeStyle = T.line;
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
      'coming': T.blue, 'hit-perfect': T.green, 'hit-good': '#4f8a10',
      'hit-ok': '#f5c518', 'miss': T.pink,
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
      ctx.fillStyle = T.paper;
      ctx.font = `bold ${n.accent ? 18 : 13}px system-ui`;
      ctx.fillText(n.stick, w / 2, y + 5);
    }

    if (now < this.chartStart) {
      const pulsesLeft = Math.ceil((this.chartStart - now) / (this.countInDur / this.grooveUsed.meter.pulses));
      ctx.fillStyle = T.ink;
      ctx.font = "72px 'Anton', system-ui";
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

    // accents: did the marked notes actually speak, and does either class
    // rush? Level is as heard by this mic position — relative, not absolute.
    let accentLine = '';
    const accHits = this.judged.filter((j) => j.judge !== 'miss' && j.note.accent && j.level > 0);
    const tapHits = this.judged.filter((j) => j.judge !== 'miss' && !j.note.accent && j.level > 0);
    if (accHits.length >= 3 && tapHits.length >= 3) {
      const med = (arr) => {
        const s = arr.map((j) => j.level).sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
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

    const bleedNote = this.bleed.warning();
    el.innerHTML = `
      <b>${s.n} hits · ${missed} missed · ${this.strays} strays · best streak ${this.bestCombo}</b><br>
      ${bleedNote ? `<span class="dim">NOTE: ${bleedNote}</span><br>` : ''}
      mean ${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(1)} ms · spread ${s.sd.toFixed(1)} ms · ${this.grooveUsed.meter.label} ${this.grooveUsed.grouping !== Object.keys(this.grooveUsed.meter.groupings)[0] ? this.grooveUsed.grouping : ''}<br>
      ${accentLine}
      ${perTempo.length > 1 ? `<span>spread by tempo: ${perTempo.join(' · ')}</span><br>` : ''}
      <span class="dim">per step (mean ms): ${perStep.join(' · ') || 'not enough hits per step'}</span><br>
      <span class="dim">negative = early. The judgement is yours; these are just the facts.</span>`;

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
