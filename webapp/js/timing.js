// Live timing check: hold a tempo, watch your drift over time, get the
// honest numbers at the end. TimingSession is the headless engine (also
// used for baselines); TimingMode is the steadiness-hold screen.

import { Metronome } from './metronome.js';
import { BleedGuard, summarize } from './dsp.js';
import { store } from './store.js';
import { theme, fitCanvas, holdToConfirm } from './theme.js';
import { wakeLock } from './audio.js';
import {
  icon, fmtSigned, dirWord, offsetText, nbsp, monitorSize, factLine, announce, setRunState, seg,
} from './ui.js';

export class TimingSession extends EventTarget {
  constructor(mic, { bpm, subdivision, seconds, meter = null, clickOn = true, pocketMs = null }) {
    super();
    this.mic = mic;
    this.metro = new Metronome(mic.audioContext);
    this.metro.bpm = bpm;
    this.metro.subdivision = subdivision;
    if (meter) this.metro.meter = meter;
    this.clickOn = clickOn;
    this.seconds = seconds;
    this.pocketMs = pocketMs;
    this.devs = [];
    this.hits = [];
    this.running = false;
    this._onOnset = (e) => this.score(e.detail);
  }

  start() {
    this.running = true;
    this.bleed = new BleedGuard();
    this._lostHandler = () => this.abort('Mic lost.');
    this.mic.addEventListener('lost', this._lostHandler);
    this.mic.lockDetector(this, { refractory: 0.03, threshold: 2.5, minLevel: 0.01 });
    this.mic.addEventListener('onset', this._onOnset);
    wakeLock.acquire();
    this.metro.start();
    if (!this.clickOn) {
      // click-off hold: one audible bar to set the tempo, then silence — the
      // grid keeps running and judging. Can you hold it on your own?
      // (deterministic cutoff on the audio clock: a late setTimeout here used
      // to let an already-scheduled bar-2 click leak through on janky phones)
      const barS = (60 / this.metro.bpm) * this.metro.meter.pulses;
      this.metro.muteAfter = this.metro.startTime + barS - 1e-3;
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
    const band = this.pocketMs ?? store.get('pocketMs');
    const pocket = this.devs.length
      ? (100 * this.devs.filter((d) => Math.abs(d) <= band).length) / this.devs.length
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
    this.metro.stop();
    this.metro.muteAfter = null;
    this.mic.removeEventListener('onset', this._onOnset);
    if (this._lostHandler) this.mic.removeEventListener('lost', this._lostHandler);
    this.mic.unlockDetector(this);
    wakeLock.release();
  }
}

const HOLDS = [30, 60, 120];
const GRIDS = [
  { value: 1, label: 'QUARTERS', word: 'quarters' },
  { value: 2, label: '8THS', word: '8ths' },
  { value: 3, label: 'TRIPLETS', word: 'triplets' },
  { value: 4, label: '16THS', word: '16ths' },
];
const gridOf = (v) => GRIDS.find((g) => g.value === v) || GRIDS[1];

const COUNTIN_BEATS = 2;  // TimingSession ignores every hit before this
const LISTEN_HITS = 6;    // the monitor reads LISTENING until this many hits
const ROLL = 6;           // rolling-mean window on the chart
const DRIFT_FROM_S = 5;
const DRIFT_MIN_S = 10;
const DRIFT_MIN_HITS = 12;
const Y_MAX = 60;
const CHART_W = 340;      // fitCanvas logical width (~1 logical px per CSS px)
const HINT_ON = 'All the way through.';
const HINT_OFF = '1 bar, then silence.';

const mmss = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

let palette = null;
function chartPalette() {
  if (!palette) {
    const T = theme();
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fb) => (cs.getPropertyValue(name) || fb).trim();
    palette = {
      ink: T.ink,
      ink60: T.dim,
      tint: T.panel,
      rule: T.line,
      white: v('--white', '#ffffff'),
      dotStrong: v('--dot-strong', '#6e685f'),
      mono: T.mono,
      label: v('--label-font', "'Oswald', sans-serif"),
    };
  }
  return palette;
}

export class TimingMode {
  constructor(root, mic, nav = null) {
    this.root = root;
    this.mic = mic;
    this.nav = nav || ((name) => window.__rhythmChecker && window.__rhythmChecker.nav(name));
    this.session = null;
    this.bpm = store.get('preferredBpm') || 120;
    this.holdSec = 30;
    this.grid = 2;
    this.clickOn = true;
    this.state = 'idle';
    this.lastRun = null;
    this.lastResult = null;
    this.runPocket = null;   // pocketMs snapshotted at START
    this.trace = [];         // {relT, dev, rolling} for the chart, aligned hits only
    this.recent = [];        // aligned offsets in play order
    this.elapsed = null;     // audio-clock seconds since the grid started, while live
    this.geom = null;
    this.raf = 0;
    this.render();
  }

  get running() {
    return !!(this.session && this.session.running);
  }

  isLiveState() {
    return this.state === 'countin' || this.state === 'running';
  }

  setState(state, label = '') {
    this.state = state;
    setRunState(this.root, state, label);
    this.syncFrame();
  }

  // ------------------------------------------------------------ skeleton
  render() {
    this.root.innerHTML = `
      <div class="screen tm">
        <div class="title-row tm-title">
          <h1 class="stamp">TIMING</h1>
          <div class="tm-title__slot"></div>
        </div>
        <div class="summary tm-lockstrip" role="group" aria-label="Setup locked while playing">
          <span class="tm-sum"></span>
          <span class="summary__lock">${icon('lock')}</span>
        </div>
        <button type="button" class="summary tm-sumbtn"><span class="tm-sum"></span><span class="sr-only">. Edit setup</span></button>

        <div id="tm-final" class="tm-final hidden">
          <div class="card card--ink tm-notice hidden">
            <span class="chip chip--warn">STOPPED · NOT SAVED</span>
            <p class="tm-notice__line"></p>
          </div>
          <div class="tm-result"></div>
          <div class="tm-chart-slot"></div>
          <div class="tm-result-foot"></div>
        </div>

        <div class="setup tm-setup">
          <div class="tc-card tc-tempo">
            <span class="tc-cap" id="tm-tempo-cap">TEMPO</span>
            <button type="button" id="tm-minus" class="tc-step" aria-label="Tempo down 5">−</button>
            <p class="tc-val" aria-live="polite"><b id="tm-bpm">${this.bpm}</b> <span class="tc-unit">BPM</span></p>
            <button type="button" id="tm-plus" class="tc-step" aria-label="Tempo up 5">+</button>
          </div>
          <div class="tc-card tc-hold">
            <p class="tc-cap" id="tm-hold-cap">HOLD</p>
            <div id="tm-hold" role="group" aria-labelledby="tm-hold-cap"></div>
            <p class="tc-cap" id="tm-grid-cap">GRID</p>
            <div id="tm-grid" role="group" aria-labelledby="tm-grid-cap"></div>
          </div>
          <button type="button" class="tc-card tc-click" id="tm-click" role="switch" aria-checked="true" aria-label="Click" aria-describedby="tm-click-hint">
            <span class="tc-click__text">
              <span class="tc-cap">CLICK</span>
              <span class="tc-hint" id="tm-click-hint">${HINT_ON}</span>
            </span>
            <span class="tc-val"><span class="tc-switch" aria-hidden="true"><i></i></span><b>ON</b></span>
          </button>
          <p class="tm-latency hidden" id="tm-latency"></p>
        </div>

        <div class="countin tm-countin" aria-hidden="true">
          <span class="tm-countin__cap">COUNT-IN</span>
          <b id="tm-count">${COUNTIN_BEATS}</b>
          <div class="countin__dots">${'<i></i>'.repeat(COUNTIN_BEATS)}</div>
        </div>
        <div class="monitor tm-monitor is-idle">
          <p class="monitor__cap">SPREAD SO FAR</p>
          <b id="tm-steadiness">—</b>
          <p class="monitor__side" id="tm-steadiness-side"><span class="monitor__wait">LISTENING</span></p>
        </div>
        <p class="tm-avgline" id="tm-avg"></p>

        <div class="tm-chart-home">
          <section class="card tm-chart" aria-labelledby="tm-chart-head">
            <div class="sec-head">
              <h2 class="sec-head__stamp" id="tm-chart-head">EARLY / LATE VS CLICK</h2>
              <span class="sec-head__aside">ms</span>
            </div>
            <p class="tm-legend">
              <span><i class="lg-dot"></i>hit</span>
              <span><i class="lg-dot lg-dot--in"></i>in pocket</span>
              <span><i class="lg-line"></i>line: avg of last ${ROLL}</span>
              <span><i class="lg-band"></i><span class="tm-legend__pocket"></span></span>
              <span>0 = click</span>
            </p>
            <div class="tm-plot">
              <canvas id="tm-chart" width="900" height="420" role="img" aria-label="Early and late chart, no hits yet"></canvas>
              <p class="tm-plot__hint">Play along. Early plots up, late plots down.</p>
            </div>
          </section>
        </div>

        <div class="stat-strip tm-tiles">
          <div class="statbox"><b id="tm-band">—</b><span>IN POCKET</span><em id="tm-band-of"></em></div>
          <div class="statbox"><b id="tm-trend" class="tm-drift">—</b><span id="tm-trend-label">DRIFT</span><em id="tm-trend-dir"></em></div>
          <div class="statbox"><b id="tm-n">0</b><span>HITS</span><em></em></div>
        </div>
      </div>
      <div class="bar">
        <button type="button" id="tm-go" class="btn btn--primary"></button>
      </div>`;

    const $ = (sel) => this.root.querySelector(sel);
    this.el = {
      final: $('#tm-final'),
      notice: $('.tm-notice'),
      noticeLine: $('.tm-notice__line'),
      result: $('.tm-result'),
      slot: $('.tm-chart-slot'),
      foot: $('.tm-result-foot'),
      home: $('.tm-chart-home'),
      chart: $('.tm-chart'),
      cv: $('#tm-chart'),
      hint: $('.tm-plot__hint'),
      pocketLegend: $('.tm-legend__pocket'),
      titleSlot: $('.tm-title__slot'),
      latency: $('#tm-latency'),
      bpm: $('#tm-bpm'),
      minus: $('#tm-minus'),
      plus: $('#tm-plus'),
      click: $('#tm-click'),
      count: $('#tm-count'),
      dots: [...this.root.querySelectorAll('.tm-countin .countin__dots i')],
      monitor: $('.tm-monitor'),
      steadiness: $('#tm-steadiness'),
      side: $('#tm-steadiness-side'),
      avg: $('#tm-avg'),
      band: $('#tm-band'),
      bandOf: $('#tm-band-of'),
      trend: $('#tm-trend'),
      trendLabel: $('#tm-trend-label'),
      trendDir: $('#tm-trend-dir'),
      n: $('#tm-n'),
      bar: $('.bar'),
      go: $('#tm-go'),
    };

    this.holdSeg = seg($('#tm-hold'), HOLDS.map((s) => ({ value: s, label: nbsp(s, 's') })), this.holdSec, (v) => {
      if (this.running) { this.holdSeg.set(this.holdSec); return; }
      this.holdSec = v;
      this.syncSummary();
      this.drawChart();
    });
    this.gridSeg = seg($('#tm-grid'), GRIDS.map((g) => ({ value: g.value, label: g.label })), this.grid, (v) => {
      if (this.running) { this.gridSeg.set(this.grid); return; }
      this.grid = v;
      this.syncSummary();
    });

    this.el.minus.addEventListener('click', () => this.nudge(-5));
    this.el.plus.addEventListener('click', () => this.nudge(5));
    this.el.click.addEventListener('click', () => {
      if (this.running) return;
      this.clickOn = !this.clickOn;
      this.syncClick();
      this.syncSummary();
    });
    this.el.go.addEventListener('click', () => (this.running ? this.stopRun() : this.startRun()));
    $('.tm-sumbtn').addEventListener('click', () => this.editSetup());

    fitCanvas(this.el.cv, CHART_W, ({ w, h, cssPerLogical }) => {
      this.geom = { w, h, s: cssPerLogical };
      this.drawChart();
    });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.drawChart());

    this.syncBpm();
    this.syncClick();
    this.syncSummary();
    this.syncCalibration();
    this.syncLegend();
    this.setState('idle');
  }

  // --------------------------------------------------------- setup state
  activate() {
    this.mic.setDetectorOptions({ refractory: 0.03, threshold: 2.5, minLevel: 0.01 });
    // a session torn down from outside (never through STOP) leaves no live run
    if (this.isLiveState() && !this.running) {
      this.stopLoop();
      this.session = null;
      this.clearLive();
      this.setState('idle');
    }
    this.refresh();
  }

  // re-read what Settings, an import, RESET ALL, Calibrate or a player feel
  // may have changed; the shell calls this after each (activate() too)
  refresh() {
    if (!this.running) {
      this.bpm = store.get('preferredBpm') || 120;
      this.syncBpm();
      this.syncSummary();
    }
    this.syncCalibration();
    this.syncLegend();
    this.drawChart();
  }

  // the result's summary strip: back to setup. The strip itself is hidden in
  // idle, so focus moves to the first setup control instead of <body>.
  editSetup() {
    if (this.running) return;
    this.clearResult();
    this.setState('idle');
    const main = this.root.closest('main');
    if (main) main.scrollTop = 0;
    const first = this.root.querySelector('.tm-setup button:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }

  deactivate() {
    if (!this.running) return;
    this.session.cancel();
    this.session = null;
    this.stopLoop();
    this.clearLive();
    this.showNotice('Hold cancelled. You left mid-run. Not saved.');
    this.setState('idle');
  }

  nudge(d) {
    if (this.running) return;
    const next = Math.max(20, Math.min(400, this.bpm + d));
    if (next === this.bpm) return;
    this.bpm = next;
    store.set('preferredBpm', this.bpm);
    this.syncBpm();
    this.syncSummary();
  }

  syncBpm() {
    if (this.el.bpm.textContent !== String(this.bpm)) this.el.bpm.textContent = String(this.bpm);
    this.el.minus.disabled = this.bpm <= 20;
    this.el.plus.disabled = this.bpm >= 400;
  }

  syncClick() {
    const b = this.el.click;
    b.setAttribute('aria-checked', String(this.clickOn));
    b.classList.toggle('on', this.clickOn);
    b.querySelector('.tc-val b').textContent = this.clickOn ? 'ON' : 'OFF';
    b.querySelector('.tc-hint').textContent = this.clickOn ? HINT_ON : HINT_OFF;
  }

  // the setup a run used (or will use), one line
  syncSummary() {
    const r = (this.isLiveState() || this.state === 'result') && this.lastRun
      ? this.lastRun
      : { bpm: this.bpm, subdivision: this.grid, seconds: this.holdSec, clickOn: this.clickOn };
    const sep = '<span class="summary__sep">·</span>';
    const html = [nbsp(r.bpm, 'BPM'), gridOf(r.subdivision).label, nbsp(r.seconds, 's'), `CLICK ${r.clickOn ? 'ON' : 'OFF'}`]
      .map((t) => `<span>${t}</span>`).join(sep);
    this.root.querySelectorAll('.tm-sum').forEach((el) => { el.innerHTML = html; });
  }

  syncCalibration() {
    const cal = store.get('calibrationMs');
    const lat = this.el.latency;
    lat.classList.toggle('hidden', cal === null);
    if (cal !== null) lat.textContent = `Latency ${nbsp(fmtSigned(-cal, 0), 'ms')} applied to every hit.`;
    this.syncTitleSlot();
  }

  syncTitleSlot() {
    const slot = this.el.titleSlot;
    if (this.state === 'result' && this.lastResult) {
      slot.innerHTML = `<span class="chip chip--ok">${icon('check')}SAVED TO HISTORY</span>`;
      return;
    }
    if (store.get('calibrationMs') === null) {
      if (!slot.querySelector('#tm-cal-nag')) {
        slot.innerHTML = '<button type="button" id="tm-cal-nag" class="chip-btn chip--warn">NOT CALIBRATED · FIX</button>';
        slot.querySelector('#tm-cal-nag').addEventListener('click', () => { if (!this.running) this.nav('calibrate'); });
      }
      return;
    }
    slot.replaceChildren();
  }

  pocketForChart() {
    return this.state === 'result' || this.isLiveState()
      ? (this.runPocket ?? store.get('pocketMs'))
      : store.get('pocketMs');
  }

  syncLegend() {
    const text = `pocket ±${nbsp(this.pocketForChart(), 'ms')}`;
    if (this.el.pocketLegend.textContent !== text) this.el.pocketLegend.textContent = text;
  }

  // what is shown for the current state: bar buttons, notice, chart home
  syncFrame() {
    const { go } = this.el;
    if (this.isLiveState()) go.innerHTML = `${icon('stop')}STOP`;
    else if (this.state === 'result') go.innerHTML = `START AGAIN${icon('play')}`;
    else go.innerHTML = `START HOLD${icon('play')}`;
    if (this.state !== 'result') this.removeBaselineButton();
    const inResult = this.state === 'result' && this.lastResult;
    const target = inResult ? this.el.slot : this.el.home;
    if (this.el.chart.parentElement !== target) target.appendChild(this.el.chart);
    const noticeOn = !this.el.notice.classList.contains('hidden');
    this.el.final.classList.toggle('hidden', !noticeOn && this.state !== 'result');
    this.syncTitleSlot();
    this.syncSummary();
    this.syncLegend();
    this.drawChart();
  }

  showNotice(line) {
    this.el.noticeLine.textContent = line;
    this.el.notice.classList.remove('hidden');
  }

  hideNotice() {
    this.el.notice.classList.add('hidden');
    this.el.noticeLine.textContent = '';
  }

  clearResult() {
    this.lastResult = null;
    this.el.result.replaceChildren();
    this.el.foot.replaceChildren();
    this.trace = [];
    this.recent = [];
    this.el.cv.setAttribute('aria-label', 'Early and late chart, no hits yet');
  }

  // ------------------------------------------------------------- the run
  startRun() {
    if (this.running) return;
    this.lastRun = { bpm: this.bpm, subdivision: this.grid, seconds: this.holdSec, clickOn: this.clickOn };
    this.runPocket = store.get('pocketMs');
    this.hideNotice();
    this.clearResult();
    this.clearLive();
    const session = new TimingSession(this.mic, { ...this.lastRun, pocketMs: this.runPocket });
    this.session = session;
    session.addEventListener('hit', (e) => { if (this.session === session) this.onHit(e.detail); });
    session.addEventListener('done', (e) => { if (this.session === session) this.onDone(e.detail); });
    session.addEventListener('aborted', () => { if (this.session === session) this.onAborted(); });
    session.start();
    this.lastLeft = null;
    this.lastSaid = null;
    this.elapsed = 0;
    this.setState('countin', `COUNT-IN · ${nbsp(this.lastRun.bpm, 'BPM')}`);
    this.el.cv.setAttribute('aria-label', 'Early and late chart, live');
    announce(`Count-in. ${COUNTIN_BEATS}, 1.`);
    this.startLoop();
  }

  stopRun() {
    const s = this.session;
    if (!s || !s.running) return;
    const at = Math.min(s.seconds, Math.max(0, this.mic.now() - s.metro.startTime));
    s.cancel();
    this.session = null;
    this.stopLoop();
    this.clearLive();
    const line = `Stopped at ${mmss(at)}. Not saved.`;
    this.showNotice(line);
    this.setState('stopped');
    announce(line);
  }

  onAborted() {
    this.session = null;
    this.stopLoop();
    this.clearLive();
    this.showNotice('Hold stopped: mic lost. Not saved.');
    this.setState('stopped');
  }

  startLoop() {
    this.stopLoop();
    const tick = () => {
      this.raf = 0;
      if (!this.frame()) return;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stopLoop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  // one animation frame of a live run; false ends the loop
  frame() {
    const s = this.session;
    if (!s || !s.running) {
      if (this.isLiveState()) {
        this.session = null;
        this.clearLive();
        this.setState('idle');
      }
      return false;
    }
    const metro = s.metro;
    const beat = 60 / metro.bpm;
    const rel = this.mic.now() - metro.startTime;
    this.elapsed = Math.max(0, rel);
    if (this.state === 'countin') {
      if (rel >= COUNTIN_BEATS * beat) {
        this.setState('running', this.liveLabel(s, rel));
      } else {
        const k = rel < 0 ? -1 : Math.floor(rel / beat);
        const digit = String(COUNTIN_BEATS - Math.max(0, k));
        if (this.el.count.textContent !== digit) this.el.count.textContent = digit;
        this.el.dots.forEach((d, i) => d.classList.toggle('on', i <= k));
      }
    } else if (this.state === 'running') {
      const left = Math.ceil(Math.max(0, s.seconds - rel));
      if (left !== this.lastLeft && left % 5 === 0) setRunState(this.root, 'running', this.liveLabel(s, rel));
      // one spoken update per 10 s of hold, never per hit
      const slot = Math.floor(rel / 10);
      if (this.lastSaid === null) this.lastSaid = slot;
      else if (slot !== this.lastSaid && this.recent.length >= LISTEN_HITS) {
        this.lastSaid = slot;
        const st = summarize(this.recent);
        announce(`${mmss(left)} left. Spread ${nbsp(Math.round(st.sd), 'ms')}. ${this.avgWords(st.mean)}.`);
      }
    }
    this.drawChart();
    return true;
  }

  liveLabel(s, rel) {
    this.lastLeft = Math.ceil(Math.max(0, s.seconds - rel));
    return `LIVE · ${mmss(this.lastLeft)} LEFT`;
  }

  avgWords(mean) {
    return `Average ${offsetText(mean, 0)}`;
  }

  clearLive() {
    this.trace = [];
    this.recent = [];
    this.elapsed = null;
    this.el.count.textContent = String(COUNTIN_BEATS);
    this.el.dots.forEach((d) => d.classList.remove('on'));
    this.showListening();
    this.el.avg.innerHTML = '<span aria-hidden="true">AVG</span><span class="sr-only">Average</span> —';
    this.el.band.textContent = '—';
    this.el.bandOf.textContent = '';
    this.setDriftTile(this.el.trend, this.el.trendLabel, this.el.trendDir, null);
    this.el.n.textContent = '0';
    this.drawChart();
  }

  showListening() {
    const { monitor, steadiness, side } = this.el;
    monitor.classList.add('is-idle');
    steadiness.textContent = '—';
    steadiness.style.removeProperty('--mon-fs');
    side.innerHTML = '<span class="monitor__wait">LISTENING</span>';
  }

  onHit(hit) {
    if (!hit.aligned) return;
    const relT = hit.t - this.session.metro.startTime;
    this.recent.push(hit.devMs);
    const roll = this.recent.slice(-ROLL);
    this.trace.push({ relT, dev: hit.devMs, rolling: roll.reduce((a, b) => a + b, 0) / roll.length });
    const s = summarize(this.recent);
    const pocket = this.runPocket;
    const k = this.recent.filter((d) => Math.abs(d) <= pocket).length;
    this.el.band.innerHTML = `${Math.round((100 * k) / s.n)}<i class="unit">%</i>`;
    this.el.bandOf.textContent = `${k} of ${s.n}`;
    this.el.n.textContent = String(s.n);
    this.setDriftTile(this.el.trend, this.el.trendLabel, this.el.trendDir, this.drift(Math.max(this.elapsed || 0, relT)));
    if (s.n < LISTEN_HITS) return;
    const sd = String(Math.round(s.sd));
    const { monitor, steadiness, side } = this.el;
    monitor.classList.remove('is-idle');
    steadiness.innerHTML = `<span aria-hidden="true">±${sd}</span><span class="sr-only">plus or minus ${sd}</span>`;
    steadiness.style.setProperty('--mon-fs', `${monitorSize(`±${sd}`)}px`);
    if (!side.querySelector('.unit')) side.innerHTML = '<span class="unit">ms</span>';
    this.el.avg.innerHTML = `<span aria-hidden="true">AVG</span><span class="sr-only">Average</span> ${offsetText(s.mean, 0, { upper: true })}`;
  }

  // least-squares slope of offsets over time, from 5 s on, in ms per minute
  drift(elapsed) {
    const pts = this.trace.filter((p) => p.relT >= DRIFT_FROM_S);
    if (elapsed < DRIFT_MIN_S || pts.length < DRIFT_MIN_HITS) return null;
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p.relT, 0) / n;
    const my = pts.reduce((a, p) => a + p.dev, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of pts) { num += (p.relT - mx) * (p.dev - my); den += (p.relT - mx) ** 2; }
    return den ? (num / den) * 60 : null;
  }

  // DRIFT tile: "{±x} ms/min" over the label DRIFT, the direction on its own
  // sub-line ("later" / "earlier"), so neither is cut on a narrow phone
  setDriftTile(valueEl, labelEl, dirEl, drift) {
    labelEl.textContent = 'DRIFT';
    if (drift === null) {
      valueEl.textContent = '—';
      valueEl.classList.remove('is-long');
      dirEl.textContent = '';
      return;
    }
    const txt = fmtSigned(drift, 0);
    valueEl.innerHTML = `${txt}<i class="unit">ms/min</i>`;
    valueEl.classList.toggle('is-long', txt.length >= 3);
    // the word follows the number as shown: a drift that reads 0 has no direction
    const word = dirWord(drift, 0);
    dirEl.textContent = word ? (word === 'late' ? 'later' : 'earlier') : '';
  }

  longestInPocket() {
    const band = this.runPocket;
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

  // ---------------------------------------------------------- the result
  onDone(result) {
    this.session = null;
    this.stopLoop();
    this.elapsed = null;
    this.lastResult = result;
    if (!result) {
      this.el.result.innerHTML = '<div class="card tm-note"><p class="t-body">No hits heard. Check the mic meter and try again.</p></div>';
      this.el.foot.replaceChildren();
      this.setState('result');
      announce('No hits heard.');
      return;
    }
    const run = this.lastRun;
    store.addRun({
      kind: 'timing',
      label: `Hold · ${gridOf(run.subdivision).word} · click ${run.clickOn ? 'on' : 'off'}`,
      meter: '4/4',
      bpmStart: run.bpm,
      bpmEnd: run.bpm,
      n: result.n,
      mean: +result.mean.toFixed(2),
      sd: +result.sd.toFixed(2),
      pocketPct: +result.pocketPct.toFixed(1),
      unaligned: result.unaligned,
    });
    this.renderResult(result);
    this.setState('result');
    this.renderBaselineButton();
    const main = this.root.closest('main');
    if (main) main.scrollTop = 0;
    announce(this.el.cv.getAttribute('aria-label'));
  }

  renderResult(r) {
    const pocket = this.runPocket;
    const sdText = r.sd.toFixed(1);
    const vs = this.baselineLine(sdText);
    const drift = this.drift(this.lastRun.seconds);
    const fact = factLine('timing', { offsets: this.recent, pocketMs: pocket, drift });
    const heroSize = sdText.length + 1 > 5 ? ' tm-hero__num--long' : '';
    this.el.result.innerHTML = `
      <div class="hero tm-hero">
        <p class="hero__cap">SPREAD · ${r.n} ${r.n === 1 ? 'HIT' : 'HITS'}</p>
        <p class="tm-hero__num${heroSize}"><b><span aria-hidden="true">±${sdText}</span><span class="sr-only">plus or minus ${sdText}</span></b><span class="unit">ms</span></p>
        <p class="hero__def">How tightly the hits group.</p>
      </div>
      ${vs}
      <p class="fact" role="status">${fact}</p>`;

    const avg = Math.abs(r.mean).toFixed(0);
    const avgDir = dirWord(r.mean, 0);
    const avgWord = avgDir ? ` ${avgDir.toUpperCase()}` : '';
    const k = this.recent.filter((d) => Math.abs(d) <= pocket).length;
    const longest = Math.round(this.longestInPocket());
    const foot = [`Longest in pocket <span id="tm-steady">${nbsp(longest, 's')}</span>`,
      `${plural(r.unaligned, 'off-grid hit')} not counted`];
    if (!this.lastRun.clickOn) foot.push('click off after bar 1');
    this.el.foot.innerHTML = `
      <div class="stat-strip tm-rtiles">
        <div class="statbox"><b>${avg}<i class="unit">ms</i></b><span aria-hidden="true">AVG${avgWord}</span><em class="sr-only">average${avgWord.toLowerCase()}</em></div>
        <div class="statbox"><b>${Math.round(r.pocketPct)}<i class="unit">%</i></b><span>IN POCKET</span><em>${k} of ${r.n}</em></div>
        <div class="statbox"><b class="tm-drift tm-rdrift">—</b><span class="tm-rdrift-label">DRIFT</span><em class="tm-rdrift-dir"></em></div>
      </div>
      ${r.warning ? '<div class="card tm-note"><p class="t-body tm-note__text"></p></div>' : ''}
      <p class="tm-foot">${foot.join(' · ')}</p>`;
    if (r.warning) this.el.foot.querySelector('.tm-note__text').textContent = r.warning;
    const $f = (sel) => this.el.foot.querySelector(sel);
    this.setDriftTile($f('.tm-rdrift'), $f('.tm-rdrift-label'), $f('.tm-rdrift-dir'), drift);

    this.el.cv.setAttribute('aria-label', `Spread ${nbsp(sdText, 'ms')}, average ${offsetText(r.mean, 0)}, ${Math.round(r.pocketPct)}% in pocket`);
  }

  // The stored baseline beside this run's spread. A wider/tighter figure only
  // when the baseline was held at this run's tempo and grid; otherwise the
  // baseline is shown with its own tempo and nothing is compared. `name` is
  // the chip's word: BASELINE, or WAS once this run has replaced it.
  baselineLine(sdText, base = store.get('baseline'), name = 'BASELINE') {
    if (!base || !Number.isFinite(base.sd)) return '';
    const run = this.lastRun;
    const baseSd = base.sd.toFixed(1);
    const chip = `${name} ±${nbsp(baseSd, 'ms')}`;
    if (run && base.bpm === run.bpm && base.subdivision === run.subdivision) {
      // the two figures as shown, so the difference always matches the screen
      const delta = Number(sdText) - Number(baseSd);
      const diff = Math.abs(delta) < 0.05
        ? (name === 'BASELINE' ? 'SAME AS BASELINE' : 'SAME SPREAD')
        : `${nbsp(Math.abs(delta).toFixed(1), 'ms')} ${delta < 0 ? 'tighter' : 'wider'}`;
      // (the space keeps the two read as separate words; flex drops it visually)
      return `<p class="tm-vs"><span class="chip">${chip}</span> <span class="tm-vs__delta">${diff}</span></p>`;
    }
    const at = [];
    if (Number.isFinite(base.bpm)) at.push(nbsp(base.bpm, 'BPM'));
    const grid = GRIDS.find((g) => g.value === base.subdivision);
    if (grid && (!run || grid.value !== run.subdivision)) at.push(grid.label);
    return `<p class="tm-vs"><span class="chip tm-vs__chip">${chip}${at.length ? ` AT ${at.join(' · ')}` : ''}</span></p>`;
  }

  removeBaselineButton() {
    const b = this.root.querySelector('#tm-baseline');
    if (b) b.remove();
  }

  // first baseline: a tap; replacing one: a hold
  renderBaselineButton() {
    this.removeBaselineButton();
    if (!this.lastResult) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.id = 'tm-baseline';
    b.className = 'btn btn--secondary tm-baseline';
    this.el.bar.insertBefore(b, this.el.go);
    if (store.get('baseline')) {
      b.classList.add('hold');
      b.innerHTML = '<span class="tm-baseline__main">BASELINE</span><span class="btn__sub hold__label">HOLD TO REPLACE</span>';
      holdToConfirm(b, () => this.saveBaseline(), { label: 'HOLD TO REPLACE' });
    } else {
      b.innerHTML = '<span class="tm-baseline__main">SET BASELINE</span>';
      b.addEventListener('click', () => this.saveBaseline());
    }
  }

  saveBaseline() {
    const r = this.lastResult;
    const b = this.root.querySelector('#tm-baseline');
    if (!r || !b || b.classList.contains('is-set')) return;
    const replaced = store.get('baseline');
    store.set('baseline', {
      bpm: this.lastRun.bpm,
      subdivision: this.lastRun.subdivision,
      mean: r.mean,
      sd: r.sd,
      pocketPct: r.pocketPct,
      date: new Date().toISOString().slice(0, 10),
    });
    // a fresh node: the hold listeners stay with the old one
    const set = document.createElement('button');
    set.type = 'button';
    set.id = 'tm-baseline';
    set.className = 'btn btn--secondary tm-baseline is-set';
    set.setAttribute('aria-disabled', 'true');
    set.innerHTML = `<span class="tm-baseline__main">BASELINE SET</span><span class="btn__sub">${icon('check')}today</span>`;
    b.replaceWith(set);
    // this run is the baseline now: the line above names the one it replaced
    const vs = this.el.result.querySelector('.tm-vs');
    if (vs) {
      const was = this.baselineLine(r.sd.toFixed(1), replaced, 'WAS');
      if (was) vs.outerHTML = was;
      else vs.remove();
    }
    set.focus();
    announce(`Baseline set: ±${nbsp(r.sd.toFixed(1), 'ms')}.`);
  }

  // ------------------------------------------------------------ the chart
  // y: −60…+60 ms, early (negative) up; x: 0…hold seconds of audio clock
  drawChart() {
    const g = this.geom;
    const cv = this.el && this.el.cv;
    if (!g || !cv) return;
    const ctx = cv.getContext('2d');
    const P = chartPalette();
    const u = 1 / g.s; // logical units per CSS px
    const { w, h } = g;
    ctx.clearRect(0, 0, w, h);

    const live = this.isLiveState();
    const total = (live || this.state === 'result') && this.lastRun ? this.lastRun.seconds : this.holdSec;
    const pocket = this.pocketForChart();
    const L = 34 * u;
    const R = w - 8 * u;
    const TOP = 9 * u;
    const BOT = h - 22 * u;
    const clampDev = (d) => Math.max(-Y_MAX, Math.min(Y_MAX, d));
    const yOf = (d) => TOP + ((clampDev(d) + Y_MAX) / (2 * Y_MAX)) * (BOT - TOP);
    const xOf = (t) => L + Math.max(0, Math.min(1, t / total)) * (R - L);
    const mono = (size, weight = 400) => `${weight} ${size * u}px ${P.mono}`;

    // pocket band with hairline edges
    ctx.fillStyle = P.tint;
    ctx.fillRect(L, yOf(-pocket), R - L, yOf(pocket) - yOf(-pocket));
    ctx.strokeStyle = 'rgba(20, 18, 16, .3)';
    ctx.lineWidth = u;
    for (const d of [-pocket, pocket]) {
      ctx.beginPath();
      ctx.moveTo(L, Math.round(yOf(d) / u) * u + 0.5 * u);
      ctx.lineTo(R, Math.round(yOf(d) / u) * u + 0.5 * u);
      ctx.stroke();
    }

    // y gridlines + tick labels; a short plot (a 640-tall phone, live) labels
    // every other line so the 11 px ticks never touch
    ctx.font = mono(11);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const labelEvery = (BOT - TOP) / u < 110 ? 40 : 20;
    for (let d = -Y_MAX; d <= Y_MAX; d += 20) {
      const y = yOf(d);
      if (d !== 0) {
        ctx.strokeStyle = P.rule;
        ctx.lineWidth = u;
        ctx.beginPath();
        ctx.moveTo(L, y);
        ctx.lineTo(R, y);
        ctx.stroke();
      }
      if (d % labelEvery !== 0) continue;
      ctx.fillStyle = P.ink60;
      ctx.fillText(fmtSigned(d, 0), L - 6 * u, y);
    }
    // zero = the click
    ctx.strokeStyle = P.ink;
    ctx.lineWidth = 2 * u;
    ctx.beginPath();
    ctx.moveTo(L, yOf(0));
    ctx.lineTo(R, yOf(0));
    ctx.stroke();

    // x ticks every 10 s; labels thinned so they never collide
    ctx.font = mono(11);
    ctx.textBaseline = 'alphabetic';
    const labelW = ctx.measureText(nbsp(total, 's')).width;
    const step = [10, 20, 30, 60].find((st) => (st / total) * (R - L) >= labelW + 16 * u) || 60;
    ctx.strokeStyle = P.ink;
    ctx.lineWidth = u;
    const labels = [];
    for (let t = 0; t <= total + 1e-6; t += 10) {
      const x = xOf(t);
      ctx.beginPath();
      ctx.moveTo(x, BOT);
      ctx.lineTo(x, BOT + 4 * u);
      ctx.stroke();
      if (t % step === 0) labels.push({ t, x });
    }
    const span = (l) => {
      const tw = ctx.measureText(nbsp(l.t, 's')).width;
      const left = l.t === 0 ? l.x : l.t >= total ? l.x - tw : l.x - tw / 2;
      return [left, left + tw];
    };
    const end = labels.length ? span(labels[labels.length - 1]) : [Infinity, Infinity];
    let right = -Infinity;
    ctx.fillStyle = P.ink60;
    labels.forEach((l, i) => {
      const [a, b] = span(l);
      const last = i === labels.length - 1;
      if (!last && (a < right + 6 * u || b > end[0] - 6 * u)) return;
      ctx.textAlign = l.t === 0 ? 'left' : l.t >= total ? 'right' : 'center';
      ctx.fillText(nbsp(l.t, 's'), l.x, h - 4 * u);
      right = b;
    });
    ctx.strokeStyle = P.ink;
    ctx.beginPath();
    ctx.moveTo(L, BOT + 0.5 * u);
    ctx.lineTo(R, BOT + 0.5 * u);
    ctx.stroke();

    // direction words, drawn under the data so no hit is ever hidden
    ctx.font = `700 ${13 * u}px ${P.label}`;
    ctx.fillStyle = P.ink;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    const tri = (x, y, up) => {
      const s = 4.5 * u;
      ctx.beginPath();
      if (up) { ctx.moveTo(x - s, y + s); ctx.lineTo(x + s, y + s); ctx.lineTo(x, y - s); }
      else { ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y - s); ctx.lineTo(x, y + s); }
      ctx.closePath();
      ctx.fill();
    };
    // an empty, idle plot shows the hint instead, which says the same thing
    if (live || this.trace.length) {
      const earlyW = ctx.measureText('EARLY').width;
      ctx.fillText('EARLY', R - 4 * u, TOP + 8 * u);
      tri(R - 4 * u - earlyW - 9 * u, TOP + 8 * u + 6.5 * u, true);
      ctx.textBaseline = 'bottom';
      const lateW = ctx.measureText('LATE').width;
      ctx.fillText('LATE', R - 4 * u, BOT - 8 * u);
      tri(R - 4 * u - lateW - 9 * u, BOT - 8 * u - 6.5 * u, false);
    }

    // elapsed cursor while live: real audio-clock time, not decoration
    if (this.state === 'running' && this.elapsed !== null) {
      const x = xOf(this.elapsed);
      ctx.strokeStyle = 'rgba(20, 18, 16, .3)';
      ctx.lineWidth = u;
      ctx.beginPath();
      ctx.moveTo(x, TOP);
      ctx.lineTo(x, BOT);
      ctx.stroke();
    }

    const pts = this.trace;
    this.el.hint.classList.toggle('hidden', live || pts.length > 0);
    if (!pts.length) return;

    // every counted hit; beyond ±60 a hit becomes an arrowhead astride the edge
    for (const p of pts) {
      const x = xOf(p.relT);
      if (Math.abs(p.dev) > Y_MAX) {
        ctx.fillStyle = P.ink;
        tri(x, p.dev < 0 ? TOP : BOT, p.dev < 0);
        continue;
      }
      const inPocket = Math.abs(p.dev) <= pocket;
      ctx.beginPath();
      ctx.arc(x, yOf(p.dev), (inPocket ? 2.6 : 3.2) * u, 0, Math.PI * 2);
      ctx.fillStyle = inPocket ? P.dotStrong : P.ink;
      ctx.fill();
      if (inPocket) {
        ctx.strokeStyle = P.white;
        ctx.lineWidth = u;
        ctx.stroke();
      }
    }

    // rolling mean of the last 6
    ctx.strokeStyle = P.ink;
    ctx.lineWidth = 2 * u;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = xOf(p.relT);
      const y = yOf(p.rolling);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    if (live) {
      const last = pts[pts.length - 1];
      ctx.beginPath();
      ctx.arc(xOf(last.relT), yOf(last.dev), 5 * u, 0, Math.PI * 2);
      ctx.fillStyle = P.ink;
      ctx.fill();
      ctx.strokeStyle = P.white;
      ctx.lineWidth = 2 * u;
      ctx.stroke();
    }
  }
}
