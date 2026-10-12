// Calibrate, two steps:
//  1) MIC FLOOR: a live level meter with a threshold line. AUTO SET parks the
//     line just above room noise (drag or arrow keys to fine-tune); hits under
//     the line never count.
//  2) LATENCY: a guided test. The pulse flashes on every click, you hit with
//     it, and the median hit-vs-click offset is this phone's lag, removed from
//     every future hit. Shown as the signed correction ("−8 MS").

import { Metronome } from './metronome.js';
import { store } from './store.js';
import { levelFrac, holdToConfirm } from './theme.js';
import { icon, fmtSigned, nbsp, announce, setRunState } from './ui.js';

const CLICKS = 10;        // total clicks in the test
const IGNORE_FIRST = 2;   // warm-up clicks (find the beat), not scored
const SCORED = CLICKS - IGNORE_FIRST;
const CLICK_S = 0.6;      // 100 BPM: unhurried, unambiguous
const LEAD_S = 3.0;       // 3-2-1 countdown before the first click
const FLASH_S = 0.08;     // how long the pulse stays lit on a click

const DB_MIN = -60;
const DB_MAX = -6;
const SEGMENTS = 24;
const AXIS_DB = [-60, -48, -36, -24, -12, -6];
const MODE_FLOOR = 0.01;  // the detector's own minLevel here: in force while no threshold is set
const NOISE_MS = 2000;    // level held above the threshold this long reads as room noise
const STATUS_MS = 6000;   // a warning stays up at least this long
const PLOT_MS = 100;      // post-test strip axis: ±100 ms

const TEXT = {
  failQuiet: 'The mic barely heard you. Move the phone closer or lower the threshold, then test again.',
  failScattered: 'Hits varied too much to measure lag. One hit per click, then test again.',
  lost: 'Mic lost. Test stopped.',
  how: 'Phone where it sits when you play. Hit the drum on each click.',
  note: 'Stay quiet and tap AUTO SET, or drag the line just above the room noise. Hits under the line never count.',
};

const toDb = (level) => 20 * Math.log10(level);
const fromDb = (db) => 10 ** (db / 20);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const ms = (v) => nbsp(Math.abs(v).toFixed(0), 'ms');
const lateWord = (lag) => (lag >= 0 ? 'late' : 'early');
// the stored value is the measured lag; everything on screen is the correction
const correction = (lag) => fmtSigned(-lag);
const dbLabel = (db) => nbsp(fmtSigned(db), 'dB');

export class CalibrateMode {
  constructor(root, mic) {
    this.root = root;
    this.mic = mic;
    this.running = false;
    this.phase = 'idle';      // idle | testing
    this.outcome = null;      // last finished test this visit: {kind: ok|fail|lost, text, offsets}
    this.liveTrig = null;     // threshold being dragged, not yet stored
    this.el = null;           // meter elements of the current idle render
    this._raf = null;
    this._tick = (now) => this.tick(now);
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    root.dataset.state = 'idle';
    this.render();
    // threshold drag: delegated, so the meter's pointer surface stays a plain
    // extension of the #trig-mark slider rather than a second, nameless control
    root.addEventListener('pointerdown', (e) => this.dragStart(e));
    root.addEventListener('pointermove', (e) => this.dragMove(e));
    root.addEventListener('pointerup', (e) => this.dragEnd(e, true));
    root.addEventListener('pointercancel', (e) => this.dragEnd(e, false));
    mic.addEventListener('onset', (e) => this.onHit(e.detail));
    mic.addEventListener('lost', () => {
      if (!this.running) return;
      this.abort();
      this.outcome = { kind: 'lost', text: TEXT.lost, offsets: [] };
      this.render();
      announce(TEXT.lost);
    });
  }

  activate() {
    this.mic.setDetectorOptions({ refractory: 0.15, threshold: 2.5, minLevel: MODE_FLOOR });
    if (!this.running) this.render(); // store may have changed elsewhere (Settings reset, import)
    if (!this._raf) { this._last = performance.now(); this._raf = requestAnimationFrame(this._tick); }
  }

  deactivate() {
    cancelAnimationFrame(this._raf);
    this._raf = null;
    this.cancelAuto();
    if (this.liveTrig !== null) this.commitThreshold();
    this._drag = null;
    if (this.running) this.abort();
    this.outcome = null;
    this.render({ refocus: false });
  }

  // ---------------------------------------------------------------- threshold
  thresholdLevel() {
    return this.liveTrig ?? (store.get('trigger') || MODE_FLOOR);
  }

  thresholdDb(level = this.thresholdLevel()) {
    return clamp(Math.round(toDb(level)), DB_MIN, DB_MAX);
  }

  previewThreshold(level) {
    this.liveTrig = level;
    this.mic.setTriggerFloor(level);
    this.noiseReset();
    this.paintThreshold();
  }

  commitThreshold() {
    if (this.liveTrig === null) return;
    store.set('trigger', this.liveTrig);
    this.liveTrig = null;
    this.paintClear();
  }

  setThreshold(level) {
    this.previewThreshold(level);
    this.commitThreshold();
  }

  // sample ~0.7 s of room noise and park the threshold a hair above its peak
  autoTrigger() {
    if (this.running || this._autoRaf) return;
    const btn = this.root.querySelector('#trig-auto');
    btn.textContent = 'LISTENING…';
    btn.setAttribute('aria-busy', 'true');
    let peak = 0;
    const t0 = performance.now();
    const sample = () => {
      peak = Math.max(peak, this.mic.level || 0);
      if (performance.now() - t0 < 700) { this._autoRaf = requestAnimationFrame(sample); return; }
      this._autoRaf = null;
      btn.textContent = 'AUTO SET';
      btn.removeAttribute('aria-busy');
      const level = clamp(peak * 1.6, 0.008, fromDb(DB_MAX)); // headroom above the noise floor
      this.setThreshold(level);
      announce(`Threshold ${dbLabel(this.thresholdDb(level))}`);
    };
    this._autoRaf = requestAnimationFrame(sample);
  }

  cancelAuto() {
    if (!this._autoRaf) return;
    cancelAnimationFrame(this._autoRaf);
    this._autoRaf = null;
  }

  clearAll() {
    if (this.running) return;
    store.set('calibrationMs', null);
    store.set('trigger', null);
    this.liveTrig = null;
    this.mic.setTriggerFloor(0);
    this.outcome = null;
    this.render();
  }

  done() {
    if (this.running) return;
    const back = this.root.dataset.returnTo;
    window.__rhythmChecker.nav(back && back !== 'calibrate' ? back : 'home');
  }

  micName() {
    let label = '';
    try {
      const track = this.mic._stream && this.mic._stream.getAudioTracks()[0];
      label = (track && track.label) || '';
    } catch { /* no stream yet */ }
    return label.replace(/^default\s*-\s*/i, '').trim() || 'this phone';
  }

  // ------------------------------------------------------------------- render
  render({ refocus = true } = {}) {
    const testing = this.phase === 'testing';
    const cal = store.get('calibrationMs');
    const hadFocus = refocus && this.root.contains(document.activeElement);
    this.root.innerHTML = `
      <div class="screen cal">
        <div class="title-row">
          <h1 class="stamp">CALIBRATE</h1>
          ${cal === null
    ? '<span class="chip chip--warn" id="cal-status">NEEDS TEST</span>'
    : `<span class="chip chip--ok" id="cal-status">${icon('check')}SET</span>`}
        </div>
        ${testing ? this.testHtml() : this.idleHtml(cal)}
      </div>
      <div class="bar cal-bar">
        ${testing
    ? `<button type="button" id="cal-stop" class="btn btn--primary">${icon('stop')}STOP</button>`
    : `<button type="button" id="cal-done" class="btn btn--secondary">DONE</button>
        <button type="button" id="cal-go" class="btn btn--primary">${cal === null ? 'START THE TEST' : 'TEST AGAIN'}${icon('play')}</button>`}
      </div>`;
    if (testing) this.bindTest();
    else this.bindIdle();
    if (hadFocus) this.root.querySelector('.bar .btn--primary').focus();
  }

  idleHtml(cal) {
    const o = this.outcome;
    let detail = '';
    if (o) detail = o.text;
    else if (cal !== null) detail = `Phone hears itself ${ms(cal)} ${lateWord(cal)}. Applied to every hit.`;
    const keep = o && o.kind === 'fail' && cal !== null
      ? `<span class="chip chip--warn cal-keep">STILL USING ${nbsp(correction(cal), 'ms')} · LAST TEST FAILED</span>`
      : '';
    const hasClear = cal !== null || store.get('trigger') !== null;
    return `
      <section class="cal-hero${cal === null ? ' is-empty' : ''}" aria-labelledby="cal-hero-cap">
        <p class="hero__cap" id="cal-hero-cap">LATENCY</p>
        <p class="hero"><b id="cal-result">${cal === null ? '—' : `${correction(cal)}<span class="unit"> MS</span>`}</b></p>
        ${keep}
        <p id="cal-detail" class="cal-detail${detail ? '' : ' hidden'}">${detail}</p>
      </section>

      <section class="card cal-card" aria-labelledby="cal-step1">
        <div class="cal-head">
          <h2 id="cal-step1"><span class="num-chip">1</span>MIC FLOOR</h2>
          <span class="cal-src" id="cal-src"></span>
        </div>
        <div class="cal-row"><span class="cal-cap">INPUT LEVEL</span><span id="cal-peak" class="cal-peak">PEAK —</span></div>
        <div class="cal-meter" id="cal-meter">
          <span id="trig-label" class="trig-label"></span>
          <div class="level-track" id="level-track" aria-hidden="true">
            <div class="level-bar">
              <div id="cal-level" class="level-segs">${'<i></i>'.repeat(SEGMENTS)}</div>
              <i class="level-peak hidden" id="level-peak"></i>
            </div>
          </div>
          <div id="trig-mark" class="trig-mark" role="slider" tabindex="0" aria-label="Threshold"
            aria-valuemin="${DB_MIN}" aria-valuemax="${DB_MAX}" aria-describedby="cal-note"></div>
          <div class="level-axis" aria-hidden="true">${AXIS_DB.map((db, i) => `<span style="--a:${(db - DB_MIN) / (DB_MAX - DB_MIN)}">${i === 0 ? dbLabel(db) : fmtSigned(db)}</span>`).join('')}</div>
        </div>
        <p class="cal-note" id="cal-note">${TEXT.note}</p>
        <div class="cal-noise" id="cal-noise" role="status"></div>
        <button type="button" id="trig-auto" class="btn btn--secondary cal-auto">AUTO SET</button>
      </section>

      <section class="card cal-card" aria-labelledby="cal-step2">
        <div class="cal-head"><h2 id="cal-step2"><span class="num-chip">2</span>LATENCY</h2></div>
        <div id="lat-body" class="lat-body">
          <p class="cal-how">${TEXT.how}</p>
          ${this.hitsHtml()}
          <button type="button" id="cal-clear" class="btn--quiet hold cal-clear${hasClear ? '' : ' hidden'}"><span class="hold__label">HOLD TO CLEAR</span><span class="cal-clear__sub">latency + threshold</span></button>
        </div>
      </section>`;
  }

  testHtml() {
    return `
      <div class="live live--inline cal-live" role="status">
        <span class="live__box"><i class="live__dot" aria-hidden="true"></i><span class="cal-live__text">TEST · <span id="cal-phase">GET READY</span><span id="cal-togo" aria-hidden="true"></span></span></span>
      </div>
      <section class="card cal-card cal-card--sum" aria-labelledby="cal-step1">
        <h2 id="cal-step1"><span class="num-chip">1</span>MIC FLOOR</h2>
        <span class="cal-sum">THRESHOLD ${dbLabel(this.thresholdDb())}</span>
      </section>
      <section class="card cal-card" aria-labelledby="cal-step2">
        <div class="cal-head"><h2 id="cal-step2"><span class="num-chip">2</span>LATENCY</h2></div>
        <div id="lat-body" class="lat-body lat-body--test">
          <div id="cal-pulse" class="cal-pulse counting" aria-hidden="true">3</div>
          <div id="tap-dots" class="tap-dots" role="img" aria-label="0 of ${SCORED} hits heard">${'<i></i>'.repeat(SCORED)}</div>
        </div>
      </section>`;
  }

  // The 8 scored offsets, drawn as corrections (−offset) so the strip reads in
  // the same sign as the number above it.
  hitsHtml() {
    const o = this.outcome;
    if (!o || !o.offsets.length) return '';
    const n = o.offsets.length;
    const at = (v) => clamp((v + PLOT_MS) / (2 * PLOT_MS), 0, 1);
    const ROWS = [0, -8, 8, -16, 16, -24, 24];
    const rowEnd = ROWS.map(() => -1);
    const dots = o.offsets
      .map((p) => ({ v: -p.ms, kept: p.kept }))
      .sort((a, b) => a.v - b.v)
      .map((p) => {
        const x = at(p.v);
        let row = rowEnd.findIndex((end) => x - end >= 0.03);
        if (row < 0) row = rowEnd.indexOf(Math.min(...rowEnd));
        rowEnd[row] = x;
        const out = p.v < -PLOT_MS ? ' is-out is-low' : p.v > PLOT_MS ? ' is-out is-high' : '';
        return `<i class="hits-dot${p.kept ? '' : ' is-dropped'}${out}" style="--x:${x.toFixed(4)};--dy:${ROWS[row]}px"></i>`;
      }).join('');
    const ok = o.kind === 'ok';
    const med = ok
      ? `<span class="hits-med__label" style="--x:${at(-o.med).toFixed(4)}">${nbsp(correction(o.med), 'ms')}</span>
         <i class="hits-bracket" style="--x0:${at(-o.med - o.spread).toFixed(4)};--x1:${at(-o.med + o.spread).toFixed(4)}"></i>
         <i class="hits-med" style="--x:${at(-o.med).toFixed(4)}"></i>`
      : '';
    const label = `${n} test ${n === 1 ? 'hit' : 'hits'}${ok ? `, median ${nbsp(correction(o.med), 'ms')}, spread ±${ms(o.spread)}` : ''}`;
    return `
      <div class="cal-hits">
        <div class="sec-head"><span class="sec-head__stamp">YOUR ${n} TEST ${n === 1 ? 'HIT' : 'HITS'}</span></div>
        <div class="hits-plot" role="img" aria-label="${label}">
          <i class="hits-base"></i>
          ${[0, 0.25, 0.5, 0.75, 1].map((x) => `<i class="hits-tick" style="--x:${x}"></i>`).join('')}
          <i class="hits-zero" style="--x:0.5"></i>
          ${dots}
          ${med}
          <span class="hits-axis hits-axis--start" style="--x:0">−${PLOT_MS}</span>
          <span class="hits-axis" style="--x:0.25">−${PLOT_MS / 2}</span>
          <span class="hits-axis" style="--x:0.5">0</span>
          <span class="hits-axis" style="--x:0.75">+${PLOT_MS / 2}</span>
          <span class="hits-axis hits-axis--end" style="--x:1">+${nbsp(PLOT_MS, 'ms')}</span>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------------ binding
  bindIdle() {
    const $ = (sel) => this.root.querySelector(sel);
    $('#cal-go').addEventListener('click', () => this.start());
    $('#cal-done').addEventListener('click', () => this.done());
    $('#trig-auto').addEventListener('click', () => this.autoTrigger());
    holdToConfirm($('#cal-clear'), () => this.clearAll(), { label: 'HOLD TO CLEAR' });
    $('#cal-src').textContent = `MIC: ${this.micName()}`;

    this.el = {
      meter: $('#cal-meter'),
      track: $('#level-track'),
      label: $('#trig-label'),
      mark: $('#trig-mark'),
      segs: [...this.root.querySelectorAll('#cal-level i')],
      peakMark: $('#level-peak'),
      peakText: $('#cal-peak'),
      noise: $('#cal-noise'),
      clear: $('#cal-clear'),
    };
    this.lit = -1;
    this.peakDb = -Infinity;
    this.peakAt = 0;
    this.peakShown = undefined;
    this._aboveAt = null;
    this._belowAt = null;
    this._noiseAt = null;
    this.bindSlider(this.el.mark);
    this.paintThreshold();
  }

  bindTest() {
    this.el = null;
    this.root.querySelector('#cal-stop').addEventListener('click', () => this.stop());
  }

  bindSlider(mark) {
    const STEP = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -6, PageUp: 6 };
    mark.addEventListener('keydown', (e) => {
      if (this.running) return;
      let db;
      if (e.key in STEP) db = this.thresholdDb() + STEP[e.key];
      else if (e.key === 'Home') db = DB_MIN;
      else if (e.key === 'End') db = DB_MAX;
      else return;
      e.preventDefault();
      this.setThreshold(fromDb(clamp(db, DB_MIN, DB_MAX)));
    });
  }

  levelAt(clientX) {
    const r = this.el.track.getBoundingClientRect();
    const f = clamp((clientX - r.left - 4) / (r.width - 8), 0, 1);
    return fromDb(Math.round(DB_MIN + f * (DB_MAX - DB_MIN)));
  }

  // A vertical swipe across the meter scrolls the page (touch-action: pan-y
  // hands it to the browser as pointercancel) and must not move the line, so
  // a press only sets it once it moves sideways or lifts in place.
  dragStart(e) {
    const hit = this.el && !this.running && e.target.closest && e.target.closest('#level-track, #trig-mark');
    if (!hit || (e.pointerType === 'mouse' && e.button !== 0)) return;
    hit.setPointerCapture(e.pointerId);
    this._drag = { id: e.pointerId, x0: e.clientX, moved: false };
  }

  dragMove(e) {
    const d = this._drag;
    if (!d || d.id !== e.pointerId || !this.el) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 4) return;
    d.moved = true;
    this.previewThreshold(this.levelAt(e.clientX));
  }

  dragEnd(e, lifted) {
    const d = this._drag;
    if (!d || d.id !== e.pointerId) return;
    this._drag = null;
    if (!this.el) return;
    if (lifted && !d.moved) this.previewThreshold(this.levelAt(e.clientX));
    this.commitThreshold();
  }

  paintThreshold() {
    const el = this.el;
    if (!el) return;
    const level = this.thresholdLevel();
    const f = levelFrac(level);
    const db = this.thresholdDb(level);
    el.meter.style.setProperty('--f', f.toFixed(4));
    el.label.textContent = `THRESHOLD ${dbLabel(db)}`;
    el.label.classList.toggle('is-flip', f > 0.5);
    el.mark.setAttribute('aria-valuenow', String(db));
    el.mark.setAttribute('aria-valuetext', dbLabel(db));
    el.segs.forEach((s, i) => s.classList.toggle('is-above', (i + 0.5) / SEGMENTS > f));
  }

  paintClear() {
    if (!this.el) return;
    const has = store.get('calibrationMs') !== null || store.get('trigger') !== null;
    this.el.clear.classList.toggle('hidden', !has);
  }

  // ------------------------------------------------------------ live meter
  tick(now) {
    this._raf = requestAnimationFrame(this._tick);
    const dt = Math.max(0, now - (this._last || now));
    this._last = now;
    const el = this.el;
    if (!el || this.phase !== 'idle' || !el.meter.isConnected) return;
    const on = this.mic.running;
    const level = on ? this.mic.level || 0 : 0;
    const f = levelFrac(level);

    const lit = clamp(Math.ceil(f * SEGMENTS - 0.5), 0, SEGMENTS);
    if (lit !== this.lit) {
      this.lit = lit;
      el.segs.forEach((s, i) => s.classList.toggle('on', i < lit));
    }

    // one peak drives the tick and the PEAK readout: it holds 1 s, then falls
    // 54 dB/s; under reduced motion it jumps to the current level instead
    const db = level > 0 ? toDb(level) : -Infinity;
    if (db >= this.peakDb) { this.peakDb = db; this.peakAt = now; }
    else if (now - this.peakAt > 1000) {
      if (this.reduceMotion.matches) { this.peakDb = db; this.peakAt = now; }
      else this.peakDb = Math.max(db, this.peakDb - (54 * dt) / 1000);
    }
    const pf = levelFrac(fromDb(this.peakDb));
    el.peakMark.classList.toggle('hidden', pf <= 0);
    el.peakMark.style.setProperty('--p', pf.toFixed(4));
    const shown = on && this.peakDb > -Infinity ? Math.round(this.peakDb) : null;
    if (shown !== this.peakShown) {
      this.peakShown = shown;
      el.peakText.textContent = shown === null ? 'PEAK —' : `PEAK ${dbLabel(shown)}`;
    }

    if (on && !this._autoRaf && !this._drag) this.noiseCheck(level, now);
  }

  noiseCheck(level, now) {
    const above = level > this.thresholdLevel();
    if (above) { this._aboveAt ??= now; this._belowAt = null; } else { this._belowAt ??= now; this._aboveAt = null; }
    const shown = this._noiseAt !== null;
    if (!shown && above && now - this._aboveAt >= NOISE_MS) {
      this._noiseAt = now;
      this.el.noise.innerHTML = '<span class="chip chip--warn">ROOM NOISE ABOVE THRESHOLD</span>';
    } else if (shown && !above && now - this._noiseAt >= STATUS_MS && now - this._belowAt >= NOISE_MS) {
      this.noiseReset();
    }
  }

  noiseReset() {
    this._aboveAt = null;
    this._belowAt = null;
    this._noiseAt = null;
    if (this.el) this.el.noise.replaceChildren();
  }

  // --------------------------------------------------------------------- test
  start() {
    if (this.running || !this.mic.audioContext) return;
    this.cancelAuto();
    this.running = true;
    this.phase = 'testing';
    this.taps = [];
    this.outcome = null;
    this.shownPhase = null;
    this.metro = new Metronome(this.mic.audioContext);
    this.metro.bpm = 60 / CLICK_S;
    this.metro.subdivision = 1;
    this.metro.meter = { pulses: 1, accents: [] };
    this.metro.start(LEAD_S);
    // silence clicks past the scored range: the metronome free-runs until
    // finish(), and unscored clicks after DONE read as dropped hits
    this.metro.muteAfter = this.metro.startTime + CLICKS * CLICK_S - 1e-3;
    this.render();
    setRunState(this.root, 'countin', 'TEST · GET READY');
    this._pulse();
    this._endTimer = setTimeout(() => this.finish(), (LEAD_S + CLICKS * CLICK_S + 0.8) * 1000);
  }

  stop() {
    if (!this.running) return;
    this.abort();
    this.render();
  }

  setPhase(text, togo = '') {
    if (this.shownPhase === text + togo) return;
    this.shownPhase = text + togo;
    const phase = this.root.querySelector('#cal-phase');
    if (phase.textContent !== text) phase.textContent = text;
    this.root.querySelector('#cal-togo').textContent = togo;
  }

  // rAF loop: countdown digit, then a flash on each click, and the phase line
  _pulse() {
    if (!this.running) return;
    const pulse = this.root.querySelector('#cal-pulse');
    const rel = this.mic.now() - this.metro.startTime;
    if (rel < 0) {
      const n = String(Math.max(1, Math.ceil(-rel)));
      if (pulse.textContent !== n) pulse.textContent = n;
      this.setPhase('GET READY');
    } else {
      if (pulse.classList.contains('counting')) {
        pulse.textContent = '';
        pulse.classList.remove('counting');
        setRunState(this.root, 'running', 'TEST · FIND THE BEAT');
      }
      const idx = Math.floor(rel / CLICK_S);
      pulse.classList.toggle('lit', idx < CLICKS && rel - idx * CLICK_S < FLASH_S);
      if (idx < IGNORE_FIRST) this.setPhase('FIND THE BEAT');
      else if (idx >= CLICKS) this.setPhase('DONE');
      else this.setPhase('HIT EACH CLICK', ` · ${CLICKS - idx} TO GO`);
    }
    this._pulseRaf = requestAnimationFrame(() => this._pulse());
  }

  onHit(onset) {
    if (!this.running || !this.root.classList.contains('active')) return;
    const grid = this.metro.nearestGrid(onset.time);
    if (!grid || grid.index >= CLICKS) return;
    const offsetMs = (onset.time - grid.time) * 1000;
    if (Math.abs(offsetMs) > 250) return;
    this.taps.push({ index: grid.index, offsetMs });
    const scored = this.taps.filter((t) => t.index >= IGNORE_FIRST).length;
    const box = this.root.querySelector('#tap-dots');
    if (!box) return;
    box.querySelectorAll('i').forEach((d, i) => d.classList.toggle('on', i < scored));
    box.setAttribute('aria-label', `${Math.min(scored, SCORED)} of ${SCORED} hits heard`);
  }

  abort() {
    this.running = false;
    this.phase = 'idle';
    clearTimeout(this._endTimer);
    cancelAnimationFrame(this._pulseRaf);
    if (this.metro) this.metro.stop();
    setRunState(this.root, 'idle');
  }

  finish() {
    if (!this.running) return;
    this.abort();
    const usable = this.taps.filter((t) => t.index >= IGNORE_FIRST).map((t) => t.offsetMs);
    this.outcome = this.judge(usable);
    this.render();
    announce(this.outcome.text);
  }

  // The median is the latency. Drop the odd flubbed hit so it can't sink an
  // otherwise good test, then judge the spread of the rest against real human
  // hitting (~30-45 ms), not metronome-tight: the median stays reliable well
  // past that.
  judge(usable) {
    const pack = (keep) => usable.map((v) => ({ ms: v, kept: keep ? keep(v) : true }));
    if (usable.length < 4) return { kind: 'fail', text: TEXT.failQuiet, offsets: pack() };
    const m0 = median(usable);
    const keep = (v) => Math.abs(v - m0) <= 90;
    const kept = usable.filter(keep);
    if (kept.length < 4) return { kind: 'fail', text: TEXT.failScattered, offsets: pack(keep) };
    const med = median(kept);
    const spread = Math.sqrt(kept.reduce((a, b) => a + (b - med) ** 2, 0) / kept.length);
    if (spread > 50) {
      return { kind: 'fail', text: `Hits varied ±${ms(spread)}. Too wide to measure lag. One hit per click, then test again.`, offsets: pack(keep) };
    }
    store.set('calibrationMs', med);
    return {
      kind: 'ok',
      med,
      spread,
      text: `Phone hears itself ${ms(med)} ${lateWord(med)} (±${ms(spread)}). Applied to every hit.`,
      offsets: pack(keep),
    };
  }
}
