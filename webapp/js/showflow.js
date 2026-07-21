// The show flow: Pre-show readiness -> ARM -> live listening -> the verdict.
// Every readiness row is a real check; every number on the armed screen and
// the verdict comes from the mic and the grid. Nothing is decorative data.

import { store } from './store.js';
import { FEELS } from './feel.js';
import { ArmedSession } from './show.js';

const CHECK_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
const PENCIL_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f2ecdd" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`;

function escText(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function checkRow({ ok, label, sub, value, valueClass = '', action = '' }) {
  const icon = ok
    ? `<div class="check-ic ok">${CHECK_SVG}</div>`
    : `<div class="check-ic warn"><span>!</span></div>`;
  return `
    <button class="check-row ${ok ? '' : 'flagged'}" ${action ? `data-check="${action}"` : 'disabled'}>
      ${icon}
      <div class="check-label">${label}${sub ? ` <span>&middot; ${sub}</span>` : ''}</div>
      <div class="check-value ${valueClass}">${value}</div>
    </button>`;
}

// ---------------------------------------------------------------- Pre-show
export class PreshowMode {
  constructor(root, mic, nav, armed) {
    this.root = root;
    this.mic = mic;
    this.nav = nav;
    this.armed = armed;
    this.editing = false;
    this.storageGb = null;
    this.render();
  }

  activate() {
    this.render();
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((est) => {
        if (est && est.quota) {
          this.storageGb = (est.quota - (est.usage || 0)) / 1e9;
          const el = this.root.querySelector('[data-storage]');
          if (el) el.textContent = `${this.storageGb.toFixed(1)} GB`;
        }
      }).catch(() => {});
    }
  }

  tMinus() {
    const meta = store.get('showMeta');
    if (!meta.stage) return null;
    const [h, m] = meta.stage.split(':').map(Number);
    const now = new Date();
    let target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (target < now - 6 * 3600000) target = new Date(target.getTime() + 86400000);
    return Math.round((target - now) / 60000);
  }

  render() {
    const meta = store.get('showMeta');
    const feel = store.get('feel');
    const cal = store.get('calibrationMs');
    const kit = store.get('kit');
    const targets = kit.filter((d) => d.targetHz !== null).length;
    const base = store.get('baseline');
    const clickAck = store.get('clickAck');
    const t = this.tMinus();
    const bpm = store.get('preferredBpm');

    this.root.innerHTML = `
      <div class="status-row">
        <span class="chip-stamp big">&#9679; Before the set</span>
        <label class="tminus">${t !== null ? `T&#8722;${t} MIN` : 'SET STAGE TIME'}
          <input type="time" id="ps-stage" value="${meta.stage || ''}"></label>
      </div>
      <div class="title-stamp">PRE-SHOW</div>

      <div class="venue-card">
        <div class="venue-row">
          ${this.editing
    ? `<input id="ps-venue" class="venue-input" value="${escText(meta.venue).replaceAll('"', '&quot;')}" placeholder="VENUE NAME">`
    : `<div class="venue-name">${meta.venue ? escText(meta.venue) : 'ADD THE VENUE'}</div>`}
          <button id="ps-edit" aria-label="edit show details">${PENCIL_SVG}</button>
        </div>
        <div class="venue-chips">
          ${this.editing
    ? `<label class="venue-chip edit">SET MIN<input id="ps-setmin" type="number" min="10" max="240" value="${meta.setMin}"></label>
       <label class="venue-chip edit">SONGS<input id="ps-songs" type="number" min="1" max="60" value="${meta.songs}"></label>
       <label class="venue-chip edit">BPM<input id="ps-bpm" type="number" min="20" max="400" value="${bpm}"></label>`
    : `<div class="venue-chip"><div class="vc-num">${meta.setMin}<span> MIN</span></div><div class="vc-cap">SET</div></div>
       <div class="venue-chip"><div class="vc-num">${meta.songs}</div><div class="vc-cap">SONGS</div></div>
       <div class="venue-chip red"><div class="vc-num">${feel ? FEELS[feel].label : `${bpm}`}</div><div class="vc-cap">${feel ? 'FEEL' : 'TARGET BPM'}</div></div>`}
        </div>
      </div>

      <div class="readiness">
        <span class="chip-stamp">Readiness</span>
        ${checkRow({
    ok: cal !== null,
    label: 'MIC CALIBRATED',
    sub: cal === null ? 'run it' : '',
    value: cal === null ? 'NO' : `${cal >= 0 ? '&#8722;' : '+'}${Math.abs(cal).toFixed(0)} MS`,
    action: 'calibrate',
  })}
        ${checkRow({
    ok: targets === kit.length && kit.length > 0,
    label: 'TUNING TARGETS',
    sub: targets < kit.length ? 'tuner' : '',
    value: `${targets}/${kit.length}`,
    action: 'tuner',
  })}
        ${checkRow({
    ok: !!base,
    label: 'HANDS BASELINE',
    sub: base ? '' : 'run timing',
    value: base ? `${base.sd.toFixed(1)} MS` : 'NONE',
    action: 'timing',
  })}
        ${checkRow({
    ok: clickAck,
    label: 'CLICK &middot; IN-EAR ONLY',
    sub: clickAck ? '' : 'tap to confirm',
    value: clickAck ? 'ON' : '?',
    action: 'clickack',
  })}
        ${checkRow({
    ok: true,
    label: 'STORAGE',
    value: `<span data-storage>${this.storageGb ? `${this.storageGb.toFixed(1)} GB` : '&mdash;'}</span>`,
  })}
      </div>

      <div class="cta-wrap">
        <button id="ps-arm" class="cta glow"><span class="arm-dot"></span>ARM FOR SHOW</button>
        <p class="arm-note">The click plays at ${bpm} BPM in your in-ears. The mic judges every
        hit against it for the whole set. Long silences split songs.</p>
      </div>`;

    this.root.querySelector('#ps-stage').addEventListener('change', (e) => {
      store.set('showMeta', { ...store.get('showMeta'), stage: e.target.value });
      this.render();
    });
    this.root.querySelector('#ps-edit').addEventListener('click', () => {
      if (this.editing) {
        const meta2 = { ...store.get('showMeta') };
        meta2.venue = this.root.querySelector('#ps-venue').value.trim();
        meta2.setMin = +this.root.querySelector('#ps-setmin').value || 45;
        meta2.songs = +this.root.querySelector('#ps-songs').value || 12;
        store.set('showMeta', meta2);
        store.set('preferredBpm', Math.max(20, Math.min(400, +this.root.querySelector('#ps-bpm').value || 120)));
      }
      this.editing = !this.editing;
      this.render();
    });
    this.root.querySelectorAll('[data-check]').forEach((b) => {
      b.addEventListener('click', () => {
        const what = b.dataset.check;
        if (what === 'clickack') {
          store.set('clickAck', !store.get('clickAck'));
          this.render();
        } else this.nav(what);
      });
    });
    this.root.querySelector('#ps-arm').addEventListener('click', () => {
      this.armed.begin({ bpm: store.get('preferredBpm') });
      this.nav('armed');
    });
  }
}

// ------------------------------------------------------------------- Armed
export class ArmedMode {
  constructor(root, mic, nav, verdict) {
    this.root = root;
    this.mic = mic;
    this.nav = nav;
    this.verdict = verdict;
    this.session = null;
    this.levels = new Array(34).fill(0.06);
  }

  begin({ bpm }) {
    if (this.session) this.session.cancel();
    this.session = new ArmedSession(this.mic, { bpm });
    this.session.addEventListener('hit', () => this.updateLive());
    this.session.addEventListener('song', () => this.updateLive());
    this.session.addEventListener('miclost', () => { /* mic-lost overlay handles it */ });
    this.session.start();
    this.render();
    this._clock = setInterval(() => this.updateClock(), 1000);
    this._wavT = setInterval(() => {
      this.levels.push(Math.min(1, this.mic.level * 9));
      this.levels.shift();
    }, 120);
    this._raf = requestAnimationFrame(() => this.drawWave());
  }

  activate() {
    if (!this.session) this.render();
  }

  disarm() {
    clearInterval(this._clock);
    clearInterval(this._wavT);
    cancelAnimationFrame(this._raf);
    const result = this.session ? this.session.finish() : null;
    const meta = store.get('showMeta');
    this.session = null;
    this.verdict.show(result, meta);
    this.nav('verdict');
  }

  deactivate() {
    // navigating away mid-set (programmatically) is a disarm without a verdict
    if (this.session) {
      clearInterval(this._clock);
      clearInterval(this._wavT);
      cancelAnimationFrame(this._raf);
      this.session.cancel();
      this.session = null;
    }
  }

  updateClock() {
    const el = this.root.querySelector('#armed-clock');
    if (!el || !this.session) return;
    const s = Math.floor(this.session.elapsed());
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    const meta = store.get('showMeta');
    const pct = Math.min(100, (s / 60 / meta.setMin) * 100);
    const fill = this.root.querySelector('#set-fill');
    if (fill) fill.style.width = `${pct.toFixed(1)}%`;
    const pctEl = this.root.querySelector('#set-pct');
    if (pctEl) pctEl.textContent = `${pct.toFixed(0)}%`;
  }

  updateLive() {
    if (!this.session) return;
    const s = this.session.liveStats();
    const meta = store.get('showMeta');
    const set = (id, html) => {
      const el = this.root.querySelector(id);
      if (el) el.innerHTML = html;
    };
    set('#armed-song', `${s.song}<span>/${meta.songs}</span>`);
    set('#armed-held', s.heldPct === null ? '&mdash;' : `${s.heldPct.toFixed(0)}<span>%</span>`);
    set('#armed-peak', `${s.peakDriftMs >= 0 ? '+' : ''}${s.peakDriftMs.toFixed(0)}<span> MS</span>`);
    const roll = s.rollingMs;
    const needle = this.root.querySelector('#drift-needle');
    const read = this.root.querySelector('#drift-read');
    if (roll !== null && needle) {
      const x = Math.max(-42, Math.min(42, (roll / 60) * 42));
      needle.style.left = `${50 + x}%`;
      const pocket = Math.abs(roll) <= store.get('pocketMs');
      read.textContent = `${roll >= 0 ? '+' : ''}${roll.toFixed(0)} MS · ${pocket ? 'IN THE POCKET' : roll > 0 ? 'DRIFTING LATE' : 'DRIFTING EARLY'}`;
      read.className = `drift-read ${pocket ? 'good' : 'off'}`;
    }
  }

  drawWave() {
    const bars = this.root.querySelectorAll('.wave i');
    bars.forEach((b, i) => {
      const lvl = this.levels[i] || 0.04;
      b.style.height = `${Math.max(4, Math.min(96, lvl * 100)).toFixed(0)}%`;
    });
    this._raf = requestAnimationFrame(() => this.drawWave());
  }

  render() {
    const bpm = this.session ? this.session.metro.bpm : store.get('preferredBpm');
    this.root.innerHTML = `
      <div class="status-row live-row">
        <span class="live-title"><span class="live-dot"></span>LIVE &middot; LISTENING</span>
        <span id="armed-clock" class="armed-clock">0:00</span>
      </div>

      <div class="bpm-card">
        <div class="bpm-big">
          <div class="bpm-num">${bpm}</div>
          <div class="bpm-cap">BPM &middot; TARGET ${bpm}</div>
        </div>
        <div class="drift-meter">
          <div class="drift-labels"><span>&#9668; EARLY</span><span class="mid">DRIFT</span><span>LATE &#9658;</span></div>
          <div class="drift-track">
            <div class="drift-center"></div>
            <div id="drift-needle" class="drift-needle"><div class="tri-up"></div></div>
          </div>
          <div id="drift-read" class="drift-read">listening&hellip;</div>
        </div>
      </div>

      <div class="wave-card">
        <div class="wave-head"><span class="chip-stamp">Live input</span><span class="wave-src">REAL MIC LEVEL</span></div>
        <div class="wave-area">
          <div class="wave-hair"></div>
          <div class="wave">${Array.from({ length: 34 }, (_, i) => `<i class="${(i + 3) % 7 === 0 ? 'red' : ''}"></i>`).join('')}</div>
          <div class="scan" style="animation-duration:2.6s"></div>
        </div>
      </div>

      <div class="armed-stats">
        <div class="statbox"><b id="armed-song">1<span>/${store.get('showMeta').songs}</span></b><span>Song</span></div>
        <div class="statbox green"><b id="armed-held">&mdash;</b><span>Held so far</span></div>
        <div class="statbox"><b id="armed-peak">+0<span> MS</span></b><span>Peak drift</span></div>
      </div>

      <div class="set-progress">
        <div class="sp-labels"><span>SET PROGRESS</span><span id="set-pct">0%</span></div>
        <div class="sp-track"><div id="set-fill" class="sp-fill"></div></div>
      </div>

      <div class="cta-wrap">
        <button id="armed-disarm" class="cta">&#9632; DISARM &middot; STAMP THE VERDICT</button>
      </div>`;
    this.root.querySelector('#armed-disarm').addEventListener('click', () => this.disarm());
  }
}

// ----------------------------------------------------------------- Verdict
export class VerdictMode {
  constructor(root, nav) {
    this.root = root;
    this.nav = nav;
    this.result = null;
    this.meta = null;
    this.saved = false;
    this.breakdown = false;
  }

  show(result, meta) {
    this.result = result;
    this.meta = meta;
    this.saved = false;
    this.breakdown = false;
    this.render();
  }

  activate() { if (!this.result) this.render(); }

  render() {
    const r = this.result;
    const meta = this.meta || store.get('showMeta');
    const date = new Date();
    const dateStr = date.toDateString().toUpperCase().slice(0, 10).replace(/^(\w+) (\w+) (\d+)$/, '$1 $2 $3');
    if (!r || r.empty) {
      this.root.innerHTML = `
        <div class="status-row"><span class="live-badge"><span class="dot"></span>SHOW &middot; THE VERDICT</span></div>
        <div class="verdict-card">
          <div class="stamp-box notyet"><div class="stamp-word" style="font-size:52px">NOTHING<br>HEARD</div></div>
          <div class="verdict-sub">THE MIC CAUGHT NO ATTRIBUTABLE HITS &middot; CHECK LEVEL AND TRIGGER, THEN ARM AGAIN</div>
        </div>
        <div class="cta-wrap"><button class="cta" id="verdict-home">BACK TO PRE-SHOW</button></div>`;
      this.root.querySelector('#verdict-home').addEventListener('click', () => this.nav('preshow'));
      return;
    }
    const dialed = r.result === 'DIALED';
    const mins = Math.round(r.elapsedS / 60);
    const worst = r.perSong.reduce((a, b) => (Math.abs(b.meanMs) > Math.abs(a?.meanMs ?? 0) ? b : a), null);
    const sub = dialed
      ? `HELD ${r.bpm} BPM &middot; &plusmn;${r.sdMs.toFixed(0)} MS &middot; ${r.heldPct}% OF THE SET`
      : `DRIFTED ${r.peakDriftMs >= 0 ? '+' : ''}${r.peakDriftMs.toFixed(0)} MS${worst ? ` BY SONG ${worst.song}` : ''} &middot; HELD ${r.heldPct}% OF THE SET`;
    const barFor = (s) => {
      const h = Math.min(48, (Math.abs(s.meanMs) / 60) * 50);
      const anchor = s.meanMs >= 0 ? 'bottom:50%' : 'top:50%';
      const color = Math.abs(s.meanMs) <= 15 ? 'var(--green)' : Math.abs(s.meanMs) <= 30 ? 'var(--amber)' : 'var(--red)';
      return `<div class="song-col"><div class="song-bar" style="${anchor};height:${Math.max(3, h).toFixed(1)}%;background:${color}" title="song ${s.song}: ${s.meanMs >= 0 ? '+' : ''}${s.meanMs} ms"></div></div>`;
    };
    this.root.innerHTML = `
      <div class="status-row">
        <span class="live-badge"><span class="dot"></span>SHOW &middot; THE VERDICT</span>
        <span class="verdict-meta">${dateStr} &middot; ${mins} MIN &middot; ${r.perSong.length} SONGS</span>
      </div>

      <div class="verdict-card ${dialed ? 'dialed' : 'notyet'}">
        <div class="pinstripe"></div>
        <div class="verdict-inner">
          <div class="stamp-box ${dialed ? 'dialed' : 'notyet'}">
            <div class="stamp-word" style="font-size:${dialed ? 74 : 70}px">${r.result}</div>
          </div>
          <div class="verdict-sub">${sub}</div>
        </div>
      </div>

      <div class="verdict-grid">
        <div class="statbox big ${dialed ? 'green' : 'red'}"><b>${r.heldPct}<span>%</span></b><span>Tempo held</span></div>
        <div class="statbox big"><b>${r.meanMs >= 0 ? '+' : ''}${r.meanMs.toFixed(0)}<span> MS</span></b><span>Avg drift</span></div>
        <div class="statbox big"><b>${r.tightest ? `${r.tightest.meanMs >= 0 ? '+' : ''}${r.tightest.meanMs.toFixed(0)}` : '&mdash;'}<span> MS</span></b><span>Tightest &middot; #${r.tightest ? r.tightest.song : '&mdash;'}</span></div>
        <div class="statbox big"><b>${r.loosest ? `${r.loosest.meanMs >= 0 ? '+' : ''}${r.loosest.meanMs.toFixed(0)}` : '&mdash;'}<span> MS</span></b><span>Loosest &middot; #${r.loosest ? r.loosest.song : '&mdash;'}</span></div>
      </div>

      <div class="drift-chart">
        <div class="dc-head"><span class="chip-stamp">Drift / song</span><span class="dc-axis">&#9650; LATE &middot; EARLY &#9660;</span></div>
        <div class="dc-plot">
          <div class="dc-zero"></div>
          <div class="dc-guide" style="top:24%"></div>
          <div class="dc-guide" style="bottom:24%"></div>
          <div class="dc-bars">${r.perSong.map(barFor).join('')}</div>
          <div class="scan" style="animation-duration:3.2s"></div>
        </div>
        ${this.breakdown ? `
          <div class="dc-breakdown">
            ${r.perSong.map((s) => `<div class="dc-row"><span>SONG ${s.song}</span><span>${s.n} HITS</span><span>${s.meanMs >= 0 ? '+' : ''}${s.meanMs} MS</span><span>${s.heldPct}% HELD</span></div>`).join('')}
            ${r.warning ? `<div class="dc-row warn"><span>NOTE</span><span colspan="3">${escText(r.warning)}</span></div>` : ''}
          </div>` : ''}
      </div>

      <div class="verdict-actions">
        <button id="verdict-save" class="btn" ${this.saved ? 'disabled' : ''}>${this.saved ? 'SAVED &#10003;' : 'SAVE TO HISTORY'}</button>
        <button id="verdict-breakdown" class="btn red">BREAKDOWN &#9656;</button>
      </div>`;

    this.root.querySelector('#verdict-save').addEventListener('click', () => {
      if (this.saved) return;
      store.addRun({
        kind: 'show',
        label: meta.venue || 'Show',
        meter: '4/4',
        bpmStart: r.bpm,
        bpmEnd: r.bpm,
        n: r.n,
        mean: r.meanMs,
        sd: r.sdMs,
        result: r.result,
        heldPct: r.heldPct,
        songs: r.perSong.length,
        minutes: mins,
      });
      this.saved = true;
      this.render();
    });
    this.root.querySelector('#verdict-breakdown').addEventListener('click', () => {
      this.breakdown = !this.breakdown;
      this.render();
    });
  }
}
