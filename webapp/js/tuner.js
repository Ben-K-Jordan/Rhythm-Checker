// Tuner: tap the head, read the truth on an analog cents gauge. Two heads
// per drum, feel presets sized to your drums, lug mode for the odd lug out.

import { estimatePitch, hzToNote, centsBetween } from './dsp.js';
import { store } from './store.js';
import { FEELS, applyFeel, feelTargetFor } from './feel.js';

const TONE_SKIP = 0.025;
const TONE_WINDOW = 0.35;

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

export class TunerMode {
  constructor(root, mic) {
    this.root = root;
    this.mic = mic;
    this.mode = 'fund'; // 'fund' | 'lug'
    this.head = 'batter';
    this.heads = {};    // per-drum measured {batter, reso} this session
    this.drumId = null;
    this.lastHz = null;
    this.lugTaps = [];
    this.render();
    mic.addEventListener('onset', (e) => this.onOnset(e.detail));
  }

  activate() {
    this.mic.setDetectorOptions({ refractory: 0.3, threshold: 5, minLevel: 0.012 });
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
        this.flashStatus('no clear pitch — let the head ring (near a lug for lug mode)');
        return;
      }
      this.lastHz = hz;
      const key = this.drumId || 'free';
      this.heads[key] = { ...(this.heads[key] || {}), [this.head]: hz };
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
    if (this.drumId && !kit.some((d) => d.id === this.drumId)) {
      this.drumId = null;
      this.lugTaps = [];
    }
    const feel = store.get('feel');
    const drum = kit.find((d) => d.id === this.drumId);
    this.root.innerHTML = `
      <div class="title-stamp">TUNER</div>

      <div class="drum-chips">
        ${kit.map((d) => `<button class="pill ${d.id === this.drumId ? 'on' : ''}" data-drum="${esc(d.id)}">${esc(d.name)}</button>`).join('')}
      </div>

      <div class="head-row">
        <span class="chip-stamp">Head</span>
        <select id="tuner-head" class="drop">
          <option value="batter" ${this.head === 'batter' ? 'selected' : ''}>BATTER</option>
          <option value="reso" ${this.head === 'reso' ? 'selected' : ''}>RESO</option>
        </select>
        <span class="head-spacer"></span>
        <button class="pill ${this.mode === 'fund' ? 'on' : ''}" data-mode="fund">FUNDAMENTAL</button>
        <button class="pill ${this.mode === 'lug' ? 'on' : ''}" data-mode="lug">LUG MATCH</button>
      </div>

      <div class="gauge-card">
        <div id="gauge-state" class="gauge-state">TAP THE HEAD</div>
        <div class="gauge-stage">
          <svg viewBox="0 0 260 150" preserveAspectRatio="none">
            <path d="M20 140 A110 110 0 0 1 41 75.3" fill="none" stroke="#e0301e" stroke-width="13"/>
            <path d="M41 75.3 A110 110 0 0 1 96 35.4" fill="none" stroke="#e8b23a" stroke-width="13"/>
            <path d="M96 35.4 A110 110 0 0 1 164 35.4" fill="none" stroke="#3a7d34" stroke-width="13"/>
            <path d="M164 35.4 A110 110 0 0 1 219 75.3" fill="none" stroke="#e8b23a" stroke-width="13"/>
            <path d="M219 75.3 A110 110 0 0 1 240 140" fill="none" stroke="#e0301e" stroke-width="13"/>
          </svg>
          <div id="gauge-needle" class="gauge-needle idle"></div>
          <div class="gauge-pivot"></div>
          <span class="gauge-flat">&#9837; FLAT</span>
          <span class="gauge-sharp">SHARP &#9839;</span>
        </div>
        <div class="gauge-read">
          <span id="gauge-cents" class="gauge-cents">&mdash;</span>
          <span class="gauge-note-wrap">
            <span id="gauge-note" class="gauge-note">tap the head, let it ring</span>
            <span id="gauge-target" class="gauge-target">${this.targetHz() ? `TARGET ${this.targetHz()} Hz` : 'NO TARGET SAVED'}</span>
          </span>
        </div>
        <div id="tuner-heads" class="heads-line"></div>
        <div id="tuner-status" class="tuner-status"></div>
      </div>

      <div id="lug-panel" class="lug-panel ${this.mode === 'lug' ? '' : 'hidden'}">
        <div class="lug-row" id="lug-list"></div>
        <div class="lug-foot">
          <button id="lug-clear" class="pill">CLEAR PASS</button>
          <span id="lug-verdict" class="lug-verdict"></span>
        </div>
      </div>

      <div class="tuning-stack ${this.mode === 'lug' ? 'hidden' : ''}">
        <span class="chip-stamp">Tuning</span>
        ${Object.entries(FEELS).map(([id, f]) => {
    const hz = drum ? feelTargetFor(id, drum, this.head) : null;
    return `
          <button class="feel-row ${feel === id ? 'on' : ''}" data-feel="${id}">
            <span class="fr-dot"></span>
            <span class="fr-body"><span class="fr-name">${f.label}</span><span class="fr-voice">${f.voice}</span></span>
            <span class="fr-target">${hz ? `<b>${hz}<i> Hz</i></b><em>${hzToNote(hz)}</em>` : `<b>&mdash;</b><em>pick a drum</em>`}</span>
          </button>`;
  }).join('')}
      </div>

      <div class="tuner-actions">
        <button id="tuner-listen" class="btn" ${this.targetHz() ? '' : 'disabled'}>LISTEN
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#141210" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>
        </button>
        <button id="tuner-save" class="btn red" disabled>SAVE AS TARGET</button>
      </div>`;

    this.root.querySelectorAll('[data-drum]').forEach((b) => {
      b.addEventListener('click', () => {
        this.drumId = this.drumId === b.dataset.drum ? null : b.dataset.drum;
        this.lugTaps = [];
        this.render();
      });
    });
    this.root.querySelector('#tuner-head').addEventListener('change', (e) => {
      this.head = e.target.value;
      this.render();
    });
    this.root.querySelectorAll('[data-mode]').forEach((b) => {
      b.addEventListener('click', () => {
        this.mode = b.dataset.mode;
        this.lugTaps = [];
        this.render();
      });
    });
    this.root.querySelectorAll('[data-feel]').forEach((b) => {
      b.addEventListener('click', () => {
        const feel = FEELS[b.dataset.feel];
        const hits = applyFeel(b.dataset.feel);
        this.render();
        this.flashStatus(hits
          ? `${feel.label}: ${hits} drums · ${feel.defaultBpm} BPM · picks up top in Rudiments — his ballpark, your ears finish it`
          : 'no drums matched — name them snare / rack / floor / kick in settings');
      });
    });
    this.root.querySelector('#tuner-listen').addEventListener('click', () => this.playReference());
    this.root.querySelector('#tuner-save').addEventListener('click', () => {
      const d = store.get('kit').find((x) => x.id === this.drumId);
      const hz = this.mode === 'lug' && this.lugTaps.length ? median(this.lugTaps) : this.lastHz;
      if (d && hz) {
        const patch = this.head === 'reso'
          ? { resoHz: Math.round(hz * 10) / 10 }
          : { targetHz: Math.round(hz * 10) / 10 };
        store.updateDrum(d.id, patch);
        this.flashStatus(`saved ${hz.toFixed(1)} Hz as ${this.head} target for ${d.name}`);
        this.render();
      }
    });
    this.root.querySelector('#lug-clear').addEventListener('click', () => {
      this.lugTaps = [];
      this.updateReadout();
    });
    if (this.lastHz !== null) this.updateReadout();
  }

  // the reference tone: hear the target before you chase it
  playReference() {
    const hz = this.targetHz();
    if (!hz) return;
    const ctx = this.mic.audioContext;
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

  flashStatus(msg) {
    const el = this.root.querySelector('#tuner-status');
    if (!el) return;
    el.textContent = msg;
    clearTimeout(this._statusT);
    this._statusT = setTimeout(() => { el.textContent = ''; }, 3500);
  }

  updateReadout() {
    const centsEl = this.root.querySelector('#gauge-cents');
    const noteEl = this.root.querySelector('#gauge-note');
    const targetEl = this.root.querySelector('#gauge-target');
    const stateEl = this.root.querySelector('#gauge-state');
    const needle = this.root.querySelector('#gauge-needle');
    const saveBtn = this.root.querySelector('#tuner-save');
    saveBtn.disabled = !this.drumId || (!this.lastHz && !this.lugTaps.length);
    if (this.lastHz === null) return;
    const target = this.targetHz();
    noteEl.textContent = `${hzToNote(this.lastHz)} · ${this.lastHz.toFixed(1)} Hz`;
    targetEl.textContent = target ? `TARGET ${target} Hz` : 'NO TARGET SAVED';
    needle.classList.remove('idle');
    if (target) {
      const cents = centsBetween(this.lastHz, target);
      const tol = store.get('tuneToleranceCents');
      centsEl.textContent = `${cents >= 0 ? '+' : ''}${cents.toFixed(0)}¢`;
      centsEl.className = `gauge-cents ${Math.abs(cents) <= tol ? 'good' : 'off'}`;
      stateEl.textContent = Math.abs(cents) <= tol ? 'IN TUNE' : cents > 0 ? 'SHARP' : 'FLAT';
      stateEl.className = `gauge-state ${Math.abs(cents) <= tol ? 'good' : 'off'}`;
      const deg = Math.max(-78, Math.min(78, (cents / 50) * 78));
      needle.style.transform = `translateX(-50%) rotate(${deg.toFixed(1)}deg)`;
    } else {
      centsEl.textContent = '—';
      centsEl.className = 'gauge-cents';
      stateEl.textContent = hzToNote(this.lastHz);
      stateEl.className = 'gauge-state';
      needle.style.transform = 'translateX(-50%) rotate(0deg)';
    }
    if (this.mode === 'lug') this.renderLugs();
    this.renderHeads();
  }

  renderHeads() {
    const el = this.root.querySelector('#tuner-heads');
    if (!el) return;
    const m = this.heads[this.drumId || 'free'] || {};
    if (!m.batter || !m.reso) {
      el.textContent = m.batter || m.reso
        ? (this.head === 'batter' ? 'now tap the reso (flip or reach under) to see the pair' : 'tap the batter too to see the pair')
        : '';
      return;
    }
    const st = 12 * Math.log2(m.reso / m.batter);
    const feelTxt = Math.abs(st) < 0.3
      ? 'matched — longest, purest sustain'
      : st > 0
        ? 'reso above — pitch bends down, tighter and more controlled'
        : 'reso below — fatter, shorter, deader';
    el.textContent = `batter ${m.batter.toFixed(1)} Hz · reso ${m.reso.toFixed(1)} Hz · ${st >= 0 ? '+' : ''}${st.toFixed(1)} st (${feelTxt})`;
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
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
