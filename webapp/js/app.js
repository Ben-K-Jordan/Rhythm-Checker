// App shell: hub-and-spoke navigation (HOME owns the screen; every tool is
// one level deep with a hard BACK), mic bootstrap, the LIVE banner, settings
// sheet, mic-lost overlay, offline SW.

import { MicEngine } from './audio.js';
import { selftest } from './dsp.js';
import { store } from './store.js';
import { holdToConfirm, levelFrac } from './theme.js';
import { toast, seg, icon, fmtSigned, nbsp, announce, esc } from './ui.js';
import { HomeMode } from './home.js';
import { TunerMode } from './tuner.js';
import { TimingMode } from './timing.js';
import { RudimentsMode, matchWindowMs, highwayPxPerSec, puckRadius, buildChart, clusterPrimaryDev } from './rudiments.js';
import { meterById, accentsFor, defaultGrouping } from './meter.js';
import { validateRudiments, rudimentById } from './rudiment-data.js';
import { notationModel } from './notation.js';
import { CalibrateMode } from './calibrate.js';
import { HistoryMode } from './history.js';

const VERSION = '3.0.0';

const SCREENS = ['home', 'tuner', 'rudiments', 'timing', 'calibrate', 'history'];
const LISTENING = { tuner: 'TUNER', rudiments: 'RUDIMENTS', timing: 'TIMING', calibrate: 'CALIBRATE' };
const LIVE_MODES = ['rudiments', 'timing'];

const mic = new MicEngine();
const modes = {};
let currentScreen = 'home';
let shownMode = null;    // the mode whose activate() ran last
let pendingNav = null;   // set by poster lineup deep-links before mic boot
let booted = false;
let starting = false;
let micProblem = null;   // {head, text} shown by listening tools while the mic is off
let liveRun = null;      // mode currently in countin | running
let liveEndedAt = -Infinity;
let skipPops = 0;        // popstates caused by our own history.back()
let pendingImport = null; // backup text waiting for HOLD TO REPLACE

function $(sel) { return document.querySelector(sel); }

// ------------------------------------------------------------ focus floor
// An action that hides, disables or inerts the focused control must never
// leave focus on <body>. focusFirst() tries each target in order (selector or
// element; null skips) and keeps the first that really takes focus.
// visibility:hidden still has boxes (BACK keeps its slot on Home), so it is
// checked on its own; the browser drops focus from such a control a moment later.
function canFocus(el) {
  return !!el && el !== document.body && el.isConnected && !el.disabled
    && !el.closest('[inert]') && el.getClientRects().length > 0
    && getComputedStyle(el).visibility === 'visible';
}

function focusFirst(...targets) {
  for (const t of targets) {
    const el = typeof t === 'string' ? $(t) : t;
    if (!canFocus(el)) continue;
    el.focus({ preventScroll: true });
    if (document.activeElement === el) return el;
  }
  return null;
}

const focusLost = () => !canFocus(document.activeElement);

// the natural target of whatever surface is on top: the settings sheet, the
// History run sheet (history.js), else the header's settings gear
function focusTopSurface() {
  return focusFirst(
    settingsOpen() ? '#settings-close' : null,
    '#mode-history.active .hist-sheet .sheet__close',
    '#chrome-gear-left',
  );
}

// focus a non-control (a screen title or panel) for the moment; a tabindex
// added for it goes again on blur, so later taps never land on it
function focusStatic(el) {
  if (!el) return false;
  const added = !el.hasAttribute('tabindex');
  if (added) el.setAttribute('tabindex', '-1');
  if (focusFirst(el)) {
    if (added) el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true });
    return true;
  }
  if (added) el.removeAttribute('tabindex');
  return false;
}

// nav() hid the panel holding the tapped control: land on the new screen's
// title, or on the panel itself where it has none (Home)
function landOnScreen() {
  if (!focusLost()) return;
  const panel = document.querySelector('main > .mode.active');
  if (panel && (focusStatic(panel.querySelector('h1')) || focusStatic(panel))) return;
  focusFirst('#chrome-gear-left');
}

// ------------------------------------------------------------- navigation
function nav(name, { push = true } = {}) {
  if (!booted) { pendingNav = name; return; }
  if (name === 'settings') {
    // a deep-link can land here before any screen is active — the sheet
    // needs a real screen behind it, not a blank <main>
    if (!document.querySelector('.mode.active')) nav('home', { push });
    openSettings();
    return;
  }
  if (!SCREENS.includes(name)) name = 'home';
  closeSettings({ refocus: false });
  const blocked = name in LISTENING && !mic.running;
  const target = blocked ? null : modes[name] || null;
  if (shownMode && shownMode !== target && shownMode.deactivate) shownMode.deactivate();
  setLive(false);
  if (name === 'calibrate' && currentScreen !== 'calibrate') $('#mode-calibrate').dataset.returnTo = currentScreen;
  currentScreen = name;
  const panel = blocked ? 'mode-nomic' : `mode-${name}`;
  document.querySelectorAll('.mode').forEach((m) => m.classList.toggle('active', m.id === panel));
  $('#nav-back').classList.toggle('is-home', name === 'home');
  if (blocked) renderNoMic(name);
  shownMode = target;
  if (target && target.activate) target.activate();
  $('main').scrollTop = 0;
  if (push) syncHistory(name);
  landOnScreen();
}

// The in-app history is kept at [home] or [home, tool], so the system back
// gesture returns Home and a second back leaves the app.
function syncHistory(name) {
  try {
    const at = history.state && history.state.mode;
    if (at === name) return;
    if (name === 'home') {
      if (at && at !== 'home') { skipPops++; history.back(); } else history.replaceState({ mode: 'home' }, '');
    } else if (at && at !== 'home') {
      history.replaceState({ mode: name }, '');
    } else {
      history.pushState({ mode: name }, '');
    }
  } catch { /* sandboxed frames can refuse history writes */ }
}

function onPopState(e) {
  if (!booted) return;
  const mode = (e.state && e.state.mode) || 'home';
  if (skipPops > 0) {
    skipPops--;
    // another nav landed while our back() was in flight: re-seat its entry
    if (mode !== currentScreen) syncHistory(currentScreen);
    return;
  }
  nav(mode, { push: false });
}

function initModes() {
  modes.tuner = new TunerMode($('#mode-tuner'), mic);
  modes.timing = new TimingMode($('#mode-timing'), mic, nav);
  modes.rudiments = new RudimentsMode($('#mode-rudiments'), mic, nav);
  modes.calibrate = new CalibrateMode($('#mode-calibrate'), mic);
  modes.history = new HistoryMode($('#mode-history'), nav);
  modes.home = new HomeMode($('#mode-home'), nav);
}

// --------------------------------------------------------- LIVE banner
function liveText(state, label) {
  const l = String(label || '').trim();
  if (state === 'countin') return !l ? 'COUNT-IN' : l.startsWith('COUNT-IN') ? l : `COUNT-IN · ${l}`;
  return !l ? 'LIVE' : l.startsWith('LIVE') ? l : `LIVE · ${l}`;
}

function setLive(on, text = '') {
  if (on) $('#live-text').textContent = text;
  $('header.chrome').classList.toggle('is-live', on);
}

function onRunState(e) {
  const { mode, state, label } = e.detail || {};
  const live = (state === 'countin' || state === 'running') && LIVE_MODES.includes(mode);
  if (live) liveRun = mode;
  else if (liveRun === mode) { liveRun = null; liveEndedAt = performance.now(); }
  if (mode === currentScreen) setLive(live, liveText(state, label));
}

// -------------------------------------------------------------- mic meter
function levelMeterLoop() {
  const chromeMeter = $('#chrome-meter');
  const label = chromeMeter.querySelector('.meter__label');
  const notch = chromeMeter.querySelector('.meter__notch');
  const bars = [...document.querySelectorAll('header.chrome .meter__bars')].map((m) => [...m.querySelectorAll('i')]);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  let shown = 0, lit = -1, off = null, notchAt, last = performance.now();
  const tick = (now) => {
    const dt = Math.max(0, now - last);
    last = now;
    const on = mic.running;
    if (!on !== off) {
      off = !on;
      chromeMeter.classList.toggle('is-off', off);
      chromeMeter.setAttribute('aria-label', off ? 'Mic off' : 'Mic level');
      label.textContent = off ? 'MIC OFF' : 'MIC';
    }
    const f = on ? levelFrac(mic.level) : 0;
    // peak hold falls back over 1 s
    shown = reduce.matches ? f : Math.max(f, shown - dt / 1000);
    const n = shown >= 0.875 ? 4 : shown >= 0.625 ? 3 : shown >= 0.375 ? 2 : shown >= 0.125 ? 1 : 0;
    if (n !== lit) {
      lit = n;
      for (const set of bars) set.forEach((b, i) => b.classList.toggle('on', i < n));
    }
    const floor = mic.triggerFloor || 0;
    const at = floor > 0 ? Math.round(levelFrac(floor) * 1000) / 10 : null;
    if (at !== notchAt) {
      notchAt = at;
      notch.classList.toggle('hidden', at === null);
      if (at !== null) notch.style.setProperty('--notch', `${at}%`);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// -------------------------------------------------- listening tools, mic off
// Only a permission refusal is "blocked"; any other start failure (no mic,
// mic busy, insecure page, audio did not restart) is MIC OFF plus its reason.
function micProblemFor(err) {
  const blocked = !!err && err.kind === 'blocked';
  return {
    head: blocked ? 'MIC IS BLOCKED' : 'MIC OFF',
    text: (err && err.message) || '',
    kind: (err && err.kind) || 'other',
  };
}

function renderNoMic(name) {
  $('#nomic-title').textContent = LISTENING[name];
  const p = micProblem || { head: 'MIC OFF', text: '' };
  $('#nomic-head').textContent = p.head;
  $('#nomic-text').textContent = p.text;
  setBusy($('#nomic-retry'), 'TRY AGAIN', false);
}

function setBusy(btn, text, busy) {
  btn.disabled = busy;
  btn.querySelector('[class$="__label"]').textContent = text;
  btn.classList.toggle('is-busy', busy);
}

async function retryMic() {
  setBusy($('#nomic-retry'), 'STARTING MIC…', true);
  try {
    await mic.reconnect();
  } catch (err) {
    micProblem = micProblemFor(err);
  }
  if (mic.running) {
    micUp();
    nav(currentScreen, { push: false }); // lands focus on the tool it opens
    return;
  }
  renderNoMic(currentScreen);
  // the busy (disabled) button dropped focus to <body>
  if (focusLost()) focusFirst('#nomic-retry');
}

function micUp() {
  mic.setTriggerFloor(store.get('trigger') || 0);
  micProblem = null;
}

// ------------------------------------------------------------ settings
const settingsOpen = () => !$('#settings').classList.contains('hidden');

function onSettingsKey(e) {
  if (e.key === 'Escape' && $('#mic-lost').classList.contains('hidden')) {
    e.preventDefault();
    closeSettings();
  }
}

function openSettings() {
  renderSettings();
  $('#drawer-scrim').classList.remove('hidden');
  $('#settings').classList.remove('hidden');
  $('header.chrome').inert = true;
  $('main').inert = true;
  document.addEventListener('keydown', onSettingsKey);
  $('#settings-body').scrollTop = 0;
  $('#settings-close').focus();
}

function closeSettings({ refocus = true } = {}) {
  if (!settingsOpen()) return;
  $('#drawer-scrim').classList.add('hidden');
  $('#settings').classList.add('hidden');
  $('header.chrome').inert = false;
  $('main').inert = false;
  document.removeEventListener('keydown', onSettingsKey);
  refreshScreens();
  if (refocus) $('#chrome-gear-left').focus();
}

// An import, RESET ALL or kit edit replaces data the screens show. The tuner
// keeps the kit list everywhere; the current screen re-reads the store through
// its refresh(), which redraws setup/idle views and never touches a run.
function refreshScreens() {
  if (modes.tuner) modes.tuner.render();
  const m = modes[currentScreen];
  if (m && m !== modes.tuner && typeof m.refresh === 'function') m.refresh();
}

function latencyText(cal) {
  if (cal === null || cal === undefined) return 'NOT SET · CALIBRATE';
  return `${nbsp(fmtSigned(-cal), 'ms')} · RECALIBRATE`;
}

function hzText(v) {
  return typeof v === 'number' ? String(Math.round(v)) : '—';
}

function stepperHtml(id, labelId, label, value, min, max, name) {
  return `
    <div class="set-row">
      <label class="set-label" id="${labelId}" for="${id}">${label}</label>
      <div class="stepper">
        <button type="button" data-delta="-1" aria-label="${name} down 1">−</button>
        <input id="${id}" type="number" inputmode="numeric" min="${min}" max="${max}" step="1" value="${esc(value)}">
        <button type="button" data-delta="1" aria-label="${name} up 1">+</button>
      </div>
    </div>`;
}

function wireStepper(id, key, min, max) {
  const input = $(`#${id}`);
  const commit = (raw) => {
    const n = Math.round(Number(raw));
    const v = raw === '' || !Number.isFinite(n) ? store.get(key) : Math.min(max, Math.max(min, n));
    input.value = v;
    store.set(key, v);
  };
  input.addEventListener('change', () => commit(input.value));
  input.closest('.stepper').querySelectorAll('[data-delta]').forEach((b) => {
    b.addEventListener('click', () => {
      const base = input.value === '' ? store.get(key) : Number(input.value);
      commit(base + Number(b.dataset.delta));
    });
  });
}

function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importError(err, kind) {
  if (err instanceof SyntaxError) return 'Import failed: the file is not readable JSON.';
  return kind === 'kit' ? 'Import failed: not a kit-targets file.' : 'Import failed: not a Rhythm Checker backup.';
}

function renderSettings(focusId = null) {
  const kit = store.get('kit');
  const runs = store.get('runs') || [];
  const grades = !!store.get('showGrades');
  $('#settings-body').innerHTML = `
    <section class="set-group" aria-labelledby="set-h-phone">
      <div class="sec-head"><h3 id="set-h-phone" class="sec-head__stamp">THIS PHONE</h3></div>
      <div class="set-row">
        <span class="set-label" id="lbl-cal">Latency</span>
        <button id="set-cal" type="button" class="btn btn--quiet set-link" aria-labelledby="lbl-cal set-cal">${latencyText(store.get('calibrationMs'))}</button>
      </div>
      <div class="set-row set-row--stack">
        <span class="set-label" id="lbl-click">Click sound</span>
        <div id="set-click" role="group" aria-labelledby="lbl-click"></div>
      </div>
    </section>
    <section class="set-group" aria-labelledby="set-h-strict">
      <div class="sec-head"><h3 id="set-h-strict" class="sec-head__stamp">STRICTNESS</h3></div>
      <div class="set-row set-row--stack">
        <span class="set-label" id="lbl-judge">Rudiment windows</span>
        <div id="set-judge" class="seg--tall" role="group" aria-labelledby="lbl-judge"></div>
      </div>
      ${stepperHtml('set-pocket', 'lbl-pocket', 'Pocket (Timing) ± ms', store.get('pocketMs'), 3, 40, 'Pocket')}
      ${stepperHtml('set-cents', 'lbl-cents', 'In tune (Tuner) ± ¢', store.get('tuneToleranceCents'), 3, 50, 'In tune')}
      <div class="set-row set-row--switch">
        <div class="set-text">
          <span class="set-label" id="lbl-grades">Grade words</span>
          <p class="set-hint" id="hint-grades">Show perfect / good / ok next to the ms. Off by default.</p>
        </div>
        <button id="set-grades" type="button" class="switch${grades ? ' on' : ''}" role="switch" aria-checked="${grades}" aria-labelledby="lbl-grades" aria-describedby="hint-grades"><span class="switch__knob"></span></button>
      </div>
    </section>
    <section class="set-group" aria-labelledby="set-h-kit">
      <div class="sec-head" id="set-kit-head"><h3 id="set-h-kit" class="sec-head__stamp">KIT</h3></div>
      <p class="set-hint">Name drums like "Rack 9x12" so player feels can size them.</p>
      <div id="kit-list">
        ${kit.map((d) => `
          <div class="kit-row" data-id="${esc(d.id)}">
            <input class="kit-name" type="text" aria-label="Drum name" value="${esc(d.name)}">
            <span class="kit-targets">Batter&nbsp;${hzText(d.targetHz)} · Reso&nbsp;${hzText(d.resoHz)}&nbsp;Hz</span>
            <button type="button" class="kit-del hold" aria-label="Remove ${esc(d.name)}">${icon('close')}</button>
          </div>`).join('')}
      </div>
      <button id="kit-add" type="button" class="btn btn--secondary kit-add">+ ADD DRUM</button>
    </section>
    <section class="set-group" aria-labelledby="set-h-data">
      <div class="sec-head"><h3 id="set-h-data" class="sec-head__stamp">DATA</h3></div>
      <div class="set-row set-row--data">
        <div class="set-text">
          <span class="set-label">Backup</span>
          <p class="set-hint">Calibration stays on this phone.</p>
        </div>
        <div class="set-actions">
          <button id="set-export" type="button" class="chip-btn">EXPORT</button>
          <button id="set-import" type="button" class="chip-btn">IMPORT BACKUP</button>
        </div>
        <input id="set-import-file" type="file" accept="application/json" class="hidden" aria-label="Backup file">
      </div>
      <div id="set-import-preview" class="card set-preview hidden">
        <p id="set-import-line"></p>
        <button id="set-import-confirm" type="button" class="btn btn--danger hold"><span class="hold__label">HOLD TO REPLACE</span></button>
      </div>
      <div class="set-row set-row--data">
        <div class="set-text">
          <span class="set-label">Kit targets</span>
          <p class="set-hint">Share with the band.</p>
        </div>
        <div class="set-actions">
          <button id="set-share-kit" type="button" class="chip-btn">SHARE</button>
          <button id="set-import-kit" type="button" class="chip-btn">IMPORT KIT</button>
        </div>
        <input id="set-import-kit-file" type="file" accept="application/json" class="hidden" aria-label="Kit file">
      </div>
      <p class="set-note">Everything stays on this phone. Nothing is uploaded. Calibration never travels with a backup.</p>
      <button id="set-reset" type="button" class="btn btn--danger hold set-reset"><span class="hold__label">HOLD TO RESET ALL</span></button>
      <p class="set-foot">v${VERSION} · ${runs.length} runs</p>
    </section>`;

  $('#set-cal').addEventListener('click', () => nav('calibrate'));
  seg($('#set-click'), [
    { value: 'woodblock', label: 'WOODBLOCK' }, { value: 'beep', label: 'BEEP' }, { value: 'rim', label: 'RIM' },
  ], store.get('metronomeSound'), (v) => store.set('metronomeSound', v));
  seg($('#set-judge'), [
    { value: 'standard', label: 'NORMAL', sub: `miss after ±${nbsp(60, 'ms')}` },
    { value: 'pro', label: 'STRICT', sub: `miss after ±${nbsp(40, 'ms')}` },
  ], store.get('judgeMode'), (v) => store.set('judgeMode', v));
  wireStepper('set-pocket', 'pocketMs', 3, 40);
  wireStepper('set-cents', 'tuneToleranceCents', 3, 50);
  $('#set-grades').addEventListener('click', (e) => {
    const on = !store.get('showGrades');
    store.set('showGrades', on);
    e.currentTarget.setAttribute('aria-checked', String(on));
    e.currentTarget.classList.toggle('on', on);
  });

  $('#kit-add').addEventListener('click', () => {
    store.addDrum(`Drum ${store.get('kit').length + 1}`);
    renderSettings('kit-add');
    refreshScreens();
  });
  document.querySelectorAll('#kit-list .kit-row').forEach((row) => {
    const input = row.querySelector('.kit-name');
    const del = row.querySelector('.kit-del');
    input.addEventListener('change', () => {
      store.updateDrum(row.dataset.id, { name: input.value });
      del.setAttribute('aria-label', `Remove ${input.value}`);
    });
    holdToConfirm(del, () => {
      const before = structuredClone(store.get('kit'));
      const name = input.value;
      store.removeDrum(row.dataset.id);
      renderSettings('kit-add');
      refreshScreens();
      toast(`${name} removed`, {
        action: 'UNDO',
        onAction: () => {
          store.set('kit', before);
          if (settingsOpen()) renderSettings();
          refreshScreens();
        },
      });
    });
  });

  $('#set-export').addEventListener('click', () => {
    download(store.exportJson(), 'rhythm-checker-backup.json');
    toast('Backup saved.');
  });
  $('#set-share-kit').addEventListener('click', () => download(store.exportKitJson(), 'kit-targets.json'));
  $('#set-import-kit').addEventListener('click', () => $('#set-import-kit-file').click());
  $('#set-import-kit-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      store.importKitJson(await file.text());
      renderSettings('set-import-kit');
      refreshScreens();
    } catch (err) { toast(importError(err, 'kit')); }
  });
  $('#set-import').addEventListener('click', () => $('#set-import-file').click());
  $('#set-import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let text, data;
    try {
      text = await file.text();
      data = JSON.parse(text);
      if (typeof data !== 'object' || data === null || !Array.isArray(data.kit)) throw new Error('not a backup');
    } catch (err) { toast(importError(err, 'backup')); return; }
    const incoming = Array.isArray(data.runs) ? data.runs.length : 0;
    $('#set-import-line').textContent = `Replace ${(store.get('runs') || []).length} runs with ${incoming} from this file?`;
    $('#set-import-preview').classList.remove('hidden');
    pendingImport = text;
    $('#set-import-confirm').focus();
  });
  holdToConfirm($('#set-import-confirm'), () => {
    if (pendingImport === null) return;
    const text = pendingImport;
    pendingImport = null;
    try {
      store.importJson(text);
    } catch (err) { toast(importError(err, 'backup')); return; }
    renderSettings('set-import');
    refreshScreens();
    toast(`Imported ${(store.get('runs') || []).length} runs.`);
  }, { label: 'HOLD TO REPLACE' });
  pendingImport = null;

  holdToConfirm($('#set-reset'), () => {
    store.reset();
    mic.setTriggerFloor(0);
    renderSettings('set-reset');
    refreshScreens();
  }, { label: 'HOLD TO RESET ALL' });

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) el.focus({ preventScroll: true });
  }
}

// ------------------------------------------------------------ mic lost
function showMicLost(reason) {
  const wasLive = liveRun !== null || performance.now() - liveEndedAt < 100;
  micProblem = { head: 'MIC OFF', text: reason };
  $('#mic-lost-reason').textContent = reason;
  $('#mic-lost-run').classList.toggle('hidden', !wasLive);
  $('#mic-lost-steps').classList.add('hidden');
  setBusy($('#mic-lost-btn'), 'RECONNECT', false);
  $('#mic-lost-btn').dataset.reload = '';
  $('#app').inert = true;
  $('#mic-lost').classList.remove('hidden');
  $('#mic-lost-btn').focus();
}

function hideMicLost() {
  $('#mic-lost').classList.add('hidden');
  $('#app').inert = false;
}

async function reconnectMic() {
  const btn = $('#mic-lost-btn');
  if (btn.dataset.reload) { window.location.reload(); return; }
  setBusy(btn, 'RECONNECTING…', true);
  let error = null;
  try {
    await mic.reconnect();
  } catch (err) { error = err; }
  if (mic.running) {
    micUp();
    hideMicLost();
    if (currentScreen in LISTENING && !shownMode) nav(currentScreen, { push: false });
    // the header stays inert under an open settings or run sheet
    focusTopSurface();
    return;
  }
  if (error) micProblem = micProblemFor(error); // what HOME's mic-off tools show
  $('#mic-lost-error').textContent = error ? error.message : 'Audio did not restart. Reload the app to get the mic back.';
  $('#mic-lost-steps').classList.remove('hidden');
  btn.dataset.reload = '1';
  setBusy(btn, 'RELOAD APP', false);
  btn.focus();
}

// ------------------------------------------------------------ start poster
// idle | busy | denied. A retry from the denied card stays on that layout
// while busy, so the lineup does not flash back in. The denied card names
// the problem: the iPhone permission steps only when permission was refused
// (problem.kind 'blocked'), otherwise MIC OFF with the plain reason.
function posterState(state, problem = null) {
  const overlay = $('#start-overlay');
  const busy = state === 'busy';
  const denied = state === 'denied' || (busy && overlay.dataset.layout === 'denied');
  overlay.dataset.state = state;
  overlay.dataset.layout = denied ? 'denied' : 'lineup';
  overlay.querySelector('.poster-lineup').classList.toggle('hidden', denied);
  $('#start-denied').classList.toggle('hidden', !denied);
  $('#start-nomic').classList.toggle('hidden', !denied);
  $('#start-nomic').disabled = busy;
  if (problem) {
    overlay.dataset.micError = problem.kind;
    $('#start-denied-title').textContent = problem.head;
    $('#start-error').textContent = problem.text;
  }
  setBusy($('#start-btn'), busy ? 'STARTING MIC…' : denied ? 'TRY AGAIN' : 'TAP TO START', busy);
  overlay.querySelectorAll('[data-goto]').forEach((b) => {
    b.classList.toggle('on', state === 'busy' && b.dataset.goto === pendingNav);
  });
}

async function boot() {
  if (starting || booted) return;
  starting = true;
  posterState('busy');
  try {
    await mic.start();
  } catch (err) {
    starting = false;
    // OPEN WITHOUT MIC carries the same problem into the listening tools
    micProblem = micProblemFor(err);
    posterState('denied', micProblem);
    // the busy (disabled) CTA or a now-hidden bill dropped focus to <body>
    if (focusLost()) focusFirst('#start-btn');
    announce(`${micProblem.head}. ${micProblem.text}`);
    return;
  }
  starting = false;
  micUp();
  enterApp(pendingNav || 'home');
}

function enterApp(target) {
  if (!booted) {
    booted = true;
    initModes();
    levelMeterLoop();
    mic.addEventListener('lost', (e) => showMicLost(e.detail.reason));
  }
  $('#start-overlay').classList.add('hidden');
  $('#app').classList.remove('hidden');
  try { history.replaceState({ mode: 'home' }, ''); } catch { /* sandboxed */ }
  pendingNav = null;
  nav(target);
}

document.addEventListener('DOMContentLoaded', () => {
  // machine-checkable health: Playwright and the diagnostics footer read this
  const st = selftest();
  window.__rhythmChecker = {
    selftest: st, version: VERSION, nav: (n) => nav(n), matchWindowMs,
    // test/automation seam: the shared mic (an EventTarget you can dispatch
    // synthetic 'onset' events on) and the live mode instances
    mic, modes,
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
    $('#diag').textContent = `Engine self-test failed: ${st.failures.join(', ')}. Numbers may be wrong.`;
  }

  $('#start-btn').addEventListener('click', boot);
  $('#start-nomic').addEventListener('click', () => enterApp('home'));
  document.querySelectorAll('#start-overlay [data-goto]').forEach((el) => {
    el.addEventListener('click', () => {
      pendingNav = el.dataset.goto;
      if (starting) { posterState('busy'); return; }
      boot();
    });
  });

  $('#nav-back').addEventListener('click', () => nav('home'));
  $('#chrome-meter').addEventListener('click', () => nav('calibrate'));
  $('#chrome-gear-left').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', () => closeSettings());
  $('#drawer-scrim').addEventListener('click', () => closeSettings());
  $('#nomic-retry').addEventListener('click', retryMic);
  $('#mic-lost-btn').addEventListener('click', reconnectMic);
  $('#mic-lost-home').addEventListener('click', () => {
    hideMicLost();
    nav('home');
    focusTopSurface();
  });
  document.addEventListener('rc:run', onRunState);
  window.addEventListener('popstate', onPopState);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline still works after first visit */ });
  }
});
