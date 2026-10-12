// Tuner: tap the head, read the cents against your target on an arc gauge.
// Two heads per drum, player feels sized to your drums, and a lug pass that
// finds the odd lug out.

import { estimatePitch, hzToNote, centsBetween } from './dsp.js';
import { store } from './store.js';
import { FEELS, applyFeel, restoreFeel, feelTargetFor, roleOf } from './feel.js';
import { icon, fmtSigned, nbsp, monitorSize, announce, toast, seg } from './ui.js';

const TONE_SKIP = 0.025;
const TONE_WINDOW = 0.35;
const STALE_MS = 8000;      // --d-stale
const LUG_WINDOW = 15;      // cents from the median before a lug is called out

// gauge geometry (spec 8.3): viewBox 300 x 170, centre (150,160), r 118, ±50¢ ↔ ±70°
const GX = 150, GY = 160, GR = 118, GSPAN = 70;
const NEEDLE = GR - 12;

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

const r1 = (x) => Math.round(x * 10) / 10;
// targets read in whole Hz above 100 Hz; kick-range pitches keep a decimal
const fmtHz = (hz) => String(hz >= 100 ? Math.round(hz) : r1(hz));
const hzText = (hz) => nbsp(fmtHz(hz), 'Hz');

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function listWords(nums) {
  if (nums.length < 2) return String(nums[0]);
  return `${nums.slice(0, -1).join(', ')} and ${nums[nums.length - 1]}`;
}

// ------------------------------------------------------------------ gauge
function polar(cents, r) {
  const a = (cents / 50) * GSPAN * Math.PI / 180;
  return [GX + r * Math.sin(a), GY - r * Math.cos(a)];
}
const f1 = (n) => n.toFixed(1);
function arc(c1, c2, r) {
  const [x1, y1] = polar(c1, r), [x2, y2] = polar(c2, r);
  return `M${f1(x1)} ${f1(y1)}A${r} ${r} 0 0 1 ${f1(x2)} ${f1(y2)}`;
}
function radial(c, r0, r1_) {
  const [x1, y1] = polar(c, r0), [x2, y2] = polar(c, r1_);
  return { x1: f1(x1), y1: f1(y1), x2: f1(x2), y2: f1(y2) };
}

// Exactly five <path>: left track, tolerance zone, right track, two end caps.
function gaugeSVG(tol) {
  const t = Math.max(0, Math.min(50, tol));
  const capL = radial(-50, GR - 9, GR + 9), capR = radial(50, GR - 9, GR + 9);
  const ticks = [];
  for (let c = -45; c <= 45; c += 5) {
    const major = c % 25 === 0;
    const p = radial(c, GR - (major ? 6 : 3), GR + (major ? 6 : 3));
    ticks.push(`<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" class="${major ? 'g-tick g-tick--major' : 'g-tick'}"/>`);
  }
  const labels = [-50, -25, 0, 25, 50].map((c) => {
    const [x, y] = polar(c, GR + 18);
    const anchor = c < 0 ? 'end' : c > 0 ? 'start' : 'middle';
    const text = c === 0 ? '0' : fmtSigned(c);
    return `<text x="${f1(x)}" y="${f1(y + 4)}" text-anchor="${anchor}" class="g-label">${text}</text>`;
  }).join('');
  const tip = GY - NEEDLE;
  return `
    <svg viewBox="0 0 300 170" preserveAspectRatio="xMidYMax meet" role="img" aria-label="Cents from target: no reading yet">
      <path class="g-track" d="${arc(-50, -t, GR)}"/>
      <path class="g-zone" d="${arc(-t, t, GR)}"/>
      <path class="g-track" d="${arc(t, 50, GR)}"/>
      <path class="g-cap" d="M${capL.x1} ${capL.y1}L${capL.x2} ${capL.y2}"/>
      <path class="g-cap" d="M${capR.x1} ${capR.y1}L${capR.x2} ${capR.y2}"/>
      ${ticks.join('')}
      ${labels}
      <g id="gauge-hand" class="g-hand is-idle" transform="rotate(0 ${GX} ${GY})">
        <line id="gauge-needle" x1="${GX}" y1="${GY}" x2="${GX}" y2="${tip}"/>
        <polygon class="g-pin g-pin--sharp hidden" points="${GX + 2},${tip - 8} ${GX + 14},${tip} ${GX + 2},${tip + 8}"/>
        <polygon class="g-pin g-pin--flat hidden" points="${GX - 2},${tip - 8} ${GX - 14},${tip} ${GX - 2},${tip + 8}"/>
      </g>
      <circle class="g-pivot" cx="${GX}" cy="${GY}" r="7"/>
    </svg>`;
}

// --------------------------------------------------------------- lug diagram
// HTML, not SVG: each slot is a real box, so its number sits on its own fill.
function lugDiagram(n, taps, next, outIdx, head) {
  const c = 66, ring = 52, half = 13;
  const slots = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = c + ring * Math.sin(a) - half, y = c - ring * Math.cos(a) - half;
    const cls = i === next ? 'is-next' : outIdx.has(i) ? 'is-out' : i < taps ? 'is-done' : 'is-empty';
    slots.push(`<span class="lug-dot ${cls}" style="left:${f1(x)}px;top:${f1(y)}px">${i + 1}</span>`);
  }
  return `
    <div class="lug-ring" role="img" aria-label="Lug pass, ${taps} of ${n} lugs tapped">
      <span class="lug-ring__head" aria-hidden="true">${head === 'reso' ? 'RESO' : 'BATTER'}</span>
      ${slots.join('')}
    </div>`;
}

export class TunerMode {
  constructor(root, mic) {
    this.root = root;
    this.mic = mic;
    this.mode = 'fund'; // 'fund' | 'lug'
    this.head = 'batter';
    this.heads = {};    // per-drum measured {batter, reso} this session
    this.drumId = null;
    this.reading = null; // {drumId, head, hz, at}: SAVE only ever writes it back to that same drum + head
    this.status = null;  // persistent status line; null = the idle instruction
    this.lugTaps = [];
    this.lugNext = 0;
    this._ticker = null;
    this._lastState = '';
    this.render();
    mic.addEventListener('onset', (e) => this.onOnset(e.detail));
  }

  // The live reading, valid only for the drum + head it was measured on.
  get lastHz() {
    const r = this.reading;
    return r && r.drumId === this.drumId && r.head === this.head ? r.hz : null;
  }

  set lastHz(hz) {
    this.reading = hz === null || hz === undefined
      ? null
      : { drumId: this.drumId, head: this.head, hz, at: performance.now() };
    if (this.reading) this.startTicker();
  }

  activate() {
    this.mic.setDetectorOptions({ refractory: 0.3, threshold: 5, minLevel: 0.012 });
    // Home's player feel or the settings sheet may have retuned the kit
    this.render();
    this.startTicker();
  }

  deactivate() {
    this.stopTicker();
  }

  onOnset(onset) {
    if (!this.root.classList.contains('active')) return;
    this._lastOnsetTime = onset.time;
    setTimeout(() => {
      const next = this._lastOnsetTime > onset.time ? this._lastOnsetTime : null;
      const dur = Math.min(TONE_WINDOW, (next ? next - 0.01 - onset.time : Infinity) - TONE_SKIP);
      const win = dur > 0 ? this.mic.grabWindow(onset.time + TONE_SKIP, dur) : null;
      if (!win) return;
      const pre = this.mic.grabWindow(onset.time - TONE_WINDOW - 0.01, TONE_WINDOW);
      const hz = estimatePitch(win, this.mic.audioContext.sampleRate, pre);
      if (hz === null) {
        this.flashStatus('No clear pitch. Let the head ring.');
        announce('No clear pitch. Let the head ring.');
        return;
      }
      this.status = null;
      if (this.mode === 'lug') {
        this.addLugTap(hz);
      } else {
        this.lastHz = hz;
        const key = this.drumId || 'free';
        this.heads[key] = { ...(this.heads[key] || {}), [this.head]: hz };
      }
      this.updateReadout();
    }, (TONE_SKIP + TONE_WINDOW) * 1000 + 60);
  }

  drum() {
    return store.get('kit').find((d) => d.id === this.drumId) || null;
  }

  targetHz() {
    const drum = this.drum();
    if (!drum) return null;
    return this.head === 'reso' ? (drum.resoHz ?? null) : (drum.targetHz ?? null);
  }

  drumName() {
    const d = this.drum();
    return d ? d.name : 'drum';
  }

  // "YOUR TARGET" unless the head's target is exactly the active feel's
  targetSource() {
    const feel = store.get('feel');
    const drum = this.drum();
    const target = this.targetHz();
    if (feel && FEELS[feel] && drum && target !== null) {
      const ft = feelTargetFor(feel, drum, this.head);
      if (ft !== null && Math.abs(ft - target) < 0.05) return FEELS[feel].label;
    }
    return 'YOUR TARGET';
  }

  lugSlots() {
    const n = Math.round(Number(store.get('lugCount')));
    return Number.isFinite(n) ? Math.max(3, Math.min(16, n)) : 6;
  }

  addLugTap(hz) {
    const n = this.lugSlots();
    if (this.lugTaps.length > n) this.lugTaps.length = n;
    if (this.lugTaps.length < n) {
      this.lugTaps.push(hz);
      this.lugNext = this.lugTaps.length % n;
    } else {
      // going round again: each tap replaces the next lug in turn
      this.lugTaps[this.lugNext % n] = hz;
      this.lugNext = (this.lugNext + 1) % n;
    }
  }

  clearReading() {
    this.reading = null;
    this.status = null;
    this.lugTaps = [];
    this.lugNext = 0;
    this._lastState = '';
  }

  setDrum(id) {
    if (id === this.drumId) return;
    this.drumId = id;
    this.clearReading();
    this.render();
  }

  setHead(head) {
    const h = head === 'reso' ? 'reso' : 'batter';
    if (h === this.head) return;
    this.head = h;
    this.clearReading(); // a lug pass is per head too
    this.render();
  }

  setMode(mode) {
    this.mode = mode === 'lug' ? 'lug' : 'fund';
    this.status = null;
    this.render();
  }

  // ------------------------------------------------------------- render
  render() {
    const kit = store.get('kit');
    if (!kit.some((d) => d.id === this.drumId) && (this.drumId !== null || kit.length)) {
      this.drumId = kit.length ? kit[0].id : null;
      this.clearReading();
    }
    const drum = this.drum();
    const lug = this.mode === 'lug';
    const focusKey = this.focusKey();
    this.root.innerHTML = `
      <div class="screen tuner">
        <div class="title-row">
          <h1 class="stamp">TUNER</h1>
          <div class="tuner-modes" role="group" aria-label="Mode"></div>
        </div>
        <div class="seg--scroll drum-chips" role="group" aria-label="Drum"></div>
        <div class="tuner-headrow">
          <div class="tuner-headseg${lug ? '' : ' seg--tall'}" role="group" aria-label="Head"></div>
          <select id="tuner-head" class="proxy-select" tabindex="-1" aria-hidden="true" aria-label="Head">
            <option value="batter"${this.head === 'batter' ? ' selected' : ''}>BATTER</option>
            <option value="reso"${this.head === 'reso' ? ' selected' : ''}>RESO</option>
          </select>
        </div>
        ${lug ? this.lugHTML() : this.pitchHTML(drum)}
      </div>
      <div class="bar tuner-bar">
        ${lug
    ? '<button type="button" id="lug-clear" class="btn btn--secondary">START OVER</button>'
    : `<p class="bar__reason hidden" id="tuner-reason"></p>
        <button type="button" id="tuner-listen" class="btn btn--secondary">LISTEN</button>
        <button type="button" id="tuner-save" class="btn btn--primary" aria-describedby="tuner-reason">SAVE TARGET</button>`}
      </div>`;

    const $ = (sel) => this.root.querySelector(sel);

    seg($('.tuner-modes'), [
      { value: 'fund', label: 'PITCH', data: { mode: 'fund' } },
      { value: 'lug', label: 'LUGS', data: { mode: 'lug' } },
    ], this.mode, (v) => this.setMode(v));

    const chips = $('.drum-chips');
    seg(chips, kit.map((d) => ({ value: d.id, label: d.name, data: { drum: d.id } })), this.drumId,
      (id) => this.setDrum(id));
    chips.insertAdjacentHTML('beforeend',
      `<button type="button" class="btn--quiet tuner-editkit" id="tuner-edit-kit">EDIT KIT${icon('tri-right')}</button>`);
    chips.dispatchEvent(new Event('scroll')); // re-measure the end fade with EDIT KIT in the row
    $('#tuner-edit-kit').addEventListener('click', () => this.openKit());

    const select = $('#tuner-head');
    const headOpt = (h, label) => {
      const t = drum ? (h === 'reso' ? drum.resoHz : drum.targetHz) : null;
      return { value: h, label, data: { head: h }, sub: lug ? undefined : (t ? `target ${hzText(t)}` : 'no target') };
    };
    seg($('.tuner-headseg'), [headOpt('batter', 'BATTER'), headOpt('reso', 'RESO')], this.head, (v) => {
      select.value = v;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    select.addEventListener('change', (e) => this.setHead(e.target.value));

    if (lug) {
      $('#lug-clear').addEventListener('click', () => {
        this.lugTaps = [];
        this.lugNext = 0;
        this.status = null;
        this.updateReadout();
      });
    } else {
      this.root.querySelectorAll('.feel-row').forEach((b) => {
        b.addEventListener('click', () => this.pickFeel(b.dataset.feel));
      });
      $('#tuner-listen').addEventListener('click', () => this.playReference());
      $('#tuner-save').addEventListener('click', () => this.save());
    }
    this.updateReadout();
    if (focusKey) {
      const el = this.root.querySelector(focusKey);
      if (el) el.focus({ preventScroll: true });
    }
  }

  // Every control re-renders the screen; this finds the same control again
  // so keyboard focus survives the rebuild.
  focusKey() {
    const a = document.activeElement;
    if (!a || a === this.root || !this.root.contains(a)) return null;
    if (a.id) return `#${CSS.escape(a.id)}`;
    for (const k of ['drum', 'head', 'mode', 'feel']) {
      if (a.dataset[k] !== undefined) return `[data-${k}="${CSS.escape(a.dataset[k])}"]`;
    }
    return null;
  }

  pitchHTML(drum) {
    const tol = store.get('tuneToleranceCents');
    const target = this.targetHz();
    const feel = store.get('feel');
    const kit = store.get('kit');
    const tunable = kit.filter((d) => roleOf(d.name)).length;
    const rows = Object.entries(FEELS).map(([id, f]) => {
      const hz = drum ? feelTargetFor(id, drum, this.head) : null;
      const sub = hz ? hzText(hz) : '—';
      const aria = `${f.label}, ${f.voice}, ${hz ? hzText(hz) : 'no target for this drum'}`;
      const on = feel === id;
      return `<button type="button" class="feel-row${on ? ' on' : ''}" data-feel="${id}" aria-pressed="${on}" aria-label="${esc(aria)}">`
        + `<span class="fr-name">${f.label}</span><span class="seg__sub">${sub}</span></button>`;
    }).join('');
    return `
      <section class="tuner-read">
        <div class="monitor__cap tuner-cap hidden" id="tuner-cap"></div>
        <div class="tuner-mon">
          <div class="monitor is-idle"><b id="gauge-cents">—</b><span class="monitor__side"><i class="unit" id="tuner-unit">${target ? '¢' : 'Hz'}</i></span></div>
          <div class="tuner-dir"><span id="gauge-state" class="dir hidden"></span><span class="chip chip--ok tuner-intune hidden" id="tuner-tol"></span></div>
        </div>
        <div class="tuner-hzline">
          <span id="gauge-note" class="hidden"></span>
          ${target ? `<span id="gauge-target">VS ${hzText(target)} · ${esc(this.targetSource())}</span>` : ''}
        </div>
        <p id="tuner-status" class="tuner-status hidden"></p>
        <p id="tuner-heads" class="tuner-pair hidden"></p>
      </section>
      <div class="card tuner-notarget${target ? ' hidden' : ''}"><p${target ? '' : ' id="gauge-target"'}>No target yet. Tap, then save.</p></div>
      <div class="card gauge-card${target ? '' : ' hidden'}">
        <span class="gauge-legend"><i aria-hidden="true"></i>in tune ±${tol}¢</span>
        <div class="gauge-stage">${gaugeSVG(tol)}</div>
        <span class="gauge-end gauge-end--flat" aria-hidden="true">FLAT</span>
        <span class="gauge-end gauge-end--sharp" aria-hidden="true">SHARP</span>
      </div>
      <section class="tuner-feel" aria-labelledby="tuner-feel-title">
        <div class="sec-head">
          <h2 class="sec-head__stamp" id="tuner-feel-title">PLAYER FEEL</h2>
          ${tunable ? `<span class="sec-head__aside">RETUNES ALL ${tunable} DRUMS</span>` : ''}
        </div>
        <div class="seg seg--tall tuner-feel__seg" role="group" aria-labelledby="tuner-feel-title">${rows}</div>
      </section>`;
  }

  lugHTML() {
    return `
      <div id="lug-panel" class="card lug-panel">
        <div class="lug-top">
          <div class="lug-diagram" id="lug-diagram"></div>
          <div id="lug-verdict" class="lug-verdict">
            <span class="chip lug-progress" id="lug-progress"></span>
            <div class="hero lug-hero hidden" id="lug-hero">
              <div class="hero__cap">ALL LUGS WITHIN</div>
              <b id="lug-spread"></b>
              <p class="lug-median" id="lug-median"></p>
            </div>
            <p class="lug-line" id="lug-hint">Tap 2 cm in from each lug, going round.</p>
          </div>
        </div>
        <div class="lug-cells" id="lug-list"></div>
        <p class="lug-line hidden" id="lug-line"></p>
      </div>
      <p id="tuner-status" class="tuner-status hidden"></p>`;
  }

  // --------------------------------------------------------------- readout
  idleText() {
    return `Tap the ${this.drumName()}. Let it ring.`;
  }

  flashStatus(msg) {
    this.status = msg;
    this.renderStatus();
  }

  renderStatus() {
    const el = this.root.querySelector('#tuner-status');
    if (!el) return;
    const idle = this.mode === 'fund' && this.lastHz === null;
    const text = this.status || (idle ? this.idleText() : '');
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }

  updateReadout() {
    this.renderStatus();
    if (this.mode === 'lug') {
      this.renderLugs();
      return;
    }
    const $ = (sel) => this.root.querySelector(sel);
    const centsEl = $('#gauge-cents');
    if (!centsEl) return;
    const hz = this.lastHz;
    const target = this.targetHz();
    const tol = store.get('tuneToleranceCents');
    const monitor = centsEl.parentElement;
    const stateEl = $('#gauge-state');
    const tolEl = $('#tuner-tol');
    const noteEl = $('#gauge-note');
    const unitEl = $('#tuner-unit');
    const svg = this.root.querySelector('.gauge-stage svg');
    const hand = $('#gauge-hand');

    let value = '—';
    let state = '';
    let inTune = false;
    let deg = 0;
    let pin = null;
    if (hz !== null) {
      if (target) {
        const cents = Math.round(centsBetween(hz, target));
        value = fmtSigned(cents);
        inTune = Math.abs(cents) <= tol;
        state = inTune ? 'IN TUNE' : cents > 0 ? 'SHARP' : 'FLAT';
        deg = (Math.max(-50, Math.min(50, cents)) / 50) * GSPAN;
        if (cents > 50) pin = 'sharp';
        else if (cents < -50) pin = 'flat';
      } else {
        value = String(Math.round(hz));
        state = hzToNote(hz);
      }
    }
    centsEl.textContent = value;
    centsEl.style.fontSize = `${monitorSize(value)}px`;
    monitor.classList.toggle('is-idle', hz === null);
    unitEl.textContent = target ? '¢' : 'Hz';
    stateEl.textContent = state;
    stateEl.classList.toggle('hidden', !state);
    tolEl.innerHTML = inTune ? `${icon('check')}±${tol}¢` : '';
    tolEl.classList.toggle('hidden', !inTune);
    noteEl.innerHTML = hz !== null && target
      ? `${esc(nbsp(hz.toFixed(1), 'Hz'))}<span class="tuner-note"> · ${esc(hzToNote(hz))}</span>`
      : '';
    noteEl.classList.toggle('hidden', !(hz !== null && target));

    if (hand) {
      hand.setAttribute('transform', `rotate(${deg.toFixed(1)} ${GX} ${GY})`);
      hand.classList.toggle('is-idle', hz === null);
      hand.querySelector('.g-pin--sharp').classList.toggle('hidden', pin !== 'sharp');
      hand.querySelector('.g-pin--flat').classList.toggle('hidden', pin !== 'flat');
    }
    if (svg) {
      svg.setAttribute('aria-label', hz !== null && target
        ? `Cents from target: ${value.replace('−', 'minus ')}, ${state.toLowerCase()}`
        : 'Cents from target: no reading yet');
    }
    if (state && state !== this._lastState) {
      announce(target ? `${state}, ${value.replace('−', 'minus ')} cents` : `${value} hertz, ${state}`);
    }
    this._lastState = state;

    this.renderHeads();
    this.renderAge();
    this.renderBar();
  }

  renderAge() {
    const cap = this.root.querySelector('#tuner-cap');
    const read = this.root.querySelector('.tuner-read');
    if (!cap || !read) return;
    const r = this.lastHz !== null ? this.reading : null;
    if (!r) {
      cap.classList.add('hidden');
      read.classList.remove('is-stale');
      return;
    }
    const age = performance.now() - r.at;
    cap.textContent = `LAST TAP · ${nbsp(Math.floor(age / 1000), 's')} AGO`;
    cap.classList.remove('hidden');
    read.classList.toggle('is-stale', age >= STALE_MS);
    const hand = this.root.querySelector('#gauge-hand');
    if (hand) hand.classList.toggle('is-stale', age >= STALE_MS);
  }

  startTicker() {
    if (this._ticker || !this.reading) return;
    this._ticker = setInterval(() => {
      if (!this.root.classList.contains('active') || !this.reading) { this.stopTicker(); return; }
      this.renderAge();
    }, 1000);
  }

  stopTicker() {
    clearInterval(this._ticker);
    this._ticker = null;
  }

  renderBar() {
    const save = this.root.querySelector('#tuner-save');
    const listen = this.root.querySelector('#tuner-listen');
    const reason = this.root.querySelector('#tuner-reason');
    if (!save || !listen || !reason) return;
    const hz = this.lastHz;
    const target = this.targetHz();
    const canSave = !!this.drum() && hz !== null;
    save.disabled = !canSave;
    save.textContent = canSave ? `SAVE ${hzText(hz)}` : 'SAVE TARGET';
    listen.disabled = !target;
    let why = '';
    if (!this.drum()) why = 'Add a drum in EDIT KIT to save a target.';
    else if (!canSave) why = `Tap the ${this.drumName()} first.`;
    else if (!target) why = 'Save a target first.';
    reason.textContent = why;
    reason.classList.toggle('hidden', !why);
  }

  renderHeads() {
    const el = this.root.querySelector('#tuner-heads');
    if (!el) return;
    const m = this.heads[this.drumId || 'free'] || {};
    let text = '';
    if (m.batter && m.reso) {
      const st = 12 * Math.log2(m.reso / m.batter);
      const how = Math.abs(st) < 0.3
        ? 'same pitch: longest sustain'
        : st > 0
          ? 'reso above: the pitch bends down after the hit'
          : 'reso below: shorter, fatter';
      text = `Batter ${nbsp(m.batter.toFixed(1), 'Hz')} · reso ${nbsp(m.reso.toFixed(1), 'Hz')} · ${Math.abs(st).toFixed(1)} semitones apart, ${how}`;
    } else if (m.batter) {
      text = 'Now tap the reso to see the pair.';
    } else if (m.reso) {
      text = 'Tap the batter too to see the pair.';
    }
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }

  renderLugs() {
    const list = this.root.querySelector('#lug-list');
    if (!list) return;
    const n = this.lugSlots();
    if (this.lugTaps.length > n) this.lugTaps.length = n;
    const taps = this.lugTaps;
    const k = taps.length;
    const next = k < n ? k : this.lugNext % n;
    const med = k ? median(taps) : null;
    const cents = taps.map((hz) => Math.round(centsBetween(hz, med)));
    const out = new Set();
    cents.forEach((c, i) => { if (k >= 2 && Math.abs(c) > LUG_WINDOW) out.add(i); });

    const cells = [];
    for (let i = 0; i < n; i++) {
      const isNext = i === next;
      if (i < k) {
        const c = cents[i];
        const word = out.has(i) ? `<span class="lug-cell__word">${c < 0 ? 'FLAT' : 'SHARP'}</span>` : '';
        cells.push(`<div class="lug-cell${out.has(i) ? ' is-out' : ''}${isNext ? ' is-next' : ''}">`
          + `<span class="lug-cell__lab">LUG ${i + 1}${word}</span>`
          + `<b>${taps[i].toFixed(1)}</b><i>${k >= 2 ? `${fmtSigned(c)}¢` : '—'}</i></div>`);
      } else {
        cells.push(`<div class="lug-cell is-empty${isNext ? ' is-next' : ''}">`
          + `<span class="lug-cell__lab">LUG ${i + 1}</span>`
          + `<b>${isNext ? 'TAP NEXT' : ''}</b><i>—</i></div>`);
      }
    }
    list.innerHTML = cells.join('');
    this.root.querySelector('#lug-diagram').innerHTML = lugDiagram(n, k, next, out, this.head);
    this.root.querySelector('#lug-progress').textContent = `${k} / ${n}`;

    // the spread needs two lugs; until then the instruction takes its place
    const ready = k >= 2;
    this.root.querySelector('#lug-hero').classList.toggle('hidden', !ready);
    this.root.querySelector('#lug-hint').classList.toggle('hidden', ready);
    const line = this.root.querySelector('#lug-line');
    line.classList.toggle('hidden', !ready);
    if (!ready) return this.renderLugBar(k);
    const worst = Math.max(...cents.map(Math.abs));
    const spread = this.root.querySelector('#lug-spread');
    spread.innerHTML = `±${worst}<i class="unit">¢</i>`;
    spread.setAttribute('aria-label', `plus or minus ${worst} cents`);
    spread.style.fontSize = String(worst).length > 2 ? '64px' : '';
    this.root.querySelector('#lug-median').textContent = `median ${nbsp(med.toFixed(1), 'Hz')}`;

    const outList = [...out].sort((a, b) => a - b).map((i) => i + 1);
    line.textContent = !outList.length
      ? 'Tap 2 cm in from each lug, going round.'
      : outList.length === 1
        ? `Lug ${outList[0]} sits outside ±${LUG_WINDOW}¢. Adjust it and go round again.`
        : `Lugs ${listWords(outList)} sit outside ±${LUG_WINDOW}¢. Adjust them and go round again.`;
    return this.renderLugBar(k);
  }

  renderLugBar(k) {
    const bar = this.root.querySelector('.tuner-bar');
    if (bar) {
      // an empty bar is no bar: the toast and main padding key off .bar
      bar.classList.toggle('bar', k > 0);
      bar.classList.toggle('hidden', k === 0);
    }
  }

  // ---------------------------------------------------------------- actions
  openKit() {
    const gear = document.getElementById('chrome-gear-left');
    if (!gear) return;
    gear.click();
    const kit = document.querySelector('#settings #kit-list, #settings .kit-row');
    if (kit) kit.scrollIntoView({ block: 'start' });
  }

  pickFeel(id) {
    const f = FEELS[id];
    if (!f) return;
    const snapshot = applyFeel(id);
    if (!snapshot) return;
    if (snapshot.hits === 0) {
      // nothing in the kit has a role to retune: leave the store exactly as it was
      restoreFeel(snapshot);
      this.render();
      toast('No drums named snare, rack, floor or kick.', { action: 'EDIT KIT', onAction: () => this.openKit() });
      return;
    }
    this.render();
    const n = snapshot.hits;
    toast(`${f.label} loaded · ${f.voice} · ${nbsp(n, n === 1 ? 'drum' : 'drums')} retuned · ${nbsp(f.defaultBpm, 'BPM')}`, {
      action: 'UNDO',
      onAction: () => {
        restoreFeel(snapshot);
        this.render();
        this.focusAfterUndo('.feel-row.on, .feel-row');
      },
    });
  }

  save() {
    const d = this.drum();
    const hz = this.lastHz;
    if (!d || hz === null) return;
    const key = this.head === 'reso' ? 'resoHz' : 'targetHz';
    const prev = d[key] ?? null;
    const head = this.head;
    store.updateDrum(d.id, { [key]: r1(hz) });
    this.render();
    toast(`Saved ${hzText(hz)} · ${d.name} ${head}`, {
      action: 'UNDO',
      onAction: () => {
        store.updateDrum(d.id, { [key]: prev });
        this.render();
        this.focusAfterUndo('#tuner-save');
      },
    });
  }

  // the UNDO button vanished with its toast; keep keyboard focus on this screen
  focusAfterUndo(sel) {
    if (document.activeElement && document.activeElement !== document.body) return;
    const el = this.root.querySelector(sel);
    if (el && !el.disabled) el.focus();
  }

  // the reference tone: hear the target before you chase it
  playReference() {
    const hz = this.targetHz();
    const ctx = this.mic.audioContext;
    if (!hz || !ctx) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = hz;
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 1.5);
  }
}
