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
const executablePath = process.env.CHROMIUM_PATH
  || (await import('node:fs')).existsSync('/opt/pw-browsers/chromium')
    ? '/opt/pw-browsers/chromium'
    : undefined;

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

// 3. every tab renders its mode UI
const tabs = ['preshow', 'tuner', 'rudiments', 'timing', 'calibrate'];
for (const tab of tabs) {
  await page.click(`.tab-btn[data-tab="${tab}"]`);
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

// 5. timing mode starts and stops without errors
await page.click('.tab-btn[data-tab="timing"]');
await page.click('#tm-go');
await page.waitForTimeout(1200);
const stopLabel = await page.$eval('#tm-go', (b) => b.textContent);
check('timing-start', stopLabel === 'Stop');
await page.click('#tm-go');

// 6. rudiment trainer: chart builds, highway animates, stop works
await page.click('.tab-btn[data-tab="rudiments"]');
await page.selectOption('#rud-pattern', 'paradiddle');
await page.click('#rud-go');
await page.waitForTimeout(1200);
const rudState = await page.evaluate(() => {
  const cv = document.querySelector('#rud-highway');
  return { started: document.querySelector('#rud-go').textContent === 'Stop', w: cv.width };
});
check('rudiments-start', rudState.started);
await page.click('#rud-go');

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
