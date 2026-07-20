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

function escText(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

export class PreshowMode {
  constructor(root, mic) {
    this.root = root;
    this.mic = mic;
    this.state = 'idle'; // idle | drum | hands | done
    this.results = [];
    this._leg = 'full';  // 'full' (dry run) | 'drums' | 'hands' (armed ritual legs)
    this.navTo = null;   // set by the shell so completed legs return home
    this.render();
    mic.addEventListener('onset', (e) => this.onOnset(e.detail));
  }

  // Armed-ritual entry: run ONE leg, write its outcome into the show ledger,
  // then go home. Show day splits naturally — drums at soundcheck, hands
  // backstage hours later — so the legs must be independently runnable.
  beginLeg(leg) {
    if (this.navTo) this.navTo('preshow');
    clearInterval(this._countTimer);
    if (this.session) { this.session.cancel(); this.session = null; }
    this._leg = leg;
    this.results = [];
    if (leg === 'hands') {
      this.state = 'hands';
      this.startHands();
      return;
    }
    this.queue = this.targetsReady().map((d) => ({ drum: d, taps: [] }));
    if (!this.queue.length) {
      this.state = 'idle';
      this.render();
      return;
    }
    this.state = 'drum';
    this.current = 0;
    this.mic.setDetectorOptions({ refractory: 0.3, threshold: 5, minLevel: 0.012 });
    this.renderStage();
  }

  _afterDrums() {
    if (this._leg === 'drums') this._completeLeg('drums');
    else this.startHands();
  }

  _completeLeg(leg) {
    const show = store.get('show');
    const rows = this.results;
    const pass = rows.length > 0 && rows.every((r) => r.pass);
    let detail;
    if (leg === 'drums') {
      const bad = rows.filter((r) => !r.pass);
      detail = bad.length
        ? `${bad.length} off: ${bad.map((r) => r.name).join(', ')}`
        : `${rows.length}/${rows.length} in tune`;
    } else {
      detail = rows[0] ? rows[0].detail : 'no data';
    }
    if (show && this._leg !== 'full') {
      show[leg] = { time: Date.now(), pass, detail };
      store.set('show', show);
      this.state = 'idle';
      this._leg = 'full';
      if (this.navTo) this.navTo('home');
    } else {
      this.finishAll();
    }
  }

  activate() {
    // prerequisites may have changed since the last visit (targets saved,
    // baseline recorded, drums removed) — re-render unless a check is running
    if (this.state === 'idle' || this.state === 'done') {
      this.state = 'idle';
      this.render();
    }
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
    // tear down any in-flight run first: a nervous double-tap on show day
    // must restart cleanly, never leave a zombie session scoring the new run
    clearInterval(this._countTimer);
    if (this.session) {
      this.session.cancel();
      this.session = null;
    }
    this.queue = this.targetsReady().map((d) => ({ drum: d, taps: [] }));
    if (!this.queue.length) {
      this.state = 'idle';
      this.render();
      return;
    }
    this.results = [];
    this.state = 'drum';
    this.current = 0;
    this.mic.setDetectorOptions({ refractory: 0.3, threshold: 5, minLevel: 0.012 });
    const go = this.root.querySelector('#ps-go');
    if (go) go.textContent = 'Restart the check';
    this.renderStage();
  }

  renderStage() {
    const stage = this.root.querySelector('#ps-stage');
    if (this.state === 'drum') {
      const item = this.queue[this.current];
      stage.innerHTML = `
        <div class="mid">check ${this.current + 1} of ${this.queue.length}</div>
        <div class="huge">${escText(item.drum.name)}</div>
        <div class="mid">tap the head ${TAPS_PER_DRUM}× and let it ring · target ${item.drum.targetHz} Hz</div>
        <div id="ps-taps" class="mid">${'○ '.repeat(TAPS_PER_DRUM)}</div>
        <div id="ps-status" class="status"></div>
        <div class="row" style="justify-content:center">
          <button id="ps-skip">Skip this drum</button>
        </div>`;
      stage.querySelector('#ps-skip').addEventListener('click', () => {
        // a muffled head may never pitch — the check must not dead-end on it
        const skipped = this.queue[this.current];
        this.results.push({
          name: skipped.drum.name,
          pass: false,
          detail: 'skipped — no clear pitch (muffled/damped head?)',
        });
        this.current++;
        if (this.current < this.queue.length) this.renderStage();
        else this._afterDrums();
      });
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
        <b>${escText(r.name)}</b><span>${r.detail}</span><i>${r.pass ? 'OK' : 'OFF'}</i>
      </div>`).join('');
  }

  onOnset(onset) {
    if (this.state !== 'drum' || !this.root.classList.contains('active')) return;
    // bind the drum NOW: the analysis fires ~435 ms later, and an extra tap
    // must never leak into the next drum's verdict (or past the queue's end)
    const item = this.queue[this.current];
    setTimeout(() => {
      if (this.state !== 'drum' || this.queue[this.current] !== item) return;
      if (item.taps.length >= TAPS_PER_DRUM) return;
      const win = this.mic.grabWindow(onset.time + TONE_SKIP, TONE_WINDOW);
      if (!win) return;
      const pre = this.mic.grabWindow(onset.time - TONE_WINDOW - 0.01, TONE_WINDOW);
      const hz = estimatePitch(win, this.mic.audioContext.sampleRate, pre);
      const statusEl = this.root.querySelector('#ps-status');
      if (hz === null) {
        if (statusEl) statusEl.textContent = 'no clear pitch — let the head ring, or Skip if it’s muffled';
        return;
      }
      if (statusEl) statusEl.textContent = '';
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
      this._afterDrums();
    }
  }

  startHands() {
    const base = store.get('baseline');
    if (!base) {
      if (this._leg === 'hands') {
        this.results.push({ name: 'Hands', pass: false, detail: 'no baseline saved — run Timing first' });
        this._completeLeg('hands');
      } else this.finishAll();
      return;
    }
    this.state = 'hands';
    this.mic.setDetectorOptions({ refractory: 0.03, threshold: 4, minLevel: 0.01 });
    this.session = new TimingSession(this.mic, {
      bpm: base.bpm,
      subdivision: base.subdivision,
      seconds: HANDS_SECONDS,
    });
    const session = this.session; // a superseded session must never report
    session.addEventListener('done', (e) => {
      if (this.session === session) this.finishHands(e.detail);
    });
    session.start();
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
    if (this._leg === 'hands') this._completeLeg('hands');
    else this.finishAll();
  }

  finishAll() {
    this.state = 'done';
    this.session = null;
    const go = this.root.querySelector('#ps-go');
    if (go) go.textContent = 'Start the check';
    const allPass = this.results.every((r) => r.pass);
    const stage = this.root.querySelector('#ps-stage');
    stage.innerHTML = allPass
      ? `<div class="huge pass-text">DIALED</div><div class="mid">everything matches what you set up at rehearsal. Go play.</div>`
      : `<div class="huge fail-text">NOT YET</div><div class="mid">the list below says exactly what's off — fix it and run again.</div>`;
    this.renderList();
  }
}
