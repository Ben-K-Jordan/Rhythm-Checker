// Tuner: tap the head, read the cents against your target on an arc gauge.
// Two heads per drum, player feels sized to your drums, and a lug pass that
// finds the odd lug out.

import { estimatePitch, hzToNote, centsBetween } from './dsp.js';
import { store } from './store.js';
import { FEELS, applyFeel, restoreFeel, feelTargetFor, roleOf } from './feel.js';
import { icon, fmtSigned, nbsp, monitorSize, announce, toast, seg, esc } from './ui.js';

const TONE_SKIP = 0.025;
const TONE_WINDOW = 0.35;
const STALE_MS = 8000;      // --d-stale
const LUG_WINDOW = 15;      // cents from the median before a lug is called out
const LUG_MIN = 3, LUG_MAX = 16, LUG_DEFAULT = 6;
const REF_LEN = 1.5;        // s the LISTEN tone sounds
const REF_TAIL = 0.25;      // s after it stops before the mic is trusted again

// gauge geometry (spec 8.3): viewBox 300 x 170, centre (150,160), r 118, ±50¢ ↔ ±70°
const GX = 150, GY = 160, GR = 118, GSPAN = 70;
const NEEDLE = GR - 12;

const r1 = (x) => Math.round(x * 10) / 10;
// targets read in whole Hz above 100 Hz; kick-range pitches keep a decimal
const fmtHz = (hz) => String(hz >= 100 ? Math.round(hz) : r1(hz));
const hzText = (hz) => nbsp(fmtHz(hz), 'Hz');
// toast separators: the NBSP keeps each "·" on the line it closes
const SEP = '\u00a0· ';

// status-slot lines (the idle line and the LISTEN line are built per drum)
const NO_PITCH = 'No clear pitch. Let the head ring.';
const PAIR_RESO = 'Now tap the reso to see the pair.';
const PAIR_BATTER = 'Tap the batter too to see the pair.';
const refText = (hz) => `Playing ${hzText(hz)}. Tap after it stops.`;

// live monitor sizes (--t-monitor, -4, -5), largest first
const MONITOR_STEPS = [120, 96, 72, 60]; // 60: a 5-glyph sharp reading at 320 px

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function listWords(nums) {
  if (nums.length < 2) return String(nums[0]);
  return `${nums.slice(0, -1).join(', ')} and ${nums[nums.length - 1]}`;
}

// minus / plus for the lug stepper, drawn like ui.js icons (the bundled
// fonts' minus sits low and thin next to their plus)
const stepIcon = (d) => '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
  + `<path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square" d="${d}"/></svg>`;

// a stored lug count, or null when there is none worth trusting
function lugCountOf(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(LUG_MIN, Math.min(LUG_MAX, Math.round(v)));
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
// More lugs means smaller slots on a wider ring (sizes mirror tuner.css), so
// neighbours never overlap: 16 slots still leave a gap between dots.
function lugGeom(n) {
  if (n <= 10) return { box: 132, ring: 52, dot: 26, cls: '' };
  if (n <= 12) return { box: 132, ring: 54, dot: 22, cls: ' lug-ring--m' };
  return { box: 148, ring: 63, dot: 20, cls: ' lug-ring--s' };
}

function lugDiagram(n, taps, next, outIdx, head) {
  const g = lugGeom(n);
  const c = g.box / 2, half = g.dot / 2;
  const slots = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = c + g.ring * Math.sin(a) - half, y = c - g.ring * Math.cos(a) - half;
    const cls = i === next ? 'is-next' : outIdx.has(i) ? 'is-out' : i < taps ? 'is-done' : 'is-empty';
    slots.push(`<span class="lug-dot ${cls}" style="left:${f1(x)}px;top:${f1(y)}px">${i + 1}</span>`);
  }
  return `
    <div class="lug-ring${g.cls}" role="img" aria-label="Lug pass, ${taps} of ${n} lugs tapped">
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
    this.lugPassN = null; // slot count the current lug pass was tapped against
    this._epoch = 0;      // bumps whenever a hit still being analysed would land somewhere else
    this._ref = null;     // LISTEN tone on the audio clock: {osc, from, until}
    this._refTimer = null;
    this._toast = null;   // the toast this screen raised: {handle, el}
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

  activate() {
    this.mic.setDetectorOptions({ refractory: 0.3, threshold: 5, minLevel: 0.012 });
    // Home's player feel or the settings sheet may have retuned the kit
    this.render();
    this.startTicker();
  }

  deactivate() {
    this.stopTicker();
    this._epoch++;        // a hit still being analysed belongs to this visit only
    this.stopReference();
    // UNDO belongs to this screen: once it is gone, other screens would keep
    // showing the targets an UNDO from here is about to put back
    this.closeToast();
  }

  onOnset(onset) {
    if (!this.root.classList.contains('active')) return;
    // the phone's own reference tone is not a drum
    if (this.hearsReference(onset.time)) return;
    this._lastOnsetTime = onset.time;
    // the hit belongs to what was selected when it landed, not to whatever
    // is selected ~0.4 s later when the analysis finishes
    const take = { drumId: this.drumId, head: this.head, mode: this.mode, epoch: this._epoch };
    setTimeout(() => this.analyse(onset, take), (TONE_SKIP + TONE_WINDOW) * 1000 + 60);
  }

  // still the same drum, head, mode and pass the hit was struck on?
  isCurrent(take) {
    return take.epoch === this._epoch && take.drumId === this.drumId
      && take.head === this.head && take.mode === this.mode
      && this.root.classList.contains('active');
  }

  analyse(onset, take) {
    // selection changed mid-analysis, or LISTEN started inside the window:
    // drop it silently rather than file it under the wrong drum
    if (!this.isCurrent(take) || this.hearsReference(onset.time)) return;
    const next = this._lastOnsetTime > onset.time ? this._lastOnsetTime : null;
    const dur = Math.min(TONE_WINDOW, (next ? next - 0.01 - onset.time : Infinity) - TONE_SKIP);
    const win = dur > 0 ? this.mic.grabWindow(onset.time + TONE_SKIP, dur) : null;
    if (!win) return;
    const pre = this.mic.grabWindow(onset.time - TONE_WINDOW - 0.01, TONE_WINDOW);
    const hz = estimatePitch(win, this.mic.audioContext.sampleRate, pre);
    if (hz === null) {
      this.flashStatus(NO_PITCH);
      announce(NO_PITCH);
      return;
    }
    this.status = null;
    if (take.mode === 'lug') {
      this.addLugTap(hz);
    } else {
      this.reading = { drumId: take.drumId, head: take.head, hz, at: performance.now() };
      this.startTicker();
      const key = take.drumId || 'free';
      this.heads[key] = { ...(this.heads[key] || {}), [take.head]: hz };
    }
    this.updateReadout();
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

  // This drum's lug count (kit entry `lugs`), else the last count chosen
  // anywhere (store `lugCount`), else 6.
  lugSlots() {
    const d = this.drum();
    return (d && lugCountOf(d.lugs)) ?? lugCountOf(store.get('lugCount')) ?? LUG_DEFAULT;
  }

  setLugCount(n) {
    const next = lugCountOf(n);
    if (next === null || next === this.lugSlots()) return;
    const d = this.drum();
    if (d) store.updateDrum(d.id, { lugs: next });
    // also the fallback for drums without their own count, and what survives
    // a relaunch while the store's kit validation keeps only known fields
    store.set('lugCount', next);
    const had = this.lugTaps.length > 0;
    this.resetLugPass(); // taps against the old count no longer map to lugs
    this.updateReadout();
    announce(had ? `${next} lugs. Lug pass cleared.` : `${next} lugs.`);
  }

  // The pass is only valid for the count it was tapped against: a count
  // changed from anywhere (stepper, UNDO, import) starts it over.
  syncLugPass() {
    const n = this.lugSlots();
    if (n !== this.lugPassN) {
      if (this.lugTaps.length) this.resetLugPass();
      this.lugPassN = n;
    }
    return n;
  }

  resetLugPass() {
    this.lugTaps = [];
    this.lugNext = 0;
    this.lugPassN = this.lugSlots();
    this._epoch++; // a tap still being analysed belongs to the old pass
  }

  addLugTap(hz) {
    const n = this.syncLugPass();
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
    this.lugPassN = null;
    this._lastState = '';
    this._epoch++;
  }

  setDrum(id) {
    if (id === this.drumId) return;
    this.stopReference(); // that tone was the last drum's target
    this.drumId = id;
    this.clearReading();
    this.render();
  }

  setHead(head) {
    const h = head === 'reso' ? 'reso' : 'batter';
    if (h === this.head) return;
    this.stopReference();
    this.head = h;
    this.clearReading(); // a lug pass is per head too
    this.render();
  }

  setMode(mode) {
    this.mode = mode === 'lug' ? 'lug' : 'fund';
    this.status = null;
    this._epoch++; // a pitch hit still being analysed must not become lug 1
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
    // The rebuild forces layout while the screen is half built (seg() measures
    // the chip row), and <main> clamps its scroll to that shorter page. Put
    // the scroll back afterwards, so a tap never throws the page to the top.
    const scroller = this.root.closest('main');
    const keepTop = scroller ? scroller.scrollTop : 0;
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
    // seg() fades the right edge until the row's end; once the row is
    // scrolled, a chip cut at the left edge fades out the same way
    chips.addEventListener('scroll', () => chips.classList.toggle('is-scrolled', chips.scrollLeft > 1), { passive: true });
    chips.dispatchEvent(new Event('scroll')); // re-measure both fades with EDIT KIT in the row
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
        this.resetLugPass();
        this.status = null;
        this.updateReadout();
        // START OVER hides with the empty pass: keep focus on the pass, not <body>
        $('#lug-panel').focus();
        announce('Lug pass cleared.');
      });
      // aria-disabled, not disabled, at the ends: focus stays on the button
      const step = (d) => (e) => {
        if (e.currentTarget.getAttribute('aria-disabled') === 'true') return;
        this.setLugCount(this.lugSlots() + d);
      };
      $('#lug-less').addEventListener('click', step(-1));
      $('#lug-more').addEventListener('click', step(1));
    } else {
      // plain buttons, not seg(): tapping the feel that is already on
      // re-applies it (its targets and tempo come back, with UNDO)
      this.root.querySelectorAll('.feel-row').forEach((b) => {
        b.addEventListener('click', () => this.pickFeel(b.dataset.feel));
      });
      $('#tuner-feel-none').addEventListener('click', () => this.clearFeel());
      $('#tuner-listen').addEventListener('click', () => this.playReference());
      $('#tuner-save').addEventListener('click', () => this.save());
    }
    this.updateReadout();
    if (scroller && scroller.scrollTop !== keepTop) scroller.scrollTop = keepTop;
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
    // NONE drops the feel label only: targets, tempo and runs stay as they are
    const off = !(feel && FEELS[feel]);
    const none = `<button type="button" class="feel-none${off ? ' on' : ''}" id="tuner-feel-none" data-feel="none" aria-pressed="${off}" aria-label="NONE, no player feel. Kit targets stay.">NONE</button>`;
    // Everything above the gauge keeps its height from idle to reading, so
    // the gauge (the reference) never moves between taps: the age caption and
    // the Hz line hold their place while empty, the status slot is as tall as
    // the tallest line it can show, and the batter/reso pair sits below.
    const sizers = this.statusLines().map((t) => `<span class="tuner-slot__size" aria-hidden="true">${esc(t)}</span>`).join('');
    return `
      <section class="tuner-read">
        <div class="monitor__cap tuner-cap is-off" id="tuner-cap">LAST TAP</div>
        <div class="tuner-mon">
          <div class="monitor is-idle"><b id="gauge-cents">—</b><span class="monitor__side"><i class="unit" id="tuner-unit">${target ? '¢' : 'Hz'}</i></span></div>
          <div class="tuner-dir"><span id="gauge-state" class="dir hidden"></span><span class="chip chip--ok tuner-intune hidden" id="tuner-tol"></span></div>
        </div>
        <div class="tuner-hzline">
          <span id="gauge-note" class="${target ? 'is-off' : 'hidden'}"></span>
          ${target ? `<span id="gauge-target">VS ${hzText(target)} · ${esc(this.targetSource())}</span>` : ''}
        </div>
        <div class="tuner-slot">${sizers}<p id="tuner-status" class="tuner-status hidden"></p></div>
      </section>
      <div class="card tuner-notarget${target ? ' hidden' : ''}"><p${target ? '' : ' id="gauge-target"'}>No target yet. Tap, then save.</p></div>
      <div class="card gauge-card${target ? '' : ' hidden'}">
        <span class="gauge-legend"><i aria-hidden="true"></i>in tune ±${tol}¢</span>
        <div class="gauge-stage">${gaugeSVG(tol)}</div>
        <span class="gauge-end gauge-end--flat" aria-hidden="true">FLAT</span>
        <span class="gauge-end gauge-end--sharp" aria-hidden="true">SHARP</span>
      </div>
      <p id="tuner-heads" class="tuner-pair hidden"></p>
      <section class="tuner-feel" aria-labelledby="tuner-feel-title">
        <div class="sec-head">
          <h2 class="sec-head__stamp" id="tuner-feel-title">PLAYER FEEL</h2>
          ${tunable ? `<span class="sec-head__aside">RETUNES ALL ${tunable} DRUMS</span>` : ''}
        </div>
        <div class="seg seg--tall tuner-feel__seg" role="group" aria-labelledby="tuner-feel-title">${rows}${none}</div>
      </section>`;
  }

  lugHTML() {
    return `
      <div id="lug-panel" class="card lug-panel" role="group" aria-label="Lug pass" tabindex="-1">
        <div class="lug-count">
          <span class="lug-count__label" id="lug-count-label">LUGS ON THIS DRUM</span>
          <span class="chip lug-progress" id="lug-progress"></span>
          <div class="lug-count__ctl" role="group" aria-labelledby="lug-count-label">
            <button type="button" id="lug-less" class="lug-count__btn" aria-label="Fewer lugs" aria-describedby="lug-count">${stepIcon('M5 12h14')}</button>
            <span id="lug-count" class="lug-count__n">${this.lugSlots()}</span>
            <button type="button" id="lug-more" class="lug-count__btn" aria-label="More lugs" aria-describedby="lug-count">${stepIcon('M5 12h14M12 5v14')}</button>
          </div>
        </div>
        <div class="lug-top">
          <div class="lug-diagram" id="lug-diagram"></div>
          <div id="lug-verdict" class="lug-verdict">
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

  // every line the pitch status slot can show for this drum + head
  statusLines() {
    const lines = [this.idleText(), NO_PITCH, PAIR_RESO, PAIR_BATTER];
    const target = this.targetHz();
    if (target) lines.push(refText(target));
    return lines;
  }

  // one head of this drum read, the other not yet
  // until both heads are read, ask for the other one; then sum up the pair in
  // one line here, above the gauge (the full comparison sits under it)
  pairPrompt() {
    const m = this.heads[this.drumId || 'free'] || {};
    if (m.batter && m.reso) {
      const st = 12 * Math.log2(m.reso / m.batter);
      if (Math.abs(st) < 0.3) return 'Batter and reso at the same pitch.';
      return `Reso ${nbsp(Math.abs(st).toFixed(1), 'semitones')} ${st > 0 ? 'above' : 'below'} batter.`;
    }
    return m.batter ? PAIR_RESO : m.reso ? PAIR_BATTER : '';
  }

  flashStatus(msg) {
    this.status = msg;
    this.renderStatus();
  }

  renderStatus() {
    const el = this.root.querySelector('#tuner-status');
    if (!el) return;
    const fund = this.mode === 'fund';
    // while LISTEN plays, say why taps are not being read
    const playing = this._refTimer !== null && this._ref ? this._ref.msg : '';
    const text = playing || this.status
      || (fund ? (this.lastHz === null ? this.idleText() : this.pairPrompt()) : '');
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }

  // A narrow phone can't hold a 120 px number beside SHARP or IN TUNE: step
  // down the monitor sizes until the number, its unit and the direction word
  // sit side by side with the row's gap between them. Fit against the widest
  // word, not the current one, so -27 FLAT and +14 SHARP come out the same size.
  fitMonitor(el, value) {
    const steps = MONITOR_STEPS.slice(MONITOR_STEPS.indexOf(monitorSize(value)));
    const row = el.closest('.tuner-mon');
    const dir = row && row.querySelector('.tuner-dir');
    el.style.fontSize = `${steps[0]}px`;
    if (!dir || !row.clientWidth) return; // not on screen: activate() renders again
    const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
    const dirW = Math.max(dir.getBoundingClientRect().width, this.widestDirWord());
    const fits = () => el.parentElement.scrollWidth + gap + dirW <= row.clientWidth;
    for (let i = 1; i < steps.length && !fits(); i++) el.style.fontSize = `${steps[i]}px`;
  }

  // width of the widest direction word in the .dir font, measured once
  widestDirWord() {
    if (this._dirWordW) return this._dirWordW;
    const word = this.root.querySelector('#gauge-state');
    if (!word || !document.fonts.check('30px Anton')) return 0;
    const cs = getComputedStyle(word);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const track = parseFloat(cs.letterSpacing) || 0;
    this._dirWordW = Math.max(...['SHARP', 'FLAT', 'IN TUNE'].map((w) => ctx.measureText(w).width + track * w.length));
    return this._dirWordW;
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
    monitor.classList.toggle('is-idle', hz === null);
    unitEl.textContent = target ? '¢' : 'Hz';
    stateEl.textContent = state;
    stateEl.classList.toggle('hidden', !state);
    tolEl.innerHTML = inTune ? `${icon('check')}±${tol}¢` : '';
    tolEl.classList.toggle('hidden', !inTune);
    this.fitMonitor(centsEl, value);
    // with a target the Hz line keeps its place while idle (a hidden
    // placeholder holds the line), so the first tap doesn't push the gauge
    const showNote = hz !== null && !!target;
    noteEl.innerHTML = showNote
      ? `${esc(nbsp(hz.toFixed(1), 'Hz'))}<span class="tuner-note"> · ${esc(hzToNote(hz))}</span>`
      : esc(nbsp('—', 'Hz'));
    noteEl.classList.toggle('is-off', !showNote);
    noteEl.classList.toggle('hidden', !target);

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
      // kept in flow, unseen: the caption's line stays reserved
      cap.classList.add('is-off');
      read.classList.remove('is-stale');
      return;
    }
    const age = performance.now() - r.at;
    cap.textContent = `LAST TAP · ${nbsp(Math.floor(age / 1000), 's')} AGO`;
    cap.classList.remove('is-off');
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

  // the batter/reso comparison, under the gauge; until both heads are read
  // the status slot above the gauge prompts for the other one
  renderHeads() {
    const el = this.root.querySelector('#tuner-heads');
    if (!el) return;
    const m = this.heads[this.drumId || 'free'] || {};
    let text = '';
    if (m.batter && m.reso) {
      const st = 12 * Math.log2(m.reso / m.batter);
      // the semitone gap is in the status slot above the gauge; this line
      // gives both readings and what the gap does, so any part of it that
      // shows above the bar still reads as a whole fact
      const how = Math.abs(st) < 0.3
        ? 'Same pitch: longest sustain.'
        : st > 0
          ? 'Reso above: the pitch bends down after the hit.'
          : 'Reso below: shorter, fatter.';
      text = `Batter ${nbsp(m.batter.toFixed(1), 'Hz')} · reso ${nbsp(m.reso.toFixed(1), 'Hz')}. ${how}`;
    }
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }

  renderLugs() {
    const list = this.root.querySelector('#lug-list');
    if (!list) return;
    const n = this.syncLugPass();
    this.renderLugCount(n);
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
    // tuner.css sizes the number to fit its column (a 16-lug ring is wider)
    spread.style.setProperty('--glyphs', String(String(worst).length + 1));
    this.root.querySelector('#lug-median').textContent = `median ${nbsp(med.toFixed(1), 'Hz')}`;

    const outList = [...out].sort((a, b) => a - b).map((i) => i + 1);
    line.textContent = !outList.length
      ? 'Tap 2 cm in from each lug, going round.'
      : outList.length === 1
        ? `Lug ${outList[0]} sits outside ±${LUG_WINDOW}¢. Adjust it and go round again.`
        : `Lugs ${listWords(outList)} sit outside ±${LUG_WINDOW}¢. Adjust them and go round again.`;
    return this.renderLugBar(k);
  }

  renderLugCount(n) {
    const out = this.root.querySelector('#lug-count');
    if (!out) return;
    out.textContent = String(n);
    const less = this.root.querySelector('#lug-less');
    const more = this.root.querySelector('#lug-more');
    less.setAttribute('aria-disabled', String(n <= LUG_MIN));
    more.setAttribute('aria-disabled', String(n >= LUG_MAX));
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
    // the whole strip (NONE included) stays tappable while the toast is up
    const strip = () => this.root.querySelector('.tuner-feel__seg');
    if (snapshot.hits === 0) {
      // nothing in the kit has a role to retune: leave the store exactly as it was
      restoreFeel(snapshot);
      this.render();
      this.showToast('No drums named snare, rack, floor or kick.', { action: 'EDIT KIT', onAction: () => this.openKit() }, strip());
      return;
    }
    this.render();
    const n = snapshot.hits;
    this.showToast(`${f.label} loaded${SEP}${f.voice}${SEP}${nbsp(n, n === 1 ? 'drum' : 'drums')} retuned${SEP}${nbsp(f.defaultBpm, 'BPM')}`, {
      returnFocus: () => this.firstShown('.feel-row.on', '#tuner-feel-none', '[data-mode].on'),
      action: 'UNDO',
      onAction: () => {
        restoreFeel(snapshot);
        this.render();
        this.focusAfterUndo('.feel-row.on', '#tuner-feel-none', '[data-mode].on');
      },
    }, strip());
  }

  // NONE: forget the feel, keep everything it wrote (kit targets, tempo, runs)
  clearFeel() {
    const prev = store.get('feel');
    if (!prev) return; // already none
    store.set('feel', null);
    this.render();
    this.showToast('Feel cleared. Kit targets kept.', {
      returnFocus: () => this.firstShown('.feel-row.on', '#tuner-feel-none', '[data-mode].on'),
      action: 'UNDO',
      onAction: () => {
        store.set('feel', prev);
        this.render();
        this.focusAfterUndo('.feel-row.on', '#tuner-feel-none', '[data-mode].on');
      },
    }, this.root.querySelector('.tuner-feel__seg'));
  }

  save() {
    const r = this.reading;
    const d = this.drum();
    // lastHz is null unless the reading was measured on this very drum + head
    if (!d || !r || this.lastHz === null) return;
    const hz = r.hz;
    const head = r.head;
    const key = head === 'reso' ? 'resoHz' : 'targetHz';
    const prev = d[key] ?? null;
    store.updateDrum(r.drumId, { [key]: r1(hz) });
    this.render();
    this.showToast(`Saved ${hzText(hz)}${SEP}${d.name}\u00a0${head}`, {
      returnFocus: () => this.firstShown('#tuner-save', '[data-head].on'),
      action: 'UNDO',
      onAction: () => {
        store.updateDrum(r.drumId, { [key]: prev });
        this.render();
        this.focusAfterUndo('#tuner-save', '[data-head].on');
      },
    }, this.root.querySelector('.gauge-card:not(.hidden)'));
  }

  // the UNDO button vanished with its toast; keep keyboard focus on this screen
  focusAfterUndo(...sels) {
    if (document.activeElement && document.activeElement !== document.body) return;
    const el = this.firstShown(...sels);
    if (el) el.focus();
  }

  // the first of these that is on screen and enabled; in LUGS mode the feel
  // rows exist but are not shown
  firstShown(...sels) {
    for (const sel of sels) {
      const el = this.root.querySelector(sel);
      if (el && !el.disabled && el.getClientRects().length) return el;
    }
    return null;
  }

  // toast() keeps one toast on screen; remember which one is ours. `clear` is
  // the block the user just acted on: toast() scrolls it out from under itself.
  showToast(text, opts, clear = null) {
    const handle = toast(text, { ...opts, keepClear: clear });
    const box = document.getElementById('toast');
    // toast() builds a fresh text node per call: while that node is still in
    // the document, the toast on screen is this one
    this._toast = { handle, el: box && box.querySelector('.toast__text') };
  }

  // close our toast, never one another screen has raised since
  closeToast() {
    const t = this._toast;
    this._toast = null;
    if (t && t.el && t.el.isConnected) t.handle.close();
  }

  // the reference tone: hear the target before you chase it. The mic hears
  // it too, so hits are ignored until it has stopped and the room settled.
  playReference() {
    const hz = this.targetHz();
    const ctx = this.mic.audioContext;
    if (!hz || !ctx) return;
    this.stopReference();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = hz;
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + REF_LEN - 0.1);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + REF_LEN);
    this._ref = { osc, from: t, until: t + REF_LEN + this.refTail(ctx), msg: refText(hz) };
    this._refTimer = setTimeout(() => this.endReference(), (this._ref.until - t) * 1000);
    this.renderStatus();
  }

  // the tone's way back into the mic (output + input lag) plus the room ringing
  refTail(ctx) {
    const cal = store.get('calibrationMs');
    const measured = typeof cal === 'number' && cal > 0 ? cal / 1000 : 0;
    const lag = Math.max((ctx.outputLatency || 0) + (ctx.baseLatency || 0), measured);
    return REF_TAIL + Math.min(0.5, lag);
  }

  // would a hit at this audio time be analysed over the tone or its tail?
  hearsReference(onsetTime) {
    const r = this._ref;
    return !!r && onsetTime < r.until && onsetTime + TONE_SKIP + TONE_WINDOW > r.from;
  }

  // the tone and its tail are over: the status line goes back to normal
  endReference() {
    if (this._refTimer === null) return;
    clearTimeout(this._refTimer);
    this._refTimer = null;
    this.renderStatus();
  }

  stopReference() {
    const r = this._ref;
    this.endReference();
    if (!r) return;
    try { r.osc.stop(); } catch { /* already stopped */ }
    const ctx = this.mic.audioContext;
    // cut short: the tail now runs from here
    if (ctx) r.until = Math.min(r.until, ctx.currentTime + this.refTail(ctx));
  }
}
