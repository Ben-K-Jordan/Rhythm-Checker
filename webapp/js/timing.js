// Live timing check: play along with the metronome, watch your deviations in
// real time, get the honest numbers at the end. Also the engine behind the
// pre-show hands check.

import { Metronome } from './metronome.js';
import { summarize } from './dsp.js';
import { store } from './store.js';
import { GrooveBar } from './groove.js';

export class TimingSession extends EventTarget {
  // A headless scoring session, reused by the pre-show flow.
  constructor(mic, { bpm, subdivision, seconds, meter = null }) {
    super();
    this.mic = mic;
    this.metro = new Metronome(mic.audioContext);
    this.metro.bpm = bpm;
    this.metro.subdivision = subdivision;
    if (meter) this.metro.meter = meter;
    this.seconds = seconds;
    this.devs = [];
    this.hits = [];
    this.running = false;
    this._onOnset = (e) => this.score(e.detail);
  }

  start() {
    this.running = true;
    this.mic.setDetectorOptions({ refractory: 0.03, threshold: 4, minLevel: 0.01 });
    this.mic.addEventListener('onset', this._onOnset);
    this.metro.start();
    this._endTimer = setTimeout(() => this.finish(), (this.seconds + 1.5) * 1000);
  }

  score(onset) {
    if (!this.running) return;
    const cal = (store.get('calibrationMs') || 0) / 1000;
    const t = onset.time - cal;
    // ignore the first two beats (settling in) and anything past the end
    const beat = 60 / this.metro.bpm;
    if (t < this.metro.startTime + 2 * beat) return;
    if (t > this.metro.startTime + this.seconds) return;
    const grid = this.metro.nearestGrid(t);
    if (!grid) return;
    const devMs = (t - grid.time) * 1000;
    const maxDev = 0.4 * this.metro.gridInterval() * 1000;
    const entry = { t, devMs, aligned: Math.abs(devMs) <= maxDev };
    if (entry.aligned) this.devs.push(devMs);
    this.hits.push(entry);
    this.dispatchEvent(new CustomEvent('hit', { detail: entry }));
  }

  finish() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this._endTimer);
    this.metro.stop();
    this.mic.removeEventListener('onset', this._onOnset);
    const stats = summarize(this.devs);
    const pocket = this.devs.length
      ? (100 * this.devs.filter((d) => Math.abs(d) <= store.get('pocketMs')).length) / this.devs.length
      : 0;
    const result = stats
      ? { ...stats, pocketPct: pocket, unaligned: this.hits.length - this.devs.length }
      : null;
    this.dispatchEvent(new CustomEvent('done', { detail: result }));
  }

  cancel() {
    this.running = false;
    clearTimeout(this._endTimer);
    this.metro.stop();
    this.mic.removeEventListener('onset', this._onOnset);
  }
}

export class TimingMode {
  constructor(root, mic) {
    this.root = root;
    this.mic = mic;
    this.session = null;
    this.render();
  }

  activate() {
    this.mic.setDetectorOptions({ refractory: 0.03, threshold: 4, minLevel: 0.01 });
  }

  render() {
    this.root.innerHTML = `
      <div id="tm-groove"></div>
      <div class="mode-head">
        <label>Grid <select id="tm-sub">
          <option value="1">pulses</option>
          <option value="2" selected>÷2</option>
          <option value="3">÷3</option>
          <option value="4">÷4</option>
        </select></label>
        <label>Length <select id="tm-len">
          <option value="30">30 s</option>
          <option value="60" selected>60 s</option>
          <option value="120">2 min</option>
        </select></label>
        <button id="tm-go" class="primary">Start</button>
      </div>
      <div id="tm-cal-nag" class="status"></div>
      <canvas id="tm-strip" width="900" height="180"></canvas>
      <div class="stat-row">
        <div class="stat"><span id="tm-mean">—</span><label>mean ms</label></div>
        <div class="stat"><span id="tm-sd">—</span><label>spread (SD)</label></div>
        <div class="stat"><span id="tm-pocket">—</span><label>in pocket</label></div>
        <div class="stat"><span id="tm-n">—</span><label>hits</label></div>
      </div>
      <div id="tm-final" class="verdict hidden"></div>
      <div class="row"><button id="tm-baseline" class="hidden">Save as my baseline</button></div>`;
    this.groove = new GrooveBar(this.root.querySelector('#tm-groove'), {
      storeKey: 'grooveTiming',
      now: () => this.mic.now(),
    });
    this.root.querySelector('#tm-go').addEventListener('click', () => this.toggle());
    this.root.querySelector('#tm-baseline').addEventListener('click', () => this.saveBaseline());
    this.updateNag();
  }

  updateNag() {
    const nag = this.root.querySelector('#tm-cal-nag');
    nag.textContent = store.get('calibrationMs') === null
      ? 'Not calibrated on this device — absolute early/late will include your system latency. Run Calibrate first.'
      : `calibration: ${store.get('calibrationMs').toFixed(0)} ms subtracted from every hit`;
  }

  toggle() {
    if (this.session && this.session.running) {
      this.session.cancel();
      this.session = null;
      this.root.querySelector('#tm-go').textContent = 'Start';
      return;
    }
    this.updateNag();
    const g = this.groove.value();
    store.set('preferredBpm', g.bpm);
    this.lastRun = {
      bpm: g.bpm,
      subdivision: +this.root.querySelector('#tm-sub').value,
      seconds: +this.root.querySelector('#tm-len').value,
      meter: { pulses: g.meter.pulses, accents: g.meter.groupings[g.grouping] },
      meterLabel: `${g.meter.label} ${g.grouping}`,
    };
    this.session = new TimingSession(this.mic, this.lastRun);
    this.recent = [];
    this.root.querySelector('#tm-final').classList.add('hidden');
    this.root.querySelector('#tm-baseline').classList.add('hidden');
    this.session.addEventListener('hit', (e) => this.onHit(e.detail));
    this.session.addEventListener('done', (e) => this.onDone(e.detail));
    this.session.start();
    this.root.querySelector('#tm-go').textContent = 'Stop';
  }

  onHit(hit) {
    if (hit.aligned) this.recent.push(hit.devMs);
    if (this.recent.length > 200) this.recent.shift();
    const s = summarize(this.recent);
    if (s) {
      this.root.querySelector('#tm-mean').textContent = `${s.mean >= 0 ? '+' : ''}${s.mean.toFixed(1)}`;
      this.root.querySelector('#tm-sd').textContent = s.sd.toFixed(1);
      this.root.querySelector('#tm-n').textContent = String(s.n);
      const pocket = (100 * this.recent.filter((d) => Math.abs(d) <= store.get('pocketMs')).length) / this.recent.length;
      this.root.querySelector('#tm-pocket').textContent = `${pocket.toFixed(0)}%`;
    }
    this.drawStrip();
  }

  drawStrip() {
    const cv = this.root.querySelector('#tm-strip');
    const ctx = cv.getContext('2d');
    const w = cv.width;
    const h = cv.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(61,220,132,.12)';
    const pk = store.get('pocketMs');
    const yOf = (d) => h / 2 - (d / 60) * (h / 2 - 10);
    ctx.fillRect(0, yOf(pk), w, yOf(-pk) - yOf(pk));
    ctx.strokeStyle = '#3a3f4a';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    const n = this.recent.length;
    this.recent.forEach((d, i) => {
      const x = w - (n - i) * 8 - 10;
      if (x < 0) return;
      ctx.fillStyle = Math.abs(d) <= pk ? '#3ddc84' : d < 0 ? '#4da3ff' : '#ffb04d';
      ctx.beginPath();
      ctx.arc(x, yOf(Math.max(-60, Math.min(60, d))), 4, 0, 7);
      ctx.fill();
    });
    ctx.fillStyle = '#8a919e';
    ctx.font = '12px system-ui';
    ctx.fillText('early ↑', 8, 14);
    ctx.fillText('late ↓', 8, h - 8);
  }

  onDone(result) {
    this.root.querySelector('#tm-go').textContent = 'Start';
    const final = this.root.querySelector('#tm-final');
    final.classList.remove('hidden');
    if (!result) {
      final.textContent = 'No hits detected — check the mic level meter and try again.';
      return;
    }
    const base = store.get('baseline');
    let verdict = `mean ${result.mean >= 0 ? '+' : ''}${result.mean.toFixed(1)} ms · spread ${result.sd.toFixed(1)} ms · ${result.pocketPct.toFixed(0)}% in pocket (${result.n} hits)`;
    if (base) {
      const dSd = result.sd - base.sd;
      verdict += ` — baseline spread ${base.sd.toFixed(1)} ms (${dSd >= 0 ? '+' : ''}${dSd.toFixed(1)})`;
    }
    final.textContent = verdict;
    this.lastResult = result;
    this.root.querySelector('#tm-baseline').classList.remove('hidden');
    store.addRun({
      kind: 'timing',
      label: `free play ÷${this.lastRun.subdivision}`,
      meter: this.lastRun.meterLabel,
      bpmStart: this.lastRun.bpm,
      bpmEnd: this.lastRun.bpm,
      n: result.n,
      mean: +result.mean.toFixed(2),
      sd: +result.sd.toFixed(2),
      pocketPct: +result.pocketPct.toFixed(1),
      unaligned: result.unaligned,
    });
  }

  saveBaseline() {
    if (!this.lastResult) return;
    store.set('baseline', {
      bpm: this.lastRun.bpm,
      subdivision: this.lastRun.subdivision,
      mean: this.lastResult.mean,
      sd: this.lastResult.sd,
      pocketPct: this.lastResult.pocketPct,
      date: new Date().toISOString().slice(0, 10),
    });
    this.root.querySelector('#tm-baseline').textContent = 'Baseline saved ✓';
    setTimeout(() => {
      this.root.querySelector('#tm-baseline').textContent = 'Save as my baseline';
    }, 2000);
  }
}
