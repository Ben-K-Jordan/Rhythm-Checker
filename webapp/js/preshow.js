// Pre-show check: the guided "am I dialed?" flow. Tuning per drum against
// saved targets, then a timing check against the saved baseline. Big screens,
// pass/fail, works offline in a loud backstage.

import { estimatePitch, centsBetween } from './dsp.js';
import { TimingSession } from './timing.js';
import { store } from './store.js';

const TAPS_PER_DRUM = 3;
const TONE_SKIP = 0.025;
const TONE_WINDOW = 0.35;
const HANDS_SECONDS = 30;

export class PreshowMode {
  constructor(root, mic) {
    this.root = root;
    this.mic = mic;
    this.state = 'idle'; // idle | drum | hands | done
    this.results = [];
    this.render();
    mic.addEventListener('onset', (e) => this.onOnset(e.detail));
  }

  activate() {
    this.mic.setDetectorOptions({ refractory: 0.3, threshold: 5, minLevel: 0.012 });
  }

  targetsReady() {
    return store.get('kit').filter((d) => d.targetHz !== null);
  }

  render() {
    const drums = this.targetsReady();
    const base = store.get('baseline');
    const missing = [];
    if (!drums.length) missing.push('save a tuning target for at least one drum (Tuner tab → "Save as target")');
    if (!base) missing.push('save a timing baseline (Timing tab → run a check → "Save as my baseline")');
    if (store.get('calibrationMs') === null) missing.push('run latency calibration (Calibrate tab) so the hands check is fair');
    this.root.innerHTML = `
      <div class="explain">
        <p><b>Show-day double check.</b> Tuning per drum vs the targets you saved
        at rehearsal, then ${HANDS_SECONDS} s of hands vs your baseline. Two facts,
        no flattery.</p>
        ${missing.length ? `<p class="warn-text">Before the first run: <ul>${missing.map((m) => `<li>${m}</li>`).join('')}</ul></p>` : ''}
      </div>
      <div class="row"><button id="ps-go" class="primary" ${drums.length ? '' : 'disabled'}>Start the check</button></div>
      <div id="ps-stage" class="big-read"></div>
      <div id="ps-list" class="check-list"></div>`;
    this.root.querySelector('#ps-go').addEventListener('click', () => this.start());
  }

  start() {
    this.queue = this.targetsReady().map((d) => ({ drum: d, taps: [] }));
    this.results = [];
    this.state = 'drum';
    this.current = 0;
    this.activate();
    this.renderStage();
  }

  renderStage() {
    const stage = this.root.querySelector('#ps-stage');
    if (this.state === 'drum') {
      const item = this.queue[this.current];
      stage.innerHTML = `
        <div class="mid">check ${this.current + 1} of ${this.queue.length}</div>
        <div class="huge">${item.drum.name}</div>
        <div class="mid">tap the head ${TAPS_PER_DRUM}× and let it ring · target ${item.drum.targetHz} Hz</div>
        <div id="ps-taps" class="mid">${'○ '.repeat(TAPS_PER_DRUM)}</div>`;
    } else if (this.state === 'hands') {
      stage.innerHTML = `
        <div class="huge">HANDS</div>
        <div class="mid">play ${this.session.metro.subdivision === 1 ? 'quarters' : 'your groove'} with the click — ${HANDS_SECONDS} s</div>
        <div id="ps-count" class="mid"></div>`;
    }
    this.renderList();
  }

  renderList() {
    const list = this.root.querySelector('#ps-list');
    list.innerHTML = this.results.map((r) => `
      <div class="check-item ${r.pass ? 'pass' : 'fail'}">
        <b>${r.name}</b><span>${r.detail}</span><i>${r.pass ? 'OK' : 'OFF'}</i>
      </div>`).join('');
  }

  onOnset(onset) {
    if (this.state !== 'drum' || !this.root.classList.contains('active')) return;
    setTimeout(() => {
      const win = this.mic.grabWindow(onset.time + TONE_SKIP, TONE_WINDOW);
      if (!win) return;
      const hz = estimatePitch(win, this.mic.audioContext.sampleRate);
      if (hz === null) return; // damped / unclear: doesn't count as a tap
      const item = this.queue[this.current];
      item.taps.push(hz);
      const el = this.root.querySelector('#ps-taps');
      if (el) el.textContent = '● '.repeat(item.taps.length) + '○ '.repeat(Math.max(0, TAPS_PER_DRUM - item.taps.length));
      if (item.taps.length >= TAPS_PER_DRUM) this.finishDrum(item);
    }, (TONE_SKIP + TONE_WINDOW) * 1000 + 60);
  }

  finishDrum(item) {
    const sorted = [...item.taps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const cents = centsBetween(median, item.drum.targetHz);
    const tol = store.get('tuneToleranceCents');
    this.results.push({
      name: item.drum.name,
      pass: Math.abs(cents) <= tol,
      detail: `${median.toFixed(1)} Hz · ${cents >= 0 ? '+' : ''}${cents.toFixed(0)}¢ vs target (±${tol}¢ ok)${Math.abs(cents) > tol ? (cents > 0 ? ' — tune DOWN' : ' — tune UP') : ''}`,
    });
    this.current++;
    if (this.current < this.queue.length) {
      this.renderStage();
    } else {
      this.startHands();
    }
  }

  startHands() {
    const base = store.get('baseline');
    if (!base) { this.finishAll(); return; }
    this.state = 'hands';
    this.mic.setDetectorOptions({ refractory: 0.03, threshold: 4, minLevel: 0.01 });
    this.session = new TimingSession(this.mic, {
      bpm: base.bpm,
      subdivision: base.subdivision,
      seconds: HANDS_SECONDS,
    });
    this.session.addEventListener('done', (e) => this.finishHands(e.detail));
    this.session.start();
    this.renderStage();
    const countEl = () => this.root.querySelector('#ps-count');
    this._countTimer = setInterval(() => {
      const left = Math.max(0, Math.round(this.session.metro.startTime + HANDS_SECONDS - this.mic.now()));
      const el = countEl();
      if (el) el.textContent = `${left} s left`;
    }, 500);
  }

  finishHands(result) {
    clearInterval(this._countTimer);
    const base = store.get('baseline');
    if (!result) {
      this.results.push({ name: 'Hands', pass: false, detail: 'no hits detected — mic problem or silence' });
    } else {
      // dialed = spread within 25% (or 2 ms) of baseline, pocket within 15 points
      const sdOk = result.sd <= Math.max(base.sd * 1.25, base.sd + 2);
      const pocketOk = result.pocketPct >= base.pocketPct - 15;
      this.results.push({
        name: 'Hands',
        pass: sdOk && pocketOk,
        detail: `spread ${result.sd.toFixed(1)} ms (baseline ${base.sd.toFixed(1)}) · pocket ${result.pocketPct.toFixed(0)}% (baseline ${base.pocketPct.toFixed(0)}%) · mean ${result.mean >= 0 ? '+' : ''}${result.mean.toFixed(1)} ms`,
      });
    }
    this.finishAll();
  }

  finishAll() {
    this.state = 'done';
    const allPass = this.results.every((r) => r.pass);
    const stage = this.root.querySelector('#ps-stage');
    stage.innerHTML = allPass
      ? `<div class="huge pass-text">DIALED</div><div class="mid">everything matches what you set up at rehearsal. Go play.</div>`
      : `<div class="huge fail-text">NOT YET</div><div class="mid">the list below says exactly what's off — fix it and run again.</div>`;
    this.renderList();
  }
}
