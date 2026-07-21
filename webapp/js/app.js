// App shell: hub-and-spoke navigation (HOME owns the screen; every tool is
// one level deep with a hard BACK), mic bootstrap, settings, offline SW.

import { MicEngine } from './audio.js';
import { selftest } from './dsp.js';
import { store } from './store.js';
import { HomeMode } from './home.js';
import { TunerMode } from './tuner.js';
import { TimingMode } from './timing.js';
import { RudimentsMode } from './rudiments.js';
import { PreshowMode } from './preshow.js';
import { CalibrateMode } from './calibrate.js';
import { HistoryMode } from './history.js';

const mic = new MicEngine();
const modes = {};
let currentScreen = 'home';

const TITLES = {
  home: null,
  preshow: ['Pre-show', 'the walk-on double check'],
  tuner: ['Tuner', 'tap the head · read the truth'],
  rudiments: ['Rudiments', 'the highway · judged honest'],
  timing: ['Timing', 'you vs the click'],
  calibrate: ['Calibrate', "measure this phone's lag once"],
  history: ['History', "weeks don't lie"],
};

function $(sel) { return document.querySelector(sel); }

function nav(name) {
  const leaving = modes[currentScreen];
  if (leaving && leaving !== modes[name] && leaving.deactivate) leaving.deactivate();
  currentScreen = name;
  document.querySelectorAll('.mode').forEach((m) => m.classList.toggle('active', m.id === `mode-${name}`));
  $('#nav-back').classList.toggle('hidden', name === 'home');
  const mh = $('#masthead');
  if (TITLES[name]) {
    mh.classList.remove('hidden');
    mh.querySelector('h1').textContent = TITLES[name][0];
    mh.querySelector('span').textContent = TITLES[name][1];
  } else mh.classList.add('hidden');
  const mode = modes[name];
  if (mode && mode.activate) mode.activate();
}

function escText(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function initModes() {
  modes.preshow = new PreshowMode($('#mode-preshow'), mic);
  modes.preshow.navTo = nav;
  modes.tuner = new TunerMode($('#mode-tuner'), mic);
  modes.timing = new TimingMode($('#mode-timing'), mic);
  modes.rudiments = new RudimentsMode($('#mode-rudiments'), mic);
  modes.calibrate = new CalibrateMode($('#mode-calibrate'), mic);
  modes.history = new HistoryMode($('#mode-history'));
  modes.home = new HomeMode($('#mode-home'), nav, { preshow: modes.preshow, rudiments: modes.rudiments });
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

function renderSettings() {
  const kit = store.get('kit');
  $('#settings-body').innerHTML = `
    <h3>Kit</h3>
    <div id="kit-list">
      ${kit.map((d) => `
        <div class="kit-row" data-id="${escText(d.id)}">
          <input class="kit-name" value="${escText(d.name).replaceAll('"', '&quot;')}">
          <span>B ${d.targetHz ?? '—'} / R ${d.resoHz ?? '—'} Hz</span>
          <button class="kit-del" title="remove">✕</button>
        </div>`).join('')}
    </div>
    <button id="kit-add">+ add drum</button>
    <h3>Scoring</h3>
    <label>Pocket window ±<input id="set-pocket" type="number" min="3" max="40" value="${store.get('pocketMs')}"> ms</label>
    <label>Tuning tolerance ±<input id="set-cents" type="number" min="3" max="50" value="${store.get('tuneToleranceCents')}"> cents</label>
    <label>Judgement <select id="set-judge">
      <option value="standard" ${store.get('judgeMode') === 'standard' ? 'selected' : ''}>standard (±20/40/60 ms)</option>
      <option value="pro" ${store.get('judgeMode') === 'pro' ? 'selected' : ''}>pro (±12/25/40 ms)</option>
    </select></label>
    <h3>Data</h3>
    <div class="row">
      <button id="set-export">Export backup</button>
      <button id="set-import">Import backup</button>
      <input id="set-import-file" type="file" accept="application/json" class="hidden">
    </div>
    <div class="row">
      <button id="set-share-kit">Share kit targets</button>
      <button id="set-import-kit">Import kit targets</button>
      <input id="set-import-kit-file" type="file" accept="application/json" class="hidden">
    </div>
    <p class="dim">Everything lives on this device. Nothing is uploaded, ever.
    Calibration is per-device and never travels with a backup.</p>`;

  $('#kit-add').addEventListener('click', () => {
    store.addDrum(`Drum ${kit.length + 1}`);
    renderSettings();
    modes.tuner.render();
  });
  document.querySelectorAll('.kit-row').forEach((row) => {
    row.querySelector('.kit-name').addEventListener('change', (e) => {
      store.updateDrum(row.dataset.id, { name: e.target.value });
      modes.tuner.render();
    });
    row.querySelector('.kit-del').addEventListener('click', () => {
      store.removeDrum(row.dataset.id);
      renderSettings();
      modes.tuner.render();
    });
  });
  $('#set-pocket').addEventListener('change', (e) => store.set('pocketMs', +e.target.value || 10));
  $('#set-cents').addEventListener('change', (e) => store.set('tuneToleranceCents', +e.target.value || 10));
  $('#set-judge').addEventListener('change', (e) => store.set('judgeMode', e.target.value));
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
      modes.tuner.render();
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  });
  $('#set-import').addEventListener('click', () => $('#set-import-file').click());
  $('#set-import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      store.importJson(await file.text());
      renderSettings();
      modes.tuner.render();
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  });
}

async function boot() {
  $('#start-overlay').classList.add('hidden');
  try {
    await mic.start();
  } catch (err) {
    $('#start-overlay').classList.remove('hidden');
    $('#start-error').textContent = err.message;
    return;
  }
  $('#app').classList.remove('hidden');
  if (!Object.keys(modes).length) {
    initModes();
    levelMeterLoop();
    renderSettings();
    // iOS kills the mic on screen lock/calls; show a reconnect path instead
    // of a dead-looking app
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
  nav('home');
}

document.addEventListener('DOMContentLoaded', () => {
  // machine-checkable health: Playwright and the diagnostics footer read this
  const st = selftest();
  window.__rhythmChecker = { selftest: st, version: '2.0.0', nav: (n) => nav(n) };
  if (st.passed) {
    document.querySelector('footer').classList.add('hidden');
  } else {
    $('#diag').textContent = `ENGINE SELF-TEST FAILING: ${st.failures.join(', ')}`;
    $('#diag').classList.add('warn-text');
  }

  $('#start-btn').addEventListener('click', boot);
  $('#nav-back').addEventListener('click', () => nav('home'));
  $('#settings-btn').addEventListener('click', () => $('#settings').classList.toggle('hidden'));
  $('#settings-close').addEventListener('click', () => {
    $('#settings').classList.add('hidden');
    if (modes.home && currentScreen === 'home') modes.home.render();
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline still works after first visit */ });
  }
});
