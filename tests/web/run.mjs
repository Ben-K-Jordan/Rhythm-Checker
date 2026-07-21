// Browser test harness for the web app. Runs the real app in Chromium with a
// fake microphone, executes the in-page DSP self-test (ground-truth synthetic
// checks), and smoke-tests every mode's UI.
//
//   node tests/web/run.mjs [--keep-server]
//
// Requires the `playwright` package to be resolvable (PLAYWRIGHT_BROWSERS_PATH
// points at the preinstalled Chromium).

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..', '..', 'webapp'));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

function serve() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let path = normalize(join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const failures = [];
function check(name, cond, detail = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;

// the sandbox preinstalls Chromium outside playwright's version registry
const { existsSync } = await import('node:fs');
const executablePath = process.env.CHROMIUM_PATH
  || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const browser = await chromium.launch({
  executablePath,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({ permissions: ['microphone'] });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(`${base}/index.html`);
await page.waitForFunction(() => window.__rhythmChecker !== undefined, { timeout: 10000 });

// 1. the engine's ground-truth self-test, in the real browser
const st = await page.evaluate(() => window.__rhythmChecker.selftest);
check('dsp-selftest', st.passed, (st.failures || []).join(', '));

// 2. boot with the (fake) microphone
await page.click('#start-btn');
await page.waitForSelector('#app:not(.hidden)', { timeout: 10000 });
check('mic-boot', true);

// 2b. two-state home: practice state renders, arm flow reaches the ritual,
// the Big Button carries the next action, and disarm requires a real hold
const homeState = await page.evaluate(() => ({
  active: document.querySelector('#mode-home').classList.contains('active'),
  arm: !!document.querySelector('#arm-strip'),
  tiles: document.querySelectorAll('#mode-home .tile').length,
}));
check('home-practice-state', homeState.active && homeState.arm && homeState.tiles >= 6);

await page.click('#arm-strip');
await page.click('#arm-sheet .chip[data-rel="2"]');
await page.click('#arm-go');
const armed = await page.evaluate(() => ({
  big: (document.querySelector('#big-btn .big-word') || {}).textContent || '',
  ledger: document.querySelectorAll('.ledger-row').length,
  disarm: !!document.querySelector('#disarm'),
}));
check('home-armed-state', /check\s*drums/i.test(armed.big) && armed.ledger === 2 && armed.disarm, JSON.stringify(armed));

// a quick tap must NOT disarm; a 600 ms hold must
await page.evaluate(() => {
  const d = document.querySelector('#disarm');
  d.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  d.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
});
await page.waitForTimeout(700);
const stillArmed = await page.evaluate(() => !!document.querySelector('#big-btn'));
check('disarm-ignores-taps', stillArmed);
await page.evaluate(() => {
  document.querySelector('#disarm').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
});
await page.waitForTimeout(750);
const disarmed = await page.evaluate(() => !!document.querySelector('#arm-strip'));
check('disarm-hold-works', disarmed);

// tile navigation + hard back
await page.click('#mode-home .tile[data-nav="tuner"]');
const onTuner = await page.evaluate(() => document.querySelector('#mode-tuner').classList.contains('active')
  && !document.querySelector('#nav-back').classList.contains('hidden'));
check('tile-nav-and-back', onTuner);
await page.click('#nav-back');

// 3. every tab renders its mode UI
const tabs = ['preshow', 'tuner', 'rudiments', 'timing', 'calibrate'];
for (const tab of tabs) {
  await page.evaluate((n) => window.__rhythmChecker.nav(n), tab);
  const visible = await page.$eval(`#mode-${tab}`, (el) => el.classList.contains('active') && el.innerHTML.length > 50);
  check(`tab-${tab}`, visible);
}

// 4. metronome: scheduled grid is exact on the audio clock
const metroCheck = await page.evaluate(async () => {
  const { Metronome } = await import('./js/metronome.js');
  const ctx = new AudioContext();
  await ctx.resume();
  const m = new Metronome(ctx);
  m.bpm = 120;
  m.subdivision = 4;
  m.gain = 0;
  m.start(0.05);
  await new Promise((r) => setTimeout(r, 1400)); // ~11 grid lines at 125 ms
  m.stop();
  const s = m.schedule;
  if (s.length < 8) return { ok: false, why: `only ${s.length} scheduled` };
  const interval = 60 / 120 / 4;
  for (let i = 1; i < s.length; i++) {
    if (Math.abs(s[i].time - s[i - 1].time - interval) > 1e-9) {
      return { ok: false, why: `gap ${i} = ${s[i].time - s[i - 1].time}` };
    }
  }
  const g = m.nearestGrid(m.startTime + 5.003 * interval);
  if (Math.abs(g.time - (m.startTime + 5 * interval)) > 1e-9 || g.index !== 5) {
    return { ok: false, why: 'nearestGrid wrong' };
  }
  return { ok: true, n: s.length };
});
check('metronome-grid', metroCheck.ok, metroCheck.why);

// 4b. meter math: tempo maps, odd meters, ramps, tap tempo — ground truth
const meterCheck = await page.evaluate(async () => {
  const M = await import('./js/meter.js');
  const why = [];
  const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

  { // 7/8 in 2+2+3 at ♪=160: 7 pulses per bar, accents on 0/2/4
    const meter = M.meterById('7/8');
    const { steps, clicks, total, barOffsets } = M.buildChartTimes({
      bpm: 160, meter, grouping: '2+2+3', sub: 2, bars: 2,
    });
    const pulse = 60 / 160;
    if (clicks.length !== 14) why.push(`7/8 clicks ${clicks.length}`);
    if (steps.length !== 28) why.push(`7/8 steps ${steps.length}`);
    if (!near(total, 14 * pulse)) why.push('7/8 total');
    if (!near(barOffsets[1], 7 * pulse)) why.push('7/8 bar line');
    const accents = clicks.slice(0, 7).map((c, i) => (c.accent ? i : -1)).filter((i) => i >= 0);
    if (accents.join(',') !== '0,2,4') why.push(`7/8 accents ${accents}`);
  }

  { // ramp +10 every 2 bars: segment tempos and monotonic times
    const meter = M.meterById('4/4');
    const { steps, segments } = M.buildChartTimes({
      bpm: 100, meter, grouping: '4', sub: 2, bars: 6,
      ramp: { addBpm: 10, everyBars: 2, maxBpm: 115 },
    });
    const bpms = segments.map((s) => s.bpm).join(',');
    if (bpms !== '100,110,115') why.push(`ramp segments ${bpms}`);
    for (let i = 1; i < steps.length; i++) {
      if (steps[i] <= steps[i - 1]) { why.push('ramp not monotonic'); break; }
    }
    // spacing inside bar 1 vs bar 5 reflects the tempo change
    if (!near(steps[1] - steps[0], 60 / 100 / 2) || !near(steps[steps.length - 1] - steps[steps.length - 2], 60 / 115 / 2)) {
      why.push('ramp spacing');
    }
  }

  { // tap tempo: 0.5 s taps -> 120, long gap resets
    const tt = new M.TapTempo();
    let out = null;
    for (const t of [10, 10.5, 11, 11.5]) out = tt.tap(t);
    if (out !== 120) why.push(`tap ${out}`);
    if (tt.tap(20) !== null) why.push('tap no-reset');
  }

  { // rudiment chart in 3/4: notes per bar = sub * pulses; lead swap
    const R = await import('./js/rudiments.js');
    const meter = M.meterById('3/4');
    const rud = R.RUDIMENTS.find((r) => r.id === 'paradiddle');
    const chart = R.buildChart(rud, { bpm: 120, meter, grouping: '3' }, 4, null, 'L');
    if (chart.notes.length !== rud.sub * 3 * 4) why.push(`3/4 chart ${chart.notes.length}`);
    if (chart.notes[0].stick !== 'L') why.push('lead swap');
  }

  { // accent modes are exact
    const R = await import('./js/rudiments.js');
    const singles = R.RUDIMENTS.find((r) => r.id === 'singles'); // RLRLRLRL, len 8, sub 2
    const g = { bpm: 120, meter: M.meterById('4/4'), grouping: '4' };
    // moving: accent shifts one step per repetition of the pattern
    const mov = R.buildChart(singles, g, 4, null, 'R', { mode: 'moving', custom: [] });
    const reps = 4 * 4 * singles.sub / singles.steps.length; // 4 bars of 4 pulses
    for (let rep = 0; rep < reps; rep++) {
      for (let s = 0; s < 8; s++) {
        const n = mov.notes[rep * 8 + s];
        if (n.accent !== (s === rep % 8)) { why.push(`moving accent rep${rep} step${s}`); rep = 99; break; }
      }
    }
    // custom: exactly the chosen steps, on every repetition
    const cust = R.buildChart(singles, g, 2, null, 'R', { mode: 'custom', custom: [0, 3] });
    const bad = cust.notes.some((n) => n.accent !== [0, 3].includes(n.index % 8));
    if (bad) why.push('custom accents');
    // downbeats: first note of every pulse (sub=2 -> every 2nd note)
    const down = R.buildChart(singles, g, 1, null, 'R', { mode: 'downbeats', custom: [] });
    if (down.notes.some((n) => n.accent !== (n.index % singles.sub === 0))) why.push('downbeat accents');
    // none: nothing accented
    const none = R.buildChart(singles, g, 1, null, 'R', { mode: 'none', custom: [] });
    if (none.notes.some((n) => n.accent)) why.push('none accents');
  }
  { // 200 BPM 16ths: per-note spacing recorded so the match window can cap
    const R = await import('./js/rudiments.js');
    const fast = R.buildChart(
      R.RUDIMENTS.find((r) => r.id === 'sixteenths'),
      { bpm: 200, meter: M.meterById('4/4'), grouping: '4' }, 4, null, 'R',
    );
    const step = fast.notes[0].step;
    if (Math.abs(step - 60 / 200 / 4) > 1e-9) why.push(`fast step ${step}`);
    if (Math.min(90, 0.45 * step * 1000) >= step * 1000 / 2) why.push('window overlaps neighbor');
  }
  return { ok: why.length === 0, why: why.join('; ') };
});
check('meter-and-ramps', meterCheck.ok, meterCheck.why);

// 4c. run history: saving and capping
const histCheck = await page.evaluate(async () => {
  const { store } = await import('./js/store.js');
  const before = (store.get('runs') || []).length;
  store.addRun({ kind: 'rudiment', label: 'test', meter: '4/4', bpmStart: 100, bpmEnd: 100, n: 10, mean: 1, sd: 5 });
  const runs = store.get('runs');
  return { ok: runs.length === before + 1 && runs[runs.length - 1].label === 'test' && !!runs[runs.length - 1].date };
});
check('history-store', histCheck.ok);

// 5. timing mode starts and stops without errors
await page.evaluate((n) => window.__rhythmChecker.nav(n), 'timing');
await page.click('#tm-go');
await page.waitForTimeout(1200);
const stopLabel = await page.$eval('#tm-go', (b) => b.textContent);
check('timing-start', stopLabel === 'Stop');
await page.click('#tm-go');

// 6. rudiment trainer: groove bar present, odd meter + ramp run starts/stops
await page.evaluate((n) => window.__rhythmChecker.nav(n), 'rudiments');
const grooveUi = await page.evaluate(() => {
  const rud = document.querySelector('#mode-rudiments');
  return {
    chips: rud.querySelectorAll('[data-meter]').length,
    tap: !!rud.querySelector('.tempo-tap'),
    lead: !!rud.querySelector('#rud-lead'),
    ramp: !!rud.querySelector('#rud-ramp'),
  };
});
check('groove-bar-ui', grooveUi.chips >= 8 && grooveUi.tap && grooveUi.lead && grooveUi.ramp);

// 6a. accent editor: pucks render, tapping one switches to custom + toggles it
const accentUi = await page.evaluate(() => {
  const rud = document.querySelector('#mode-rudiments');
  const pucks = rud.querySelectorAll('.accent-puck');
  const modes = rud.querySelectorAll('#rud-accent-modes button').length;
  if (!pucks.length || modes !== 5) return { ok: false, why: `pucks ${pucks.length} modes ${modes}` };
  const first = pucks[0];
  const wasOn = first.classList.contains('on');
  first.click();
  const after = rud.querySelectorAll('.accent-puck')[0].classList.contains('on');
  const customOn = rud.querySelector('#rud-accent-modes button[data-am="custom"]').classList.contains('on');
  return { ok: after === !wasOn && customOn, why: `toggle ${wasOn}->${after} custom ${customOn}` };
});
check('accent-editor', accentUi.ok, accentUi.why);

// head toggle must not clobber the fundamental/lug mode seg
const headSeg = await page.evaluate(() => {
  window.__rhythmChecker.nav('tuner');
  document.querySelector('#head-seg button[data-h="reso"]').click();
  return {
    resoOn: document.querySelector('#head-seg button[data-h="reso"]').classList.contains('on'),
    fundStillOn: document.querySelector('#mode-tuner .seg button[data-m="fundamental"]').classList.contains('on'),
  };
});
check('tuner-head-toggle-isolated', headSeg.resoOn && headSeg.fundStillOn);
await page.evaluate(() => { document.querySelector('#head-seg button[data-h="batter"]').click(); });
await page.click('#mode-rudiments #rud-accent-modes button[data-am="pattern"]');
await page.click('#mode-rudiments [data-meter="7/8"]');
const groupingShown = await page.$eval('#mode-rudiments .groove-groupings', (el) => !el.classList.contains('hidden'));
check('grouping-chips-for-odd-meter', groupingShown);
await page.selectOption('#rud-pattern', 'paradiddle');
await page.selectOption('#rud-ramp', 'r5x4');
await page.click('#rud-go');
await page.waitForTimeout(1200);
const rudState = await page.evaluate(() => {
  const cv = document.querySelector('#rud-highway');
  return { started: document.querySelector('#rud-go').textContent === 'Stop', w: cv.width };
});
check('rudiments-start', rudState.started);
await page.click('#rud-go');
await page.click('#mode-rudiments [data-meter="4/4"]');

// 6b. history tab renders (with the test run saved earlier)
await page.evaluate((n) => window.__rhythmChecker.nav(n), 'history');
const histUi = await page.evaluate(() => {
  const el = document.querySelector('#mode-history');
  return {
    active: el.classList.contains('active'),
    hasTable: !!el.querySelector('.hist-table'),
    hasTrend: !!el.querySelector('#hist-trend'),
  };
});
check('history-tab', histUi.active && histUi.hasTable && histUi.hasTrend);

// 6c. pre-show re-renders on activation: saving prerequisites elsewhere must
// enable the check without a page reload (regression: it never re-rendered)
const preshowCheck = await page.evaluate(async () => {
  const { store } = await import('./js/store.js');
  // strip every target -> revisit -> the check must disable itself
  for (const d of store.get('kit')) store.updateDrum(d.id, { targetHz: null });
  window.__rhythmChecker.nav('tuner');
  window.__rhythmChecker.nav('preshow');
  const disabledWhenBare = document.querySelector('#mode-preshow #ps-go').disabled;
  // restore prerequisites -> revisit -> it must re-enable without a reload
  store.updateDrum(store.get('kit')[0].id, { targetHz: 141 });
  store.set('baseline', { bpm: 120, subdivision: 2, mean: 0, sd: 8, pocketPct: 70, date: '2026-07-20' });
  store.set('calibrationMs', 12);
  window.__rhythmChecker.nav('tuner');
  window.__rhythmChecker.nav('preshow');
  const enabledWhenReady = !document.querySelector('#mode-preshow #ps-go').disabled;
  return { ok: disabledWhenBare && enabledWhenReady, why: `bare=${disabledWhenBare} ready=${enabledWhenReady}` };
});
check('preshow-rerenders-on-activate', preshowCheck.ok, preshowCheck.why);

// 6d. store sanitizer: a poisoned backup must not survive into state
const sanitizeCheck = await page.evaluate(async () => {
  const { store } = await import('./js/store.js');
  const calBefore = store.get('calibrationMs');
  store.importJson(JSON.stringify({
    kit: [{ id: 'x', name: '<img src=x onerror=1>', targetHz: 100 }, { bad: true }],
    calibrationMs: '99', pocketMs: 'oops', baseline: {},
  }));
  const ok = store.get('calibrationMs') === calBefore // device-specific: never imported
    && store.get('pocketMs') === 10                    // bad type -> default
    && store.get('baseline') === null                  // malformed -> default
    && store.get('kit').length === 1;                  // invalid entry filtered
  // the hostile name must render inert in settings
  document.querySelector('#settings-btn').click();
  const injected = !!document.querySelector('#settings img');
  document.querySelector('#settings-close').click();
  return { ok: ok && !injected, why: injected ? 'HTML injected' : 'field validation' };
});
check('store-sanitizer', sanitizeCheck.ok, sanitizeCheck.why);

// 6d2. kit-target sharing: merge by name, add unknowns, touch nothing personal
const kitShare = await page.evaluate(async () => {
  const { store } = await import('./js/store.js');
  const before = store.get('kit').length;
  const cal = store.get('calibrationMs');
  store.importKitJson(JSON.stringify({ rhythmCheckerKit: [
    { name: store.get('kit')[0].name, targetHz: 222 },
    { name: 'Aux Tom', targetHz: 133 },
  ] }));
  const kit = store.get('kit');
  return { ok: kit[0].targetHz === 222 && kit.length === before + 1
    && kit.some((d) => d.name === 'Aux Tom') && store.get('calibrationMs') === cal };
});
check('kit-share-import', kitShare.ok);

// 6e. mid-run tab switch cancels the timing session honestly
await page.evaluate(async () => {
  const { store } = await import('./js/store.js');
  store.reset();
});

// 6e0. genre tone preset fills the whole default kit with ordered targets
await page.evaluate(() => window.__rhythmChecker.nav('tuner'));
await page.click('#mode-tuner [data-tone="punk"]');
const tone = await page.evaluate(async () => {
  const { store } = await import('./js/store.js');
  const kit = store.get('kit');
  const hz = (word) => kit.find((d) => d.name.includes(word)).targetHz;
  // punk = Barker: snare14=300, tom8=210, tom10=175, tom12=145,
  // floor16s=95, kick22=65
  const reso = (word) => kit.find((d) => d.name.includes(word)).resoHz;
  return { ok: hz('5.5x14') === 300 && hz('8x10') === 175 && hz('9x12') === 145
    && hz('7x8') === 210 && hz('14x16') === 95 && hz('16x16') === 95 && hz('18x22') === 65
    && reso('5.5x14') === 450 && reso('8x10') === 208 && reso('18x22') === 68 };
});
check('tone-preset', tone.ok);
await page.evaluate(async () => { const { store } = await import('./js/store.js'); store.reset(); });
await page.evaluate((n) => window.__rhythmChecker.nav(n), 'timing');
await page.click('#tm-go');
await page.waitForTimeout(600);
await page.evaluate((n) => window.__rhythmChecker.nav(n), 'tuner');
await page.evaluate((n) => window.__rhythmChecker.nav(n), 'timing');
const cancelled = await page.$eval('#tm-final', (el) => el.textContent);
check('timing-cancelled-on-tab-switch', cancelled.includes('cancelled'), cancelled);

// 7. settings: kit CRUD round trip
await page.click('#settings-btn');
const kitBefore = await page.$$eval('.kit-row', (r) => r.length);
await page.click('#kit-add');
const kitAfter = await page.$$eval('.kit-row', (r) => r.length);
check('settings-kit-add', kitAfter === kitBefore + 1);

// 8. PWA plumbing reachable
for (const asset of ['manifest.webmanifest', 'sw.js', 'worklet/capture.js']) {
  const status = await page.evaluate(async (a) => (await fetch(a)).status, asset);
  check(`asset-${asset}`, status === 200);
}

// 9. no console errors across the whole run
check('no-console-errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await browser.close();
server.close();

console.log(failures.length ? `\n${failures.length} FAILURE(S)` : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
