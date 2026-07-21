// Calibrate, two steps: 1) mic input — live level meter with a draggable
// TRIG floor so room noise never fires a hit; 2) audio latency — tap along
// with clicks, the median offset is this device's lag, subtracted forever.

import { Metronome } from './metronome.js';
import { store } from './store.js';

const CLICKS = 10;
const IGNORE_FIRST = 2;

export class CalibrateMode {
  constructor(root, mic) {
    this.root = root;
    this.mic = mic;
    this.running = false;
    this.peak = 0;
    this.render();
    mic.addEventListener('onset', (e) => this.onHit(e.detail));
  }

  activate() {
    this.mic.setDetectorOptions({ refractory: 0.15, threshold: 4, minLevel: 0.01 });
    if (!this._meterT) {
      this._meterT = setInterval(() => this.drawMeter(), 90);
    }
  }

  deactivate() {
    clearInterval(this._meterT);
    this._meterT = null;
  }

  // level (0..1-ish rms) -> meter fraction, log scale from -60 dB
  frac(level) {
    if (level <= 0) return 0;
    return Math.max(0, Math.min(1, (20 * Math.log10(level) + 60) / 54));
  }

  drawMeter() {
    if (!this.root.classList.contains('active')) return;
    const fill = this.root.querySelector('#cal-level');
    const peakEl = this.root.querySelector('#cal-peak');
    if (!fill) return;
    const lvl = this.mic.level || 0;
    this.peak = Math.max(this.peak * 0.985, lvl);
    fill.style.width = `${(this.frac(lvl) * 100).toFixed(1)}%`;
    peakEl.textContent = lvl > 0 ? `PEAK ${(20 * Math.log10(this.peak)).toFixed(0)} dB` : 'PEAK —';
  }

  render() {
    const cal = store.get('calibrationMs');
    const trig = store.get('trigger');
    const trigPct = trig ? this.frac(trig) * 100 : 18;
    this.root.innerHTML = `
      <div class="status-row" style="align-items:flex-end">
        <div class="title-stamp" style="margin:0">CALIBRATE</div>
        <span class="chip-stamp ${cal === null ? 'warn' : 'set'}">${cal === null ? 'NEEDS TEST' : 'SET'}</span>
      </div>

      <div class="cal-card">
        <div class="cal-head"><span class="num-chip">1</span><b>MIC INPUT</b><span class="cal-spacer"></span><span class="drop" style="pointer-events:none">BUILT-IN MIC &#9662;</span></div>
        <div class="cal-cap" style="display:flex;justify-content:space-between"><span>INPUT LEVEL</span><span id="cal-peak" class="cal-peak">PEAK &mdash;</span></div>
        <div class="trig-wrap">
          <div id="trig-label" class="trig-label" style="left:${trigPct.toFixed(1)}%">TRIG</div>
          <div class="level-track" id="level-track">
            <div id="cal-level" class="level-fill"></div>
            <div class="level-gaps"></div>
            <div id="trig-mark" class="trig-mark" style="left:${trigPct.toFixed(1)}%"></div>
          </div>
        </div>
        <p class="cal-note">Hit the snare a few times — drag TRIG just above the room noise.
        Anything under the line never counts as a hit.</p>
      </div>

      <div class="cal-card lat-card">
        <div class="cal-head"><span class="num-chip">2</span><b>AUDIO LATENCY</b></div>
        <div class="lat-body">
        <div class="lat-diagram">
          <div class="lat-end"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#141210" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>YOU HIT</span></div>
          <div class="lat-line"><div class="lat-dot"></div></div>
          <div class="lat-end"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#141210" stroke-width="2"><rect x="7" y="3" width="10" height="18" rx="1.5"/><line x1="10" y1="18" x2="14" y2="18"/></svg><span>IT HEARS</span></div>
        </div>
        <div id="cal-result" class="lat-result">${cal === null ? '&mdash;' : `${cal >= 0 ? '&#8722;' : '+'}${Math.abs(cal).toFixed(0)}<span> MS</span>`}</div>
        <div id="cal-detail" class="lat-detail">${cal === null ? 'not measured on this device yet' : 'subtracted from every score on this phone'}</div>
        <div class="lat-btn-row"><button id="cal-go" class="btn amber">${cal === null ? 'RUN TEST' : 'RUN TEST AGAIN'}</button></div>
        </div>
      </div>

      <div class="cal-actions">
        <button id="cal-clear" class="btn">RESET</button>
        <button id="cal-done" class="btn green">SAVE &amp; DONE &#10003;</button>
      </div>`;

    this.root.querySelector('#cal-go').addEventListener('click', () => this.start());
    this.root.querySelector('#cal-clear').addEventListener('click', () => {
      store.set('calibrationMs', null);
      store.set('trigger', null);
      this.mic.setTriggerFloor(0);
      this.render();
    });
    this.root.querySelector('#cal-done').addEventListener('click', () => {
      window.__rhythmChecker.nav('home');
    });

    // TRIG drag: pointer events on the track set the detector floor
    const track = this.root.querySelector('#level-track');
    const setTrig = (clientX) => {
      const r = track.getBoundingClientRect();
      const f = Math.max(0.02, Math.min(0.96, (clientX - r.left) / r.width));
      const level = 10 ** ((f * 54 - 60) / 20); // inverse of frac()
      store.set('trigger', level);
      this.mic.setTriggerFloor(level);
      this.root.querySelector('#trig-mark').style.left = `${(f * 100).toFixed(1)}%`;
      this.root.querySelector('#trig-label').style.left = `${(f * 100).toFixed(1)}%`;
    };
    let dragging = false;
    track.addEventListener('pointerdown', (e) => { dragging = true; setTrig(e.clientX); });
    window.addEventListener('pointermove', (e) => { if (dragging) setTrig(e.clientX); });
    window.addEventListener('pointerup', () => { dragging = false; });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.taps = [];
    this.metro = new Metronome(this.mic.audioContext);
    this.metro.bpm = 100;
    this.metro.subdivision = 1;
    this.metro.meter = { pulses: 1, accents: [] };
    this.metro.start(0.5);
    this.root.querySelector('#cal-result').innerHTML = '&hellip;';
    this.root.querySelector('#cal-detail').textContent = `hit each click · 0 / ${CLICKS}`;
    this._endTimer = setTimeout(() => this.finish(), (0.5 + CLICKS * 0.6 + 1) * 1000);
  }

  onHit(onset) {
    if (!this.running || !this.root.classList.contains('active')) return;
    const grid = this.metro.nearestGrid(onset.time);
    if (!grid || grid.index >= CLICKS) return;
    const offsetMs = (onset.time - grid.time) * 1000;
    if (Math.abs(offsetMs) > 250) return;
    this.taps.push({ index: grid.index, offsetMs });
    this.root.querySelector('#cal-detail').textContent = `hit each click · ${this.taps.length} / ${CLICKS}`;
  }

  finish() {
    this.running = false;
    this.metro.stop();
    const usable = this.taps.filter((t) => t.index >= IGNORE_FIRST).map((t) => t.offsetMs);
    const resultEl = this.root.querySelector('#cal-result');
    const detailEl = this.root.querySelector('#cal-detail');
    if (usable.length < 5) {
      resultEl.innerHTML = '&mdash;';
      detailEl.textContent = 'not enough taps — the mic barely heard you. Move it closer and retry.';
      return;
    }
    const sorted = [...usable].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const spread = Math.sqrt(usable.reduce((a, b) => a + (b - median) ** 2, 0) / usable.length);
    if (spread > 25) {
      resultEl.innerHTML = '&mdash;';
      detailEl.textContent = `taps varied ±${spread.toFixed(0)} ms — that's technique noise, not latency. Slower focus, try again.`;
      return;
    }
    store.set('calibrationMs', median);
    resultEl.innerHTML = `${median >= 0 ? '&#8722;' : '+'}${Math.abs(median).toFixed(0)}<span> MS</span>`;
    detailEl.textContent = `saved (tap spread ±${spread.toFixed(0)} ms). Subtracted from every score on this device.`;
    this.root.querySelector('.status-row .chip-stamp').textContent = 'SET';
    this.root.querySelector('.status-row .chip-stamp').classList.remove('warn');
  }
}
