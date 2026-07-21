// Tuner: tap the head, read the pitch. Fundamental mode for the drum's voice,
// lug mode for going around the head and finding the odd lug out.

import { estimatePitch, hzToNote, centsBetween } from './dsp.js';
import { store } from './store.js';
import { theme } from './theme.js';

// Genre tone presets: ideal fundamentals (Hz) BY DRUM SIZE per genre.
// Diameter parsed from the drum name ("8x10" = depth x diameter); values
// interpolate between listed diameters. Launch points, not laws.
// Each genre is anchored to a player's sound:
//   ROCK  - Bonham: big, open, toms that sing, boomy 26" kick energy
//   PUNK  - Barker: piccolo-crack snare way up high, tight fast toms
//   METAL - Jordison: tight, hard, articulate, clicky kick
const TONES = {
  rock:  { label: 'ROCK · Bonham',
    tom: { 8: 190, 10: 160, 12: 130, 14: 105, 16: 85, 18: 72 },
    snare: { 13: 235, 14: 215 },
    kick: { 18: 58, 20: 55, 22: 52, 24: 48, 26: 45 } },
  punk:  { label: 'PUNK · Barker',
    tom: { 8: 210, 10: 175, 12: 145, 14: 112, 16: 95, 18: 80 },
    snare: { 13: 320, 14: 300 },
    kick: { 18: 72, 20: 68, 22: 65, 24: 60 } },
  metal: { label: 'METAL · Jordison',
    tom: { 8: 220, 10: 185, 12: 155, 14: 120, 16: 105, 18: 88 },
    snare: { 13: 290, 14: 265 },
    kick: { 18: 75, 20: 71, 22: 68, 24: 62 } },
};

function roleOf(name) {
  const n = name.toLowerCase();
  if (n.includes('snare')) return 'snare';
  if (n.includes('kick') || n.includes('bass')) return 'kick';
  if (n.includes('floor') || n.includes('rack') || n.includes('tom')) return 'tom';
  return null;
}

// "8x10" / "5.5x14" -> diameter (the second number, depth x diameter)
function diameterOf(name) {
  const m = name.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
  return m ? +m[2] : null;
}

const ROLE_DEFAULT_DIA = { tom: 12, snare: 14, kick: 22 };

// reso-over-batter ratio per genre: matched heads sustain longest (Bonham),
// reso ~3 semitones up gives the tight controlled bend (Barker/Jordison),
// snare-side heads run much tighter, kick fronts just above the batter
const RESO_FACTOR = {
  rock:  { tom: 1.06, snare: 1.42, kick: 1.02 },
  punk:  { tom: 1.19, snare: 1.50, kick: 1.05 },
  metal: { tom: 1.19, snare: 1.50, kick: 1.08 },
};

function toneHz(tone, role, dia) {
  const curve = tone[role];
  const keys = Object.keys(curve).map(Number).sort((a, b) => a - b);
  if (dia <= keys[0]) return curve[keys[0]];
  if (dia >= keys[keys.length - 1]) return curve[keys[keys.length - 1]];
  let lo = keys[0];
  for (const k of keys) {
    if (k <= dia) lo = k;
    else return Math.round(curve[lo] + ((dia - lo) / (k - lo)) * (curve[k] - curve[lo]));
  }
  return curve[lo];
}

const TONE_SKIP = 0.025;
const TONE_WINDOW = 0.35;

export class TunerMode {
  constructor(root, mic) {
    this.root = root;
    this.mic = mic;
    this.mode = 'fundamental';
    this.head = 'batter';
    this.heads = {}; // per-drum measured {batter, reso} this session
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
      const key = this.drumId || 'free';
      this.heads[key] = { ...(this.heads[key] || {}), [this.head]: hz };
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
    if (!drum) return null;
    return this.head === 'reso' ? (drum.resoHz ?? null) : drum.targetHz;
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
        <div class="seg" id="head-seg" role="tablist">
          <button data-h="batter" class="on">Batter</button>
          <button data-h="reso">Reso</button>
        </div>
        <select id="tuner-drum">
          <option value="">(no drum selected)</option>
          ${kit.map((d) => `<option value="${d.id}" ${d.id === this.drumId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <span class="dim">tone</span>
        ${Object.entries(TONES).map(([id, t]) => `<button class="chip" data-tone="${id}">${t.label}</button>`).join('')}
      </div>
      <div class="big-read">
        <div id="tuner-hz" class="huge">—</div>
        <div id="tuner-note" class="mid">tap the head</div>
        <canvas id="tuner-needle" width="640" height="120"></canvas>
        <div id="tuner-heads" class="mid"></div>
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
    this.root.querySelectorAll('#head-seg button').forEach((b) => {
      b.addEventListener('click', () => {
        this.head = b.dataset.h;
        this.root.querySelectorAll('#head-seg button').forEach((x) => x.classList.toggle('on', x === b));
        this.updateReadout();
      });
    });
    this.root.querySelectorAll('[data-tone]').forEach((b) => {
      b.addEventListener('click', () => {
        const tone = TONES[b.dataset.tone];
        let hits = 0;
        for (const d of store.get('kit')) {
          const role = roleOf(d.name);
          if (!role) continue;
          const dia = diameterOf(d.name) || ROLE_DEFAULT_DIA[role];
          const batter = toneHz(tone, role, dia);
          store.updateDrum(d.id, {
            targetHz: batter,
            resoHz: Math.round(batter * RESO_FACTOR[b.dataset.tone][role]),
          });
          hits++;
        }
        this.render();
        this.flashStatus(hits
          ? `${tone.label} set on ${hits} drums — his ballpark, your ears finish it`
          : 'no drums matched — name them snare / rack / floor / kick in settings');
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
        const patch = this.head === 'reso'
          ? { resoHz: Math.round(hz * 10) / 10 }
          : { targetHz: Math.round(hz * 10) / 10 };
        store.updateDrum(drum.id, patch);
        this.flashStatus(`saved ${hz.toFixed(1)} Hz as ${this.head} target for ${drum.name}`);
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
      noteEl.textContent = `${hzToNote(this.lastHz)} · ${cents >= 0 ? '+' : ''}${cents.toFixed(0)} cents vs ${this.head} target ${target} Hz`;
      this.drawNeedle(cents);
    } else {
      noteEl.textContent = `~${hzToNote(this.lastHz)} (no target saved)`;
      this.drawNeedle(null);
    }
    if (this.mode === 'lug') this.renderLugs();
    this.renderHeads();
  }

  // the drum's voice is the RELATIONSHIP between its two heads — say it plainly
  renderHeads() {
    const el = this.root.querySelector('#tuner-heads');
    if (!el) return;
    const m = this.heads[this.drumId || 'free'] || {};
    if (!m.batter || !m.reso) {
      el.textContent = this.head === 'batter'
        ? 'now tap the reso head (flip or reach under) to see the pair'
        : 'tap the batter head too to see the pair';
      if (!m.batter && !m.reso) el.textContent = '';
      return;
    }
    const st = 12 * Math.log2(m.reso / m.batter);
    const feel = Math.abs(st) < 0.3
      ? 'matched — longest, purest sustain'
      : st > 0
        ? 'reso above — pitch bends down, tighter and more controlled'
        : 'reso below — fatter, shorter, deader';
    el.textContent = `batter ${m.batter.toFixed(1)} Hz · reso ${m.reso.toFixed(1)} Hz · ${st >= 0 ? '+' : ''}${st.toFixed(1)} semitones (${feel})`;
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
    const T = theme();
    ctx.strokeStyle = T.line;
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
    ctx.strokeStyle = Math.abs(cents) <= store.get('tuneToleranceCents') ? T.green : T.pink;
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
