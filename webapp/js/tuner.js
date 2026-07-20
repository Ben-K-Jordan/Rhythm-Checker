// Tuner: tap the head, read the pitch. Fundamental mode for the drum's voice,
// lug mode for going around the head and finding the odd lug out.

import { estimatePitch, hzToNote, centsBetween } from './dsp.js';
import { store } from './store.js';

const TONE_SKIP = 0.025;
const TONE_WINDOW = 0.35;

export class TunerMode {
  constructor(root, mic) {
    this.root = root;
    this.mic = mic;
    this.mode = 'fundamental';
    this.drumId = null;
    this.lastHz = null;
    this.smoothHz = null;
    this.lugTaps = [];
    this._pending = null;
    this.render();
    mic.addEventListener('onset', (e) => this.onOnset(e.detail));
  }

  activate() {
    this.mic.setDetectorOptions({ refractory: 0.3, threshold: 5, minLevel: 0.012 });
  }

  onOnset(onset) {
    if (!this.root.classList.contains('active')) return;
    this._lastOnsetTime = onset.time;
    // wait until the ring is in the buffer, then pitch it. Each tap gets its
    // own timer — cancelling the previous one silently ate taps 300-435 ms
    // apart. If another tap lands first, this window is trimmed to it.
    setTimeout(() => {
      const next = this._lastOnsetTime > onset.time ? this._lastOnsetTime : null;
      const dur = Math.min(TONE_WINDOW, (next ? next - 0.01 - onset.time : Infinity) - TONE_SKIP);
      const win = dur > 0 ? this.mic.grabWindow(onset.time + TONE_SKIP, dur) : null;
      if (!win) return;
      const pre = this.mic.grabWindow(onset.time - TONE_WINDOW - 0.01, TONE_WINDOW);
      const hz = estimatePitch(win, this.mic.audioContext.sampleRate, pre);
      if (hz === null) {
        this.flashStatus('no clear pitch — let the head ring (hit near a lug, not the center, for lug tuning)');
        return;
      }
      this.lastHz = hz;
      this.smoothHz = this.smoothHz === null ? hz
        : Math.abs(centsBetween(hz, this.smoothHz)) > 80 ? hz
        : 0.6 * this.smoothHz + 0.4 * hz;
      if (this.mode === 'lug') {
        this.lugTaps.push(hz);
        if (this.lugTaps.length > 24) this.lugTaps.shift();
      }
      this.updateReadout();
    }, (TONE_SKIP + TONE_WINDOW) * 1000 + 60);
  }

  targetHz() {
    const drum = store.get('kit').find((d) => d.id === this.drumId);
    return drum ? drum.targetHz : null;
  }

  render() {
    const kit = store.get('kit');
    // settings can re-render this tab at any moment: reconcile state first so
    // the DOM never claims one thing while saves act on another
    if (this.drumId && !kit.some((d) => d.id === this.drumId)) {
      this.drumId = null;
      this.lugTaps = [];
    }
    this.root.innerHTML = `
      <div class="mode-head">
        <div class="seg" role="tablist">
          <button data-m="fundamental" class="${this.mode === 'fundamental' ? 'on' : ''}">Fundamental</button>
          <button data-m="lug" class="${this.mode === 'lug' ? 'on' : ''}">Lug match</button>
        </div>
        <select id="tuner-drum">
          <option value="">(no drum selected)</option>
          ${kit.map((d) => `<option value="${d.id}" ${d.id === this.drumId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
      </div>
      <div class="big-read">
        <div id="tuner-hz" class="huge">—</div>
        <div id="tuner-note" class="mid">tap the head</div>
        <canvas id="tuner-needle" width="640" height="120"></canvas>
        <div id="tuner-status" class="status"></div>
      </div>
      <div id="tuner-lugs" class="lug-panel ${this.mode === 'lug' ? '' : 'hidden'}">
        <div class="lug-row" id="lug-list"></div>
        <div class="row">
          <button id="lug-clear">Clear pass</button>
          <span id="lug-verdict" class="status"></span>
        </div>
      </div>
      <div class="row">
        <button id="tuner-save" disabled>Save as target for selected drum</button>
      </div>`;
    this.root.querySelectorAll('.seg button').forEach((b) => {
      b.addEventListener('click', () => {
        this.mode = b.dataset.m;
        this.root.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
        this.root.querySelector('#tuner-lugs').classList.toggle('hidden', this.mode !== 'lug');
        this.lugTaps = [];
        this.updateReadout();
      });
    });
    this.root.querySelector('#tuner-drum').addEventListener('change', (e) => {
      this.drumId = e.target.value || null;
      this.updateReadout();
    });
    this.root.querySelector('#tuner-save').addEventListener('click', () => {
      const drum = store.get('kit').find((d) => d.id === this.drumId);
      const hz = this.mode === 'lug' && this.lugTaps.length ? median(this.lugTaps) : this.lastHz;
      if (drum && hz) {
        store.updateDrum(drum.id, { targetHz: Math.round(hz * 10) / 10 });
        this.flashStatus(`saved ${hz.toFixed(1)} Hz as target for ${drum.name}`);
      }
    });
    this.root.querySelector('#lug-clear').addEventListener('click', () => {
      this.lugTaps = [];
      this.updateReadout();
    });
    if (this.lastHz !== null) this.updateReadout();
  }

  flashStatus(msg) {
    const el = this.root.querySelector('#tuner-status');
    el.textContent = msg;
    clearTimeout(this._statusT);
    this._statusT = setTimeout(() => { el.textContent = ''; }, 3500);
  }

  updateReadout() {
    const hzEl = this.root.querySelector('#tuner-hz');
    const noteEl = this.root.querySelector('#tuner-note');
    const saveBtn = this.root.querySelector('#tuner-save');
    saveBtn.disabled = !this.drumId || (!this.lastHz && !this.lugTaps.length);
    if (this.lastHz === null) return;
    hzEl.textContent = `${this.lastHz.toFixed(1)} Hz`;
    const target = this.targetHz();
    if (target) {
      const cents = centsBetween(this.lastHz, target);
      noteEl.textContent = `${hzToNote(this.lastHz)} · ${cents >= 0 ? '+' : ''}${cents.toFixed(0)} cents vs target ${target} Hz`;
      this.drawNeedle(cents);
    } else {
      noteEl.textContent = `~${hzToNote(this.lastHz)} (no target saved)`;
      this.drawNeedle(null);
    }
    if (this.mode === 'lug') this.renderLugs();
  }

  renderLugs() {
    const list = this.root.querySelector('#lug-list');
    const verdict = this.root.querySelector('#lug-verdict');
    if (!this.lugTaps.length) { list.innerHTML = ''; verdict.textContent = ''; return; }
    const med = median(this.lugTaps);
    list.innerHTML = this.lugTaps.map((hz, i) => {
      const cents = centsBetween(hz, med);
      const cls = Math.abs(cents) > 15 ? 'bad' : Math.abs(cents) > 7 ? 'warn' : 'good';
      return `<div class="lug ${cls}"><span>#${i + 1}</span><b>${hz.toFixed(1)}</b><i>${cents >= 0 ? '+' : ''}${cents.toFixed(0)}¢</i></div>`;
    }).join('');
    const worst = Math.max(...this.lugTaps.map((hz) => Math.abs(centsBetween(hz, med))));
    verdict.textContent = worst > 15
      ? 'uneven — adjust the marked lugs and tap around again'
      : `even head (${med.toFixed(1)} Hz median, spread ±${worst.toFixed(0)}¢)`;
  }

  drawNeedle(cents) {
    const cv = this.root.querySelector('#tuner-needle');
    const ctx = cv.getContext('2d');
    const w = cv.width;
    const h = cv.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#3a3f4a';
    ctx.lineWidth = 2;
    for (let c = -50; c <= 50; c += 10) {
      const x = w / 2 + (c / 50) * (w / 2 - 20);
      ctx.beginPath();
      ctx.moveTo(x, 20);
      ctx.lineTo(x, c === 0 ? 55 : 40);
      ctx.stroke();
    }
    if (cents === null) return;
    const clamped = Math.max(-50, Math.min(50, cents));
    const x = w / 2 + (clamped / 50) * (w / 2 - 20);
    ctx.strokeStyle = Math.abs(cents) <= store.get('tuneToleranceCents') ? '#3ddc84' : '#ff5252';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(x, 15);
    ctx.lineTo(x, h - 15);
    ctx.stroke();
  }
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}
