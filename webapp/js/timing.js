// Live timing check: hold a tempo, watch your drift over time, get the
// honest numbers at the end. TimingSession is the headless engine (also
// used for baselines); TimingMode is the steadiness-hold screen.

import { Metronome } from './metronome.js';
import { BleedGuard, summarize } from './dsp.js';
import { store } from './store.js';
import { theme } from './theme.js';
import { wakeLock } from './audio.js';

export class TimingSession extends EventTarget {
  constructor(mic, { bpm, subdivision, seconds, meter = null, clickOn = true }) {
    super();
    this.mic = mic;
    this.metro = new Metronome(mic.audioContext);
    this.metro.bpm = bpm;
    this.metro.subdivision = subdivision;
    if (meter) this.metro.meter = meter;
    this.clickOn = clickOn;
    this.seconds = seconds;
    this.devs = [];
    this.hits = [];
    this.running = false;
    this._onOnset = (e) => this.score(e.detail);
  }

  start() {
    this.running = true;
    this.bleed = new BleedGuard();
    this._lostHandler = () => this.abort('microphone lost — reconnect and run it again');
    this.mic.addEventListener('lost', this._lostHandler);
    this.mic.lockDetector(this, { refractory: 0.03, threshold: 2.5, minLevel: 0.01 });
    this.mic.addEventListener('onset', this._onOnset);
    wakeLock.acquire();
    this.metro.start();
    if (!this.clickOn) {
      // click-off hold: one audible bar to set the tempo, then silence — the
      // grid keeps running and judging. Can you hold it on your own?
      const barS = (60 / this.metro.bpm) * this.metro.meter.pulses;
      this._muteTimer = setTimeout(() => { this.metro.gain = 0; }, Math.max(0, (this.metro.startTime + barS - this.mic.now()) * 1000 - 150));
    }
    this._endTimer = setTimeout(() => this.finish(), (this.seconds + 1.5) * 1000);
  }

  score(onset) {
    if (!this.running) return;
    const cal = (store.get('calibrationMs') || 0) / 1000;
    const t = onset.time - cal;
    const beat = 60 / this.metro.bpm;
    if (t < this.metro.startTime + 2 * beat) return;
    if (t > this.metro.startTime + this.seconds) return;
    const grid = this.metro.nearestGrid(t);
    if (!grid) return;
    const devMs = (t - grid.time) * 1000;
    const nearClick = Math.abs(devMs) <= 30
      && grid.index % this.metro.subdivision === 0;
    if (this.bleed.shouldDrop(onset.level || 0, this.clickOn && nearClick)) return;
    const maxDev = 0.4 * this.metro.gridInterval() * 1000;
    const entry = { t, devMs, aligned: Math.abs(devMs) <= maxDev };
    if (entry.aligned) this.devs.push(devMs);
    this.hits.push(entry);
    this.dispatchEvent(new CustomEvent('hit', { detail: entry }));
  }

  finish() {
    if (!this.running) return;
    this._teardown();
    const stats = summarize(this.devs);
    const pocket = this.devs.length
      ? (100 * this.devs.filter((d) => Math.abs(d) <= store.get('pocketMs')).length) / this.devs.length
      : 0;
    const result = stats
      ? {
        ...stats,
        pocketPct: pocket,
        unaligned: this.hits.length - this.devs.length,
        warning: this.bleed.warning(),
      }
      : null;
    this.dispatchEvent(new CustomEvent('done', { detail: result }));
  }

  abort(reason) {
    if (!this.running) return;
    this._teardown();
    this.dispatchEvent(new CustomEvent('aborted', { detail: { reason } }));
  }

  cancel() {
    this._teardown();
  }

  _teardown() {
    this.running = false;
    clearTimeout(this._endTimer);
    clearTimeout(this._muteTimer);
    this.metro.stop();
    this.metro.gain = 0.9;
    this.mic.removeEventListener('onset', this._onOnset);
    if (this._lostHandler) this.mic.removeEventListener('lost', this._lostHandler);
    this.mic.unlockDetector(this);
    wakeLock.release();
  }
}

const HOLD_CYCLE = [30, 60, 120];
const GRID_CYCLE = [1, 2, 3, 4];

export class TimingMode {
  constructor(root, mic) {
    this.root = root;
    this.mic = mic;
    this.session = null;
    this.bpm = store.get('preferredBpm') || 120;
    this.holdSec = 30;
    this.grid = 2;
    this.clickOn = true;
    this.trace = []; // {relT, rolling} for the chart
    this.recent = [];
    this.render();
  }

  activate() {
    this.mic.setDetectorOptions({ refractory: 0.03, threshold: 2.5, minLevel: 0.01 });
  }

  render() {
    const cal = store.get('calibrationMs');
    this.root.innerHTML = `
      <div class="timing-title">
        <div class="title-stamp" style="margin:10px 0 0">TIMING</div>
        <div class="metronome-motif"><div class="mm-arm"></div></div>
      </div>

      <div class="timing-controls">
        <div class="tc-card">
          <div class="tc-cap">TARGET</div>
          <div class="tc-val"><b id="tm-bpm">${this.bpm}</b> BPM</div>
          <div class="tc-btns"><button id="tm-plus">+</button><button id="tm-minus">&#8722;</button></div>
        </div>
        <button class="tc-card" id="tm-hold">
          <div class="tc-cap">HOLD FOR</div>
          <div class="tc-val"><b>${this.holdSec}</b> SEC</div>
          <div class="tc-cap2">GRID ÷${this.grid} · tap to cycle</div>
        </button>
        <button class="tc-card ink" id="tm-click">
          <div class="tc-cap">CLICK</div>
          <div class="tc-val"><b>${this.clickOn ? 'ON' : 'OFF'}</b></div>
          <div class="tc-cap2">${this.clickOn ? 'clicks all the way' : '1 bar, then silence'}</div>
        </button>
      </div>
      <div id="tm-cal-nag" class="cal-nag">${cal === null
    ? 'not calibrated — absolute early/late includes your system latency'
    : `calibration: ${cal.toFixed(0)} ms subtracted from every hit`}</div>

      <div class="tempo-chart">
        <div class="tch-head"><span class="chip-stamp">Tempo / time</span><span class="tch-axis">&#9650; RUSH &middot; DRAG &#9660;</span></div>
        <div class="tch-plot">
          <canvas id="tm-chart" width="900" height="420"></canvas>
          <div class="tch-steadiness"><b id="tm-steadiness">&plusmn;&mdash;</b><span>STEADINESS</span></div>
          <span class="tch-faster">FASTER</span>
          <span class="tch-slower">SLOWER</span>
          <div class="scan" id="tm-scan" style="animation-duration:3s"></div>
        </div>
      </div>

      <div class="timing-stats">
        <div class="statbox amber"><b id="tm-trend">&mdash;</b><span>Trend MS/MIN</span></div>
        <div class="statbox"><b id="tm-steady">&mdash;</b><span>Steady</span></div>
        <div class="statbox"><b id="tm-n">0</b><span>Taps</span></div>
        <div class="statbox"><b id="tm-band">&mdash;</b><span>In band</span></div>
      </div>

      <div class="cta-wrap">
        <button id="tm-go" class="cta">START HOLD<span class="tri"></span></button>
      </div>
      <div id="tm-final" class="rud-summary hidden"></div>
      <div class="cta-wrap" style="padding-top:8px"><button id="tm-baseline" class="btn green hidden" style="width:100%">SAVE AS MY BASELINE &#10003;</button></div>`;

    this.root.querySelector('#tm-plus').addEventListener('click', () => this.nudge(5));
    this.root.querySelector('#tm-minus').addEventListener('click', () => this.nudge(-5));
    this.root.querySelector('#tm-hold').addEventListener('click', () => {
      // cycles hold length; a second tap pattern cycles the grid
      const i = HOLD_CYCLE.indexOf(this.holdSec);
      if (i === HOLD_CYCLE.length - 1) {
        this.holdSec = HOLD_CYCLE[0];
        this.grid = GRID_CYCLE[(GRID_CYCLE.indexOf(this.grid) + 1) % GRID_CYCLE.length];
      } else this.holdSec = HOLD_CYCLE[i + 1];
      this.render();
    });
    this.root.querySelector('#tm-click').addEventListener('click', () => {
      this.clickOn = !this.clickOn;
      this.render();
    });
    this.root.querySelector('#tm-go').addEventListener('click', () => this.toggle());
    this.root.querySelector('#tm-baseline').addEventListener('click', () => this.saveBaseline());
    this.drawChart();
  }

  nudge(d) {
    this.bpm = Math.max(20, Math.min(400, this.bpm + d));
    store.set('preferredBpm', this.bpm);
    this.root.querySelector('#tm-bpm').textContent = this.bpm;
  }

  toggle() {
    if (this.session && this.session.running) {
      this.session.cancel();
      this.session = null;
      this.root.querySelector('#tm-go').innerHTML = 'START HOLD<span class="tri"></span>';
      return;
    }
    this.lastRun = {
      bpm: this.bpm,
      subdivision: this.grid,
      seconds: this.holdSec,
      clickOn: this.clickOn,
    };
    this.session = new TimingSession(this.mic, this.lastRun);
    this.recent = [];
    this.trace = [];
    this.root.querySelector('#tm-final').classList.add('hidden');
    this.root.querySelector('#tm-baseline').classList.add('hidden');
    this.session.addEventListener('hit', (e) => this.onHit(e.detail));
    this.session.addEventListener('done', (e) => this.onDone(e.detail));
    this.session.addEventListener('aborted', (e) => {
      this.root.querySelector('#tm-go').innerHTML = 'START HOLD<span class="tri"></span>';
      const final = this.root.querySelector('#tm-final');
      final.classList.remove('hidden');
      final.textContent = `check invalidated: ${e.detail.reason}`;
      this.session = null;
    });
    this.session.start();
    this.root.querySelector('#tm-go').innerHTML = '&#9632; STOP';
  }

  deactivate() {
    if (this.session && this.session.running) {
      this.session.cancel();
      this.session = null;
      this.root.querySelector('#tm-go').innerHTML = 'START HOLD<span class="tri"></span>';
      const final = this.root.querySelector('#tm-final');
      final.classList.remove('hidden');
      final.textContent = 'check cancelled — you left the Timing tab mid-run.';
    }
  }

  onHit(hit) {
    if (!hit.aligned) return;
    this.recent.push(hit.devMs);
    const roll = this.recent.slice(-6);
    this.trace.push({
      relT: hit.t - this.session.metro.startTime,
      rolling: roll.reduce((a, b) => a + b, 0) / roll.length,
      dev: hit.devMs,
    });
    const s = summarize(this.recent);
    if (s) {
      this.root.querySelector('#tm-steadiness').innerHTML = `&plusmn;${s.sd.toFixed(0)} MS`;
      this.root.querySelector('#tm-n').textContent = String(s.n);
      const band = store.get('pocketMs');
      const inBand = (100 * this.recent.filter((d) => Math.abs(d) <= band).length) / this.recent.length;
      this.root.querySelector('#tm-band').textContent = `${inBand.toFixed(0)}%`;
      this.root.querySelector('#tm-trend').textContent = this.trendMsPerMin();
      this.root.querySelector('#tm-steady').textContent = `${this.longestSteady().toFixed(0)}s`;
    }
    this.drawChart();
  }

  trendMsPerMin() {
    const t = this.trace;
    if (t.length < 6) return '—';
    const n = t.length;
    const mx = t.reduce((a, p) => a + p.relT, 0) / n;
    const my = t.reduce((a, p) => a + p.dev, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of t) { num += (p.relT - mx) * (p.dev - my); den += (p.relT - mx) ** 2; }
    if (!den) return '—';
    const slope = (num / den) * 60; // ms per minute
    return `${slope >= 0 ? '+' : ''}${slope.toFixed(0)}`;
  }

  longestSteady() {
    const band = store.get('pocketMs');
    let best = 0;
    let startT = null;
    for (const p of this.trace) {
      if (Math.abs(p.dev) <= band) {
        if (startT === null) startT = p.relT;
        best = Math.max(best, p.relT - startT);
      } else startT = null;
    }
    return best;
  }

  drawChart() {
    const cv = this.root.querySelector('#tm-chart');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const w = cv.width;
    const h = cv.height;
    ctx.clearRect(0, 0, w, h);
    const T = theme();
    const band = store.get('pocketMs');
    const yOf = (dev) => h / 2 + (Math.max(-60, Math.min(60, dev)) / 60) * (h / 2 - 16);
    // rushing = early = negative dev = FASTER = up: flip sign
    const yOfFlipped = (dev) => yOf(-dev);
    ctx.fillStyle = 'rgba(58,125,52,.14)';
    ctx.fillRect(0, yOfFlipped(band), w, yOfFlipped(-band) - yOfFlipped(band));
    ctx.strokeStyle = T.ink;
    ctx.setLineDash([8, 7]);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (!this.trace.length) return;
    const totalS = this.lastRun ? this.lastRun.seconds : 30;
    const xOf = (relT) => (relT / totalS) * (w - 20) + 10;
    ctx.strokeStyle = T.ink;
    ctx.lineWidth = 3;
    ctx.beginPath();
    this.trace.forEach((p, i) => {
      const x = xOf(p.relT);
      const y = yOfFlipped(p.rolling);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    for (const p of this.trace) {
      if (Math.abs(p.dev) <= band) continue;
      ctx.fillStyle = T.pink;
      ctx.beginPath();
      ctx.arc(xOf(p.relT), yOfFlipped(p.dev), 5, 0, 7);
      ctx.fill();
    }
    const last = this.trace[this.trace.length - 1];
    ctx.fillStyle = T.pink;
    ctx.beginPath();
    ctx.arc(xOf(last.relT), yOfFlipped(last.rolling), 8, 0, 7);
    ctx.fill();
  }

  onDone(result) {
    this.root.querySelector('#tm-go').innerHTML = 'START HOLD<span class="tri"></span>';
    const final = this.root.querySelector('#tm-final');
    final.classList.remove('hidden');
    if (!result) {
      final.textContent = 'No hits detected — check the mic level meter and try again.';
      return;
    }
    const base = store.get('baseline');
    let verdict = `mean ${result.mean >= 0 ? '+' : ''}${result.mean.toFixed(1)} ms · spread ${result.sd.toFixed(1)} ms · ${result.pocketPct.toFixed(0)}% in pocket (${result.n} hits)${this.lastRun.clickOn ? '' : ' · click OFF after bar 1'}`;
    if (base) {
      const dSd = result.sd - base.sd;
      verdict += ` — baseline spread ${base.sd.toFixed(1)} ms (${dSd >= 0 ? '+' : ''}${dSd.toFixed(1)})`;
    }
    if (result.warning) verdict += ` — NOTE: ${result.warning}`;
    final.textContent = verdict;
    this.lastResult = result;
    this.root.querySelector('#tm-baseline').classList.remove('hidden');
    store.addRun({
      kind: 'timing',
      label: `${this.lastRun.clickOn ? 'steady hold' : 'click-off hold'} ÷${this.lastRun.subdivision}`,
      meter: '4/4',
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
    const b = this.root.querySelector('#tm-baseline');
    b.textContent = 'BASELINE SAVED ✓';
    setTimeout(() => { b.innerHTML = 'SAVE AS MY BASELINE &#10003;'; }, 2000);
  }
}
