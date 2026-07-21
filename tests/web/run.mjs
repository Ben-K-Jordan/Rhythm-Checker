// Browser test harness for the web app. Runs the real app in Chromium with a
// fake microphone, executes the in-page DSP self-test (ground-truth synthetic
// checks), and smoke-tests every screen of the gig-poster UI.
//
//   node tests/web/run.mjs
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
  '.png': 'image/png', '.ttf': 'font/ttf',
};

function serve() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const path = normalize(join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!path.startsWith(ROOT)) throw new Error('traversal');
      res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
      res.end(await readFile(path));
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const results = [];
let failed = false;
function check(name, ok, detail = '') {
  results.push([name, !!ok, detail]);
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

const days = (n) => new Date(Date.now() - n * 86400000).toISOString();
const SEED = {
  calibrationMs: 8.4,
  baseline: { bpm: 120, subdivision: 2, mean: -2.1, sd: 9.8, pocketPct: 78, date: days(3) },
  runs: [
    { date: days(2), kind: 'rudiment', label: 'Single Paradiddle', meter: '4/4', bpmStart: 120, bpmEnd: 120, n: 128, mean: -3.1, sd: 11.2, accuracy: 91, missed: 4 },
    { date: days(1), kind: 'timing', label: 'steady hold ÷2', meter: '4/4', bpmStart: 120, bpmEnd: 120, n: 96, mean: 2.2, sd: 9.9, pocketPct: 71 },
    { date: days(0), kind: 'show', label: 'Rehearsal room', meter: '4/4', bpmStart: 122, bpmEnd: 122, n: 300, mean: 5.0, sd: 12.0, result: 'NOT YET', heldPct: 61, songs: 9, minutes: 40 },
  ],
};

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 760 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR: ${String(e).slice(0, 200)}`));
await page.addInitScript((s) => localStorage.setItem('rhythm-checker-v1', JSON.stringify(s)), SEED);
await page.goto(`${base}/index.html`);

// ------------------------------------------------------------ DSP self-test
await page.waitForFunction(() => window.__rhythmChecker);
const st = await page.evaluate(() => window.__rhythmChecker.selftest);
check('dsp-selftest', st.passed, (st.failures || []).join('; '));

// ------------------------------------------------------------- start poster
check('poster-lineup', await page.locator('#start-overlay .bill').count() === 4);
check('poster-starburst', await page.locator('.starburst svg').count() === 1);

// deep-link from the poster bill boots straight into a module
await page.click('[data-goto="tuner"]');
await page.waitForSelector('#app:not(.hidden)');
check('poster-deep-link', await page.locator('#mode-tuner.active').count() === 1);

const nav = (t) => page.evaluate((x) => window.__rhythmChecker.nav(x), t);

// -------------------------------------------------------------------- home
await nav('home');
check('home-arm-toggle', await page.locator('.arm-seg').count() === 2);
check('home-feel-cards', await page.locator('.feel-card').count() === 3);
check('home-modules', await page.locator('.module-tile').count() === 4
  && await page.locator('.hero-tile').count() === 1);
check('home-stats-real', (await page.locator('.stat-strip .statbox b').first().textContent()).trim() === '3');

// selecting a feel writes real targets onto the kit
await page.click('[data-feel="barker"]');
await page.waitForTimeout(120);
const snareAfterFeel = await page.evaluate(() => JSON.parse(localStorage.getItem('rhythm-checker-v1')).kit.find((d) => d.id === 'snare'));
check('feel-applies-targets', snareAfterFeel.targetHz === 300 && snareAfterFeel.resoHz === 450,
  `snare ${snareAfterFeel.targetHz}/${snareAfterFeel.resoHz}`);
check('feel-card-active', await page.locator('.feel-card.on .feel-name').textContent() === 'BARKER');

// --------------------------------------------------------------------- tuner
await nav('tuner');
check('tuner-gauge', await page.locator('.gauge-stage svg path').count() === 5);
check('tuner-drum-chips', await page.locator('[data-drum]').count() === 7);
await page.click('[data-drum="snare"]');
await page.waitForTimeout(100);
check('tuner-target-shown', (await page.locator('#gauge-target').textContent()).includes('300'));
await page.selectOption('#tuner-head', 'reso');
await page.waitForTimeout(100);
check('tuner-head-reso', (await page.locator('#gauge-target').textContent()).includes('450'));
check('tuner-feel-rows', await page.locator('.feel-row').count() === 3);
await page.click('[data-mode="lug"]');
await page.waitForTimeout(100);
check('tuner-lug-mode', await page.locator('#lug-panel:not(.hidden)').count() === 1);
await page.click('[data-mode="fund"]');

// ---------------------------------------------------------------- rudiments
await nav('rudiments');
check('rud-controls', await page.locator('.param-box').count() === 4);
check('rud-accent-pills', await page.locator('[data-am]').count() === 5);
check('rud-accent-pucks', await page.locator('.accent-puck').count() === 8);
// tapping a puck flips into custom accent mode
await page.click('.accent-puck[data-step="1"]');
await page.waitForTimeout(80);
check('rud-custom-accents', await page.locator('[data-am="custom"].on').count() === 1);
// lead toggle
await page.click('#rud-lead');
check('rud-lead-toggle', (await page.locator('#rud-lead').textContent()).trim() === 'L');
await page.click('#rud-lead');
// tempo expansion + ramp pills
await page.click('#rud-tempo-chip');
await page.waitForTimeout(80);
check('rud-tempo-expand', await page.locator('[data-ramp]').count() === 4);
await page.click('[data-bpm="5"]');
check('rud-bpm-step', (await page.locator('#rud-tempo-chip').textContent()).trim() !== '');
// meter expansion offers odd meters with groupings
await page.click('#rud-meter-chip');
await page.waitForTimeout(80);
await page.click('[data-meter="7/8"]');
await page.waitForTimeout(120);
check('rud-odd-meter', await page.locator('[data-grouping]').count() >= 3);
await page.click('[data-meter="4/4"]');
await page.waitForTimeout(80);
// a run starts and stops cleanly
await page.click('#rud-go');
await page.waitForTimeout(600);
check('rud-run-starts', (await page.locator('#rud-go').textContent()).includes('STOP'));
await page.click('#rud-go');
await page.waitForTimeout(200);
check('rud-run-stops', (await page.locator('#rud-go').textContent()).includes('PLAY'));

// ------------------------------------------------------------------- timing
await nav('timing');
check('tm-controls', await page.locator('.tc-card').count() === 3);
await page.click('#tm-click');
await page.waitForTimeout(80);
check('tm-click-off', (await page.locator('#tm-click .tc-val b').textContent()).trim() === 'OFF');
await page.click('#tm-go');
await page.waitForTimeout(500);
check('tm-run-starts', (await page.locator('#tm-go').textContent()).includes('STOP'));
await page.click('#tm-go');
await page.waitForTimeout(200);
check('tm-run-stops', (await page.locator('#tm-go').textContent()).includes('START'));
// leaving mid-run cancels honestly
await page.click('#tm-go');
await page.waitForTimeout(300);
await nav('home');
await nav('timing');
check('tm-cancelled-on-nav', (await page.locator('#tm-final').textContent()).includes('cancelled'));

// ----------------------------------------------------------------- show flow
await nav('preshow');
check('ps-readiness-rows', await page.locator('.check-row').count() === 5);
check('ps-calibrated-green', await page.locator('.check-row').first().locator('.check-ic.ok').count() === 1);
// click-ack toggles
const ackBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('rhythm-checker-v1')).clickAck);
await page.click('[data-check="clickack"]');
await page.waitForTimeout(100);
const ackAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('rhythm-checker-v1')).clickAck);
check('ps-clickack-toggles', ackBefore !== ackAfter);
// arm -> armed screen with DISARM chrome
await page.click('#ps-arm');
await page.waitForTimeout(400);
check('armed-active', await page.locator('#mode-armed.active').count() === 1);
check('armed-chrome-disarm', (await page.locator('#nav-back').textContent()).includes('DISARM'));
check('armed-waveform', await page.locator('.wave i').count() === 34);
// disarm -> honest empty verdict (fake mic heard nothing attributable)
await page.click('#armed-disarm');
await page.waitForTimeout(500);
check('verdict-active', await page.locator('#mode-verdict.active').count() === 1);
check('verdict-honest-empty', (await page.locator('#mode-verdict').textContent()).includes('NOTHING'));

// ------------------------------------------------------------------ history
await nav('history');
check('hist-heatmap', await page.locator('.heatmap i').count() === 70);
check('hist-rows', await page.locator('.log-row').count() === 3);
check('hist-show-badge', (await page.locator('.log-badge.solid.red').textContent()).includes('NOT YET'));
await page.click('[data-f="rudiment"]');
await page.waitForTimeout(100);
check('hist-filter', await page.locator('.log-row').count() === 1);
await page.click('[data-f="all"]');

// ---------------------------------------------------------------- calibrate
await nav('calibrate');
check('cal-two-steps', await page.locator('.num-chip').count() === 2);
check('cal-trig-mark', await page.locator('#trig-mark').count() === 1);
check('cal-result-shown', (await page.locator('#cal-result').textContent()).includes('8'));

// ----------------------------------------------------------------- settings
await page.click('#settings-btn');
await page.waitForTimeout(300);
check('drawer-open', await page.locator('#settings:not(.hidden)').count() === 1);
check('drawer-kit-rows', await page.locator('.kit-row').count() === 7);
const gradesBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('rhythm-checker-v1')).showGrades);
await page.click('#set-grades');
await page.waitForTimeout(100);
const gradesAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('rhythm-checker-v1')).showGrades);
check('drawer-grades-toggle', gradesBefore !== gradesAfter);
await page.click('#kit-add');
await page.waitForTimeout(100);
check('drawer-kit-add', await page.locator('.kit-row').count() === 8);
await page.click('#drawer-scrim', { position: { x: 12, y: 12 } });
await page.waitForTimeout(200);
check('drawer-scrim-close', await page.locator('#settings.hidden').count() === 1);

// ---------------------------------------------- state persistence (sanitize)
// A stage time set in pre-show and an intentionally emptied kit must both
// survive sanitize() on load (regressions: sanitize() dropped
// showMeta.stage, breaking the T-minus countdown; and reset an empty kit to
// the 7-drum defaults). Fresh context whose init payload IS the tricky state,
// then force a persist so the SANITIZED state is written back and read.
{
  const ctx2 = await browser.newContext({ permissions: ['microphone'], viewport: { width: 390, height: 760 } });
  const p2 = await ctx2.newPage();
  await p2.addInitScript(() => localStorage.setItem('rhythm-checker-v1', JSON.stringify({
    showMeta: { venue: 'X', setMin: 45, songs: 12, stage: '21:30' },
    kit: [],
  })));
  await p2.goto(`${base}/index.html`);
  await p2.waitForFunction(() => window.__rhythmChecker);
  await p2.click('#start-btn');
  await p2.waitForSelector('#app:not(.hidden)');
  // pocket window change goes through store.set -> persist(), writing sanitized state
  await p2.click('#settings-btn');
  await p2.waitForTimeout(200);
  await p2.fill('#set-pocket', '11');
  await p2.dispatchEvent('#set-pocket', 'change');
  await p2.waitForTimeout(120);
  const afterSanitize = await p2.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('rhythm-checker-v1'));
    return { stage: raw.showMeta && raw.showMeta.stage, kitLen: raw.kit.length };
  });
  check('persist-stage-time', afterSanitize.stage === '21:30', `stage=${afterSanitize.stage}`);
  check('persist-empty-kit', afterSanitize.kitLen === 0, `kit had ${afterSanitize.kitLen} drums`);
  await ctx2.close();
}

// ------------------------------------------------------- sw asset integrity
const swSrc = await (await fetch(`${base}/sw.js`)).text();
const assets = [...swSrc.matchAll(/'([^']+)'/g)].map((m) => m[1])
  .filter((a) => a.includes('.') && !a.startsWith('rhythm-checker'));
let assetsOk = true;
for (const a of assets) {
  const res = await fetch(`${base}/${a}`);
  if (!res.ok) { assetsOk = false; check(`asset-${a}`, false, `HTTP ${res.status}`); }
}
check('sw-assets-all-present', assetsOk, `${assets.length} checked`);

// -------------------------------------------------------------- final gates
check('no-console-errors', consoleErrors.length === 0, [...new Set(consoleErrors)].join(' | ').slice(0, 300));

await browser.close();
server.close();
console.log(failed ? '\nFAILURES PRESENT' : '\nALL PASS');
process.exit(failed ? 1 : 0);
