// App shell: hub-and-spoke navigation (HOME owns the screen; every tool is
// one level deep with a hard BACK), mic bootstrap, settings drawer, offline SW.

import { MicEngine } from './audio.js';
import { selftest } from './dsp.js';
import { store } from './store.js';
import { holdToConfirm } from './theme.js';
import { FEELS } from './feel.js';
import { HomeMode } from './home.js';
import { TunerMode } from './tuner.js';
import { TimingMode } from './timing.js';
import { RudimentsMode, matchWindowMs, highwayPxPerSec, puckRadius, buildChart, clusterPrimaryDev } from './rudiments.js';
import { meterById, accentsFor, defaultGrouping } from './meter.js';
import { validateRudiments, rudimentById } from './rudiment-data.js';
import { notationModel } from './notation.js';
import { PreshowMode, ArmedMode, VerdictMode } from './showflow.js';
import { CalibrateMode } from './calibrate.js';
import { HistoryMode } from './history.js';

const mic = new MicEngine();
const modes = {};
let currentScreen = 'home';
let pendingNav = null; // set by poster lineup deep-links before mic boot

function $(sel) { return document.querySelector(sel); }

function chromeFor(name) {
  const back = $('#nav-back');
  const gearLeft = $('#chrome-gear-left');
  back.classList.toggle('hidden', name === 'home');
  gearLeft.classList.toggle('hidden', name !== 'home');
  // armed screen swaps BACK for a red DISARM — leaving mid-set IS disarming
  if (name === 'armed') {
    back.innerHTML = '&#9632; DISARM';
    back.classList.add('disarm');
  } else {
    back.innerHTML = '&#8592; HOME';
    back.classList.remove('disarm');
  }
}

function nav(name) {
  if (name === 'settings') {
    // a poster deep-link can land here before any screen is active — the
    // drawer needs a real screen behind it, not a blank <main>
    if (!document.querySelector('.mode.active')) nav('home');
    openSettings();
    return;
  }
  const leaving = modes[currentScreen];
  if (leaving && leaving !== modes[name] && leaving.deactivate) leaving.deactivate();
  currentScreen = name;
  document.querySelectorAll('.mode').forEach((m) => m.classList.toggle('active', m.id === `mode-${name}`));
  chromeFor(name);
  const mode = modes[name];
  if (mode && mode.activate) mode.activate();
  $('main').scrollTop = 0;
}

function escText(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function initModes() {
  modes.tuner = new TunerMode($('#mode-tuner'), mic);
  modes.timing = new TimingMode($('#mode-timing'), mic);
  modes.rudiments = new RudimentsMode($('#mode-rudiments'), mic);
  modes.calibrate = new CalibrateMode($('#mode-calibrate'), mic);
  modes.history = new HistoryMode($('#mode-history'));
  modes.verdict = new VerdictMode($('#mode-verdict'), nav);
  modes.armed = new ArmedMode($('#mode-armed'), mic, nav, modes.verdict);
  modes.preshow = new PreshowMode($('#mode-preshow'), mic, nav, modes.armed);
  modes.home = new HomeMode($('#mode-home'), nav);
}

function levelMeterLoop() {
  const el = $('#mic-level');
  const tick = () => {
    const db = mic.level > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(mic.level) + 60) / 60)) : 0;
    el.style.width = `${(db * 100).toFixed(0)}%`;
    requestAnimationFrame(tick);
  };
  tick();
}

// ------------------------------------------------------------ settings drawer
function openSettings() {
  renderSettings();
  $('#drawer-scrim').classList.remove('hidden');
  $('#settings').classList.remove('hidden');
}

function closeSettings() {
  $('#drawer-scrim').classList.add('hidden');
  $('#settings').classList.add('hidden');
  if (modes.home && currentScreen === 'home') modes.home.render();
  if (modes.tuner) modes.tuner.render();
}

function renderSettings() {
  const kit = store.get('kit');
  const feel = store.get('feel');
  const cal = store.get('calibrationMs');
  const runs = store.get('runs') || [];
  $('#settings-body').innerHTML = `
    <div class="set-group"><span class="chip-stamp">Audio</span>
      <div class="set-row"><label>Latency offset</label>
        <button id="set-cal" class="drop amber">${cal === null ? 'NOT SET · CALIBRATE' : `${cal >= 0 ? '−' : '+'}${Math.abs(cal).toFixed(0)} MS · CALIBRATE`} &#9656;</button></div>
      <div class="set-row"><label>Metronome sound</label>
        <select id="set-click" class="drop">
          ${['woodblock', 'beep', 'rim'].map((s) => `<option value="${s}" ${store.get('metronomeSound') === s ? 'selected' : ''}>${s.toUpperCase()}</option>`).join('')}
        </select></div>
    </div>
    <div class="set-group"><span class="chip-stamp">Judging</span>
      <div class="set-row"><label>Tolerance</label>
        <select id="set-judge" class="drop">
          <option value="standard" ${store.get('judgeMode') === 'standard' ? 'selected' : ''}>NORMAL · ±20/40/60 MS</option>
          <option value="pro" ${store.get('judgeMode') === 'pro' ? 'selected' : ''}>PRO · ±12/25/40 MS</option>
        </select></div>
      <div class="set-row"><label>Pocket window ±</label>
        <input id="set-pocket" type="number" min="3" max="40" value="${store.get('pocketMs')}" style="width:64px"></div>
      <div class="set-row"><label>Tuning tolerance ±&cent;</label>
        <input id="set-cents" type="number" min="3" max="50" value="${store.get('tuneToleranceCents')}" style="width:64px"></div>
      <div class="set-row"><label>Show grades <span class="hint">&middot; not just numbers</span></label>
        <button id="set-grades" class="switch ${store.get('showGrades') ? 'on' : ''}" role="switch" aria-checked="${store.get('showGrades')}"><i></i></button></div>
    </div>
    <div class="set-group"><span class="chip-stamp">Feel</span>
      <div class="set-row"><label>Default feel</label>
        <select id="set-feel" class="drop ${feel ? 'red' : ''}">
          <option value="">NONE</option>
          ${Object.entries(FEELS).map(([id, f]) => `<option value="${id}" ${feel === id ? 'selected' : ''}>${f.label}</option>`).join('')}
        </select></div>
    </div>
    <div class="set-group"><span class="chip-stamp">Kit</span>
      <div id="kit-list">
        ${kit.map((d) => `
          <div class="kit-row" data-id="${escText(d.id)}">
            <input class="kit-name" value="${escText(d.name).replaceAll('"', '&quot;')}">
            <span>B ${d.targetHz ?? '—'} / R ${d.resoHz ?? '—'} Hz</span>
            <button class="kit-del" title="remove">✕</button>
          </div>`).join('')}
      </div>
      <button id="kit-add" class="pill">+ add drum</button>
    </div>
    <div class="set-group"><span class="chip-stamp">Data</span>
      <div class="set-row"><label>Backup <span class="hint">&middot; never includes calibration</span></label>
        <span style="display:flex;gap:6px">
          <button id="set-export" class="pill">Export</button>
          <button id="set-import" class="pill">Import</button>
        </span>
        <input id="set-import-file" type="file" accept="application/json" class="hidden"></div>
      <div class="set-row"><label>Kit targets <span class="hint">&middot; share with the band</span></label>
        <span style="display:flex;gap:6px">
          <button id="set-share-kit" class="pill">Share</button>
          <button id="set-import-kit" class="pill">Import</button>
        </span>
        <input id="set-import-kit-file" type="file" accept="application/json" class="hidden"></div>
      <p class="hint" style="padding:8px 0 0">Everything lives on this device. Nothing is uploaded, ever.
      Calibration is per-device and never travels with a backup.</p>
    </div>
    <div class="drawer-foot">
      <span>v2.1.0 &middot; ${runs.length} sessions</span>
      <button id="set-reset">RESET ALL</button>
    </div>`;

  $('#set-cal').addEventListener('click', () => { closeSettings(); nav('calibrate'); });
  $('#set-click').addEventListener('change', (e) => store.set('metronomeSound', e.target.value));
  $('#set-judge').addEventListener('change', (e) => store.set('judgeMode', e.target.value));
  $('#set-pocket').addEventListener('change', (e) => store.set('pocketMs', +e.target.value || 10));
  $('#set-cents').addEventListener('change', (e) => store.set('tuneToleranceCents', +e.target.value || 10));
  $('#set-grades').addEventListener('click', (e) => {
    store.set('showGrades', !store.get('showGrades'));
    e.currentTarget.classList.toggle('on', store.get('showGrades'));
    e.currentTarget.setAttribute('aria-checked', String(store.get('showGrades')));
  });
  $('#set-feel').addEventListener('change', (e) => store.set('feel', e.target.value || null));
  $('#kit-add').addEventListener('click', () => {
    store.addDrum(`Drum ${kit.length + 1}`);
    renderSettings();
  });
  document.querySelectorAll('.kit-row').forEach((row) => {
    row.querySelector('.kit-name').addEventListener('change', (e) => {
      store.updateDrum(row.dataset.id, { name: e.target.value });
    });
    row.querySelector('.kit-del').addEventListener('click', () => {
      store.removeDrum(row.dataset.id);
      renderSettings();
    });
  });
  $('#set-export').addEventListener('click', () => {
    const blob = new Blob([store.exportJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rhythm-checker-backup.json';
    a.click();
  });
  $('#set-share-kit').addEventListener('click', () => {
    const blob = new Blob([store.exportKitJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'kit-targets.json';
    a.click();
  });
  $('#set-import-kit').addEventListener('click', () => $('#set-import-kit-file').click());
  $('#set-import-kit-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      store.importKitJson(await file.text());
      renderSettings();
    } catch (err) { alert(`Import failed: ${err.message}`); }
  });
  $('#set-import').addEventListener('click', () => $('#set-import-file').click());
  $('#set-import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      store.importJson(await file.text());
      renderSettings();
    } catch (err) { alert(`Import failed: ${err.message}`); }
  });
  holdToConfirm($('#set-reset'), () => {
    store.reset();
    renderSettings();
  });
}

async function boot() {
  $('#start-overlay').classList.add('hidden');
  try {
    await mic.start();
  } catch (err) {
    $('#start-overlay').classList.remove('hidden');
    $('#start-error').textContent = err.message;
    pendingNav = null;
    return;
  }
  $('#app').classList.remove('hidden');
  mic.setTriggerFloor(store.get('trigger') || 0);
  if (!Object.keys(modes).length) {
    initModes();
    levelMeterLoop();
    mic.addEventListener('lost', (e) => {
      const overlay = $('#mic-lost');
      overlay.classList.remove('hidden');
      overlay.querySelector('#mic-lost-reason').textContent = e.detail.reason;
    });
    $('#mic-lost-btn').addEventListener('click', async () => {
      try {
        await mic.reconnect();
        $('#mic-lost').classList.add('hidden');
      } catch (err) {
        $('#mic-lost-reason').textContent = err.message;
      }
    });
  }
  nav(pendingNav || 'home');
  pendingNav = null;
}

document.addEventListener('DOMContentLoaded', () => {
  // machine-checkable health: Playwright and the diagnostics footer read this
  const st = selftest();
  window.__rhythmChecker = {
    selftest: st, version: '2.2.0', nav: (n) => nav(n), matchWindowMs,
    highwayPxPerSec, puckRadius, clusterPrimaryDev,
    notation: (id) => notationModel(rudimentById(id)),
    rudGaps: (id) => {
      const meter = meterById('4/4');
      const grouping = defaultGrouping(meter);
      const groove = { bpm: 120, meter: { ...meter, accents: accentsFor(meter, grouping) }, grouping };
      return buildChart(rudimentById(id), groove, 16, null, 'R', { mode: 'pattern', custom: [] })
        .notes.map((n) => ({ gapPrev: n.gapPrev, gapNext: n.gapNext, phrasePos: n.phrasePos }));
    },
    rudimentErrors: validateRudiments(),
  };
  if (st.passed) {
    document.querySelector('footer').classList.add('hidden');
  } else {
    $('#diag').textContent = `ENGINE SELF-TEST FAILING: ${st.failures.join(', ')}`;
  }

  $('#start-btn').addEventListener('click', boot);
  document.querySelectorAll('#start-overlay [data-goto]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      pendingNav = el.dataset.goto;
      boot();
    });
  });
  $('#nav-back').addEventListener('click', () => {
    if (currentScreen === 'armed' && modes.armed && modes.armed.session) modes.armed.disarm();
    else nav('home');
  });
  $('#settings-btn').addEventListener('click', openSettings);
  $('#chrome-gear-left').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  $('#drawer-scrim').addEventListener('click', closeSettings);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline still works after first visit */ });
  }
});
