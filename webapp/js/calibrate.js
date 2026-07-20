// Latency calibration: the phone's mic + audio stack delays everything by a
// constant amount. Tap along with clicks; the median tap-vs-click offset IS
// that delay, and it gets subtracted from every future score.

import { Metronome } from './metronome.js';
import { store } from './store.js';

const CLICKS = 10;
const IGNORE_FIRST = 2;

export class CalibrateMode {
  constructor(root, mic) {
    this.root = root;
    this.mic = mic;
    this.running = false;
    this.render();
    mic.addEventListener('onset', (e) => this.onHit(e.detail));
  }

  activate() {
    this.mic.setDetectorOptions({ refractory: 0.15, threshold: 4, minLevel: 0.01 });
  }

  render() {
    const cal = store.get('calibrationMs');
    this.root.innerHTML = `
      <div class="explain">
        <p>Your device hears itself late by a fixed amount. To measure it:
        put the phone near the drum, press start, and <b>hit the drum exactly on
        each click</b> — ${CLICKS} clicks, the first ${IGNORE_FIRST} are warm-up.</p>
        <p>Play as tight as you can: the measurement uses the median, so one
        flubbed tap won't ruin it.</p>
      </div>
      <div class="big-read">
        <div id="cal-status" class="huge">${cal === null ? 'not calibrated' : `${cal.toFixed(0)} ms`}</div>
        <div id="cal-detail" class="mid">${cal === null ? '' : 'currently subtracted from every score'}</div>
      </div>
      <div class="row">
        <button id="cal-go" class="primary">Start calibration</button>
        <button id="cal-clear">Clear</button>
      </div>`;
    this.root.querySelector('#cal-go').addEventListener('click', () => this.start());
    this.root.querySelector('#cal-clear').addEventListener('click', () => {
      store.set('calibrationMs', null);
      this.render();
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.taps = [];
    this.metro = new Metronome(this.mic.audioContext);
    this.metro.bpm = 100; // 600 ms apart: unhurried, unambiguous
    this.metro.subdivision = 1;
    this.metro.accentEvery = 1000;
    this.metro.start(0.5);
    this.root.querySelector('#cal-status').textContent = 'hit each click';
    this.root.querySelector('#cal-detail').textContent = `0 / ${CLICKS}`;
    this._endTimer = setTimeout(() => this.finish(), (0.5 + CLICKS * 0.6 + 1) * 1000);
  }

  onHit(onset) {
    if (!this.running || !this.root.classList.contains('active')) return;
    const grid = this.metro.nearestGrid(onset.time);
    if (!grid || grid.index >= CLICKS) return;
    const offsetMs = (onset.time - grid.time) * 1000;
    if (Math.abs(offsetMs) > 250) return; // not an attempt at this click
    this.taps.push({ index: grid.index, offsetMs });
    this.root.querySelector('#cal-detail').textContent = `${this.taps.length} / ${CLICKS}`;
  }

  finish() {
    this.running = false;
    this.metro.stop();
    const usable = this.taps.filter((t) => t.index >= IGNORE_FIRST).map((t) => t.offsetMs);
    const statusEl = this.root.querySelector('#cal-status');
    const detailEl = this.root.querySelector('#cal-detail');
    if (usable.length < 5) {
      statusEl.textContent = 'not enough taps';
      detailEl.textContent = 'the mic barely heard you — move it closer and retry';
      return;
    }
    const sorted = [...usable].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const spread = Math.sqrt(usable.reduce((a, b) => a + (b - median) ** 2, 0) / usable.length);
    if (spread > 25) {
      statusEl.textContent = 'too inconsistent';
      detailEl.textContent = `your taps varied ±${spread.toFixed(0)} ms — that's technique noise, not latency. Try again, slower focus.`;
      return;
    }
    store.set('calibrationMs', median);
    statusEl.textContent = `${median.toFixed(0)} ms`;
    detailEl.textContent = `saved (tap spread ±${spread.toFixed(0)} ms). Subtracted from every score on this device.`;
  }
}
