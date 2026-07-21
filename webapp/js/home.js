// HOME — two mutually exclusive states, switched by hand, never guessed:
//
//   PRACTICE: arm strip on top, what-the-data-says card, module grid.
//   ARMED:    the whole screen becomes the show ritual — one Big Button whose
//             label is always the next undone action, a persistent two-leg
//             ledger, and a held DISARM. Survives relaunch; auto-disarms
//             2 h after stage time and files the result into history.

import { store } from './store.js';
import { holdToConfirm } from './theme.js';

const STAGE_CHIPS = [20, 21, 22, 23]; // o'clock

function hhmm(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

export class HomeMode {
  constructor(root, nav, deps) {
    this.root = root;
    this.nav = nav;
    this.deps = deps; // {preshow, rudiments}
    this._pendingStage = null;
    this.render();
  }

  activate() {
    this._autoDisarm();
    this.render();
  }

  show() {
    return store.get('show');
  }

  _autoDisarm() {
    const show = this.show();
    if (show && Date.now() > show.stageTime + 2 * 3600 * 1000) {
      const verdict = this._verdict(show);
      store.addRun({
        kind: 'show',
        label: `show check — ${verdict === 'dialed' ? 'DIALED' : verdict === 'notyet' ? 'NOT YET' : 'incomplete'}`,
        meter: '—',
        bpmStart: 0, bpmEnd: 0,
        n: 0, mean: 0, sd: 0,
      });
      store.set('show', null);
    }
  }

  _verdict(show) {
    if (!show.drums || !show.hands) return null;
    return show.drums.pass && show.hands.pass ? 'dialed' : 'notyet';
  }

  render() {
    const show = this.show();
    if (show) this.renderArmed(show);
    else this.renderPractice();
  }

  // ------------------------------------------------------------- practice
  renderPractice() {
    const kit = store.get('kit');
    const targets = kit.filter((d) => d.targetHz !== null).length;
    const base = store.get('baseline');
    const cal = store.get('calibrationMs');
    const runs = store.get('runs') || [];
    const last = runs[runs.length - 1];

    const facts = [];
    if (last) {
      facts.push(`last session: ${esc(last.label)} — spread ${last.sd.toFixed(1)} ms`);
    }
    if (runs.length >= 6) {
      const half = Math.floor(runs.length / 2);
      const avg = (rs) => rs.reduce((a, r) => a + r.sd, 0) / rs.length;
      const before = avg(runs.slice(0, half));
      const after = avg(runs.slice(half));
      facts.push(`spread trend: ${before.toFixed(1)} → ${after.toFixed(1)} ms across ${runs.length} sessions`);
    }
    if (base) {
      const days = Math.floor((Date.now() - new Date(base.date).getTime()) / 86400000);
      if (days > 21) facts.push(`baseline is ${days} days old — re-run one on a good day`);
    }
    if (!facts.length) facts.push('no sessions yet — run anything and the facts land here');

    const gaps = [];
    if (cal === null) gaps.push({ label: 'UNCALIBRATED', nav: 'calibrate' });
    if (!targets) gaps.push({ label: 'NO TUNING TARGETS', nav: 'tuner' });
    if (!base) gaps.push({ label: 'NO BASELINE', nav: 'timing' });

    this.root.innerHTML = `
      <button id="arm-strip">
        <span class="arm-label">Tonight's a show</span>
        <span class="arm-sub">arm the pre-show ritual →</span>
      </button>

      <section class="data-card">
        <h2 class="stamp">What the data says</h2>
        ${facts.map((f) => `<p class="fact">${f}</p>`).join('')}
      </section>

      <nav class="tile-grid">
        <button class="tile" data-i="01" data-nav="tuner"><b>Tuner</b><span>${targets}/${kit.length} targets saved</span></button>
        <button class="tile" data-i="02" data-nav="rudiments"><b>Rudiments</b><span>highway trainer</span></button>
        <button class="tile" data-i="03" data-nav="timing"><b>Timing</b><span>${base ? `baseline ${base.sd.toFixed(1)} ms` : 'no baseline yet'}</span></button>
        <button class="tile" data-i="04" data-nav="history"><b>History</b><span>${runs.length} sessions</span></button>
        <button class="tile" data-i="05" data-nav="preshow"><b>Dry run</b><span>full pre-show check</span></button>
        <button class="tile" data-i="06" data-nav="calibrate"><b>Calibrate</b><span>${cal === null ? 'not yet — run me' : `${cal.toFixed(0)} ms locked in`}</span></button>
      </nav>

      <footer class="status-bar">
        ${gaps.length
          ? gaps.map((g) => `<button class="gap" data-nav="${g.nav}">▲ ${g.label}</button>`).join('')
          : '<span class="ok">● calibrated · targets saved · baseline set</span>'}
      </footer>
      <p class="bill-row credo">Honest data · Human calls · No flattery</p>

      <div id="arm-sheet" class="sheet hidden">
        <h2 class="stamp">Arm show mode</h2>
        <div class="chip-row" id="stage-chips">
          ${STAGE_CHIPS.map((h) => `<button class="chip" data-hour="${h}">${h}:00</button>`).join('')}
          <button class="chip" data-rel="2">now +2h</button>
        </div>
        <div class="stepper-row">
          <button id="stage-minus">−15m</button>
          <span id="stage-read">—</span>
          <button id="stage-plus">+15m</button>
        </div>
        <button id="arm-go" class="primary" disabled>Arm</button>
        <button id="arm-cancel">cancel</button>
      </div>`;

    this.root.querySelector('#arm-strip').addEventListener('click', () => {
      this.root.querySelector('#arm-sheet').classList.remove('hidden');
    });
    this.root.querySelectorAll('[data-nav]').forEach((b) => {
      b.addEventListener('click', () => this.nav(b.dataset.nav));
    });
    this._wireArmSheet();
  }

  _wireArmSheet() {
    const sheet = this.root.querySelector('#arm-sheet');
    const read = sheet.querySelector('#stage-read');
    const go = sheet.querySelector('#arm-go');
    const setStage = (ts) => {
      this._pendingStage = ts;
      read.textContent = hhmm(ts);
      go.disabled = false;
    };
    sheet.querySelectorAll('#stage-chips .chip').forEach((c) => {
      c.addEventListener('click', () => {
        sheet.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
        if (c.dataset.rel) setStage(Date.now() + (+c.dataset.rel) * 3600 * 1000);
        else {
          const d = new Date();
          d.setHours(+c.dataset.hour, 0, 0, 0);
          if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
          setStage(d.getTime());
        }
      });
    });
    sheet.querySelector('#stage-minus').addEventListener('click', () => {
      if (this._pendingStage) setStage(this._pendingStage - 15 * 60000);
    });
    sheet.querySelector('#stage-plus').addEventListener('click', () => {
      if (this._pendingStage) setStage(this._pendingStage + 15 * 60000);
    });
    go.addEventListener('click', () => {
      store.set('show', {
        armedAt: Date.now(),
        stageTime: this._pendingStage,
        drums: null,
        hands: null,
      });
      this.render();
    });
    sheet.querySelector('#arm-cancel').addEventListener('click', () => sheet.classList.add('hidden'));
  }

  // ---------------------------------------------------------------- armed
  renderArmed(show) {
    const verdict = this._verdict(show);
    const next = !show.drums ? 'drums' : !show.hands ? 'hands' : null;

    let bigClass = 'next';
    let bigLabel = next === 'drums' ? 'Check<br>drums' : 'Check<br>hands';
    let bigSub = next === 'drums' ? 'phone on the snare stand, one tap' : `${'30'} seconds vs your baseline`;
    if (verdict === 'dialed') { bigClass = 'dialed'; bigLabel = 'Dialed'; bigSub = 'everything matches rehearsal. Go play.'; }
    if (verdict === 'notyet') { bigClass = 'notyet'; bigLabel = 'Not yet'; bigSub = 'the ledger says exactly what is off'; }

    const row = (name, leg) => {
      if (!leg) return `<button class="ledger-row todo" data-leg="${name.toLowerCase()}"><i>—</i><b>${name}</b><span>not checked</span></button>`;
      return `<button class="ledger-row ${leg.pass ? 'pass' : 'fail'}" data-leg="${name.toLowerCase()}">
        <i>${leg.pass ? '●' : '▲'}</i><b>${name}</b><span>${hhmm(leg.time)} — ${esc(leg.detail)}</span></button>`;
    };

    this.root.innerHTML = `
      <div class="armed-context stamp">Show day — armed ${hhmm(show.armedAt)} · stage ${hhmm(show.stageTime)}</div>
      <button id="big-btn" class="big-btn ${bigClass}">
        <span class="big-word">${bigLabel}</span>
        <span class="big-sub">${bigSub}</span>
      </button>
      <div class="ledger">
        ${row('Drums', show.drums)}
        ${row('Hands', show.hands)}
      </div>
      <div class="armed-bar">
        <button data-nav="rudiments">Warmup</button>
        <button data-nav="tuner">Tuner</button>
        <button id="disarm" class="hold-btn">Hold to disarm</button>
      </div>`;

    this.root.querySelector('#big-btn').addEventListener('click', () => {
      if (next) this.deps.preshow.beginLeg(next);
      else if (verdict === 'notyet') {
        // re-run the failed leg(s)
        this.deps.preshow.beginLeg(show.drums.pass ? 'hands' : 'drums');
      }
    });
    this.root.querySelectorAll('.ledger-row').forEach((b) => {
      b.addEventListener('click', () => this.deps.preshow.beginLeg(b.dataset.leg));
    });
    this.root.querySelectorAll('[data-nav]').forEach((b) => {
      b.addEventListener('click', () => this.nav(b.dataset.nav));
    });
    holdToConfirm(this.root.querySelector('#disarm'), () => {
      store.set('show', null);
      this.render();
    });
  }
}
