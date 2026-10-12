// History: every finished run, by spread and by day. The filter drives the
// stat tiles, both charts and the list; a row opens a read-only run sheet.

import { store } from './store.js';
import { icon, seg, fmtSigned, nbsp } from './ui.js';

const PAGE = 6;
const SPREAD_RUNS = 30; // the spread chart plots the most recent runs
const NBSP = '\u00a0';
const FILTERS = [['all', 'ALL'], ['rudiment', 'RUDIMENTS'], ['timing', 'TIMING']];
const TAG = { rudiment: 'RUDIMENTS', timing: 'TIMING' };
const EMPTY = {
  all: ['No runs yet. Finished runs land here.', ['rudiments', 'timing']],
  rudiment: ['No rudiment runs yet.', ['rudiments']],
  timing: ['No timing runs yet.', ['timing']],
};
const GO = { rudiments: 'PLAY A RUDIMENT', timing: 'HOLD A TEMPO' };

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// Only `sd`, `mean`, `date` and `accuracy` are type-checked on load; every
// other stored field can be anything a hand-edited backup put there.
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Calendar math is LOCAL throughout: run dates are stored as UTC instants,
// but "did I practice Friday" means the user's Friday. Mixing UTC day keys
// with a local weekday anchor shifted every evening session into the wrong
// cell for anyone not living in UTC.
function localDayKey(instant) {
  const d = new Date(instant);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Calendar days back from today; date arithmetic rather than 24 h steps, so
// a 23 or 25 hour DST day never skips or repeats a key.
function localDay(offsetDays) {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate() - offsetDays);
}

function dayKey(offsetDays) {
  return localDayKey(localDay(offsetDays));
}

function streakDays(runs) {
  const days = new Set(runs.map((r) => (r.date ? localDayKey(r.date) : '')));
  if (!days.size) return 0;
  const start = days.has(dayKey(0)) ? 0 : days.has(dayKey(1)) ? 1 : -1;
  if (start < 0) return 0;
  let n = 0;
  while (days.has(dayKey(start + n))) n++;
  return n;
}

function validDate(r) {
  const d = new Date(r.date);
  return Number.isNaN(d.getTime()) ? null : d;
}

const monthDay = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const time = (r) => { const d = validDate(r); return d ? d.getTime() : 0; };
const plural = (n, one, many) => `${n}${NBSP}${n === 1 ? one : many}`;
const spreadText = (sd) => `±${Math.abs(sd).toFixed(1)}`;

function bpmText(r) {
  const a = num(r.bpmStart), b = num(r.bpmEnd);
  if (a === null) return null;
  return nbsp(b !== null && b !== a ? `${a}–${b}` : `${a}`, 'BPM');
}

function meterText(r) {
  return typeof r.meter === 'string' && r.meter.trim() ? r.meter.trim() : null;
}

function avgText(mean, caps = false) {
  const v = Math.abs(mean).toFixed(1);
  const dir = Number(v) === 0 ? '' : ` ${mean < 0 ? 'early' : 'late'}`;
  const text = `${nbsp(v, 'ms')}${caps ? dir.toUpperCase() : dir}`;
  return `${caps ? 'AVG' : 'avg'} ${text}`;
}

// ------------------------------------------------------- spread chart (SVG)
const SP = { h: 120, l: 36, r: 10, t: 14, b: 22, cap: 80 };

function spreadGeometry(runs, w, baseSd) {
  const pw = w - SP.l - SP.r, ph = SP.h - SP.t - SP.b;
  const hi = Math.max(10, ...runs.map((r) => r.sd), ...(baseSd === null ? [] : [baseSd]));
  const step = hi <= 15 ? 5 : hi <= 30 ? 10 : 20;
  const top = Math.min(SP.cap, step * Math.max(2, Math.ceil((hi * 1.04) / step)));
  const n = runs.length;
  return {
    w, pw, ph, step, top,
    x: (i) => (n === 1 ? SP.l + pw / 2 : SP.l + (pw * i) / (n - 1)),
    y: (v) => SP.t + ph * (1 - Math.min(Math.max(v, 0), top) / top),
  };
}

function boxHitsLine(box, pts) {
  if (pts.some(([x, y]) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3])) return true;
  for (let k = 1; k < pts.length; k++) {
    const [x0, y0] = pts[k - 1], [x1, y1] = pts[k];
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= steps; s++) {
      const px = x0 + ((x1 - x0) * s) / steps, py = y0 + ((y1 - y0) * s) / steps;
      if (px >= box[0] && px <= box[2] && py >= box[1] && py <= box[3]) return true;
    }
  }
  return false;
}

const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

// First candidate [x, baselineY, anchor] whose text box stays inside `bounds`
// and clear of the line, its dots and the boxes in `avoid`.
function placeLabel(cands, width, height, pts, avoid, bounds) {
  const boxOf = ([ax, ay, anchor]) => {
    const x0 = anchor === 'end' ? ax - width : ax;
    return [x0, ay - height, x0 + width, ay + 3];
  };
  for (const c of cands) {
    const box = boxOf(c);
    if (box[0] < bounds[0] || box[2] > bounds[2] || box[1] < bounds[1] || box[3] > bounds[3]) continue;
    if (boxHitsLine([box[0] - 4, box[1] - 4, box[2] + 4, box[3] + 4], pts)) continue;
    if (avoid.some((b) => overlaps(b, box))) continue;
    return { c, box };
  }
  return { c: cands[0], box: boxOf(cands[0]) };
}

function spreadSvg(runs, g, baseSd, sel) {
  const { w, top, step } = g;
  const right = SP.l + g.pw, bottom = SP.t + g.ph;
  const bounds = [SP.l, 1, w - 1, bottom - 2];
  const parts = [];
  for (let v = 0; v <= top + 1e-9; v += step) {
    const y = g.y(v).toFixed(1);
    parts.push(`<line class="${v === 0 ? 'sp-zero' : 'sp-grid'}" x1="${SP.l}" x2="${right}" y1="${y}" y2="${y}"/>`,
      `<text class="sp-tick" x="${SP.l - 7}" y="${y}" dy=".35em" text-anchor="end">±${v}</text>`);
  }
  const yb = baseSd === null ? null : g.y(baseSd);
  if (yb !== null) parts.push(`<line class="sp-base" x1="${SP.l}" x2="${right}" y1="${yb.toFixed(1)}" y2="${yb.toFixed(1)}"/>`);
  const pts = runs.map((r, i) => [g.x(i), g.y(r.sd)]);
  if (pts.length > 1) parts.push(`<polyline class="sp-line" points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"/>`);
  pts.forEach(([x, y], i) => {
    const last = i === pts.length - 1;
    if (runs[i].sd > top) {
      // clamped: an arrowhead pinned to the top edge
      parts.push(`<path class="sp-dot" d="M${(x - 5).toFixed(1)} ${(y + 4).toFixed(1)}h10l-5 -8z"/>`);
    } else {
      parts.push(`<circle class="sp-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${last ? 5.5 : 4}"/>`);
    }
  });
  if (sel !== null && pts[sel]) {
    parts.push(`<circle class="sp-sel" cx="${pts[sel][0].toFixed(1)}" cy="${pts[sel][1].toFixed(1)}" r="8.5"/>`);
  }
  // last value label: above-left of the last dot unless the line is there
  const [lx, ly] = pts[pts.length - 1];
  const label = `${spreadText(runs[runs.length - 1].sd)}${NBSP}ms`;
  const last = placeLabel([
    [lx - 10, ly - 10, 'end'], [lx - 10, ly + 20, 'end'], [lx - 14, ly + 5, 'end'],
    [lx - 10, ly - 24, 'end'], [lx - 10, ly + 34, 'end'], [lx + 12, ly - 10, 'start'], [lx + 12, ly + 20, 'start'],
  ], label.length * 7.9, 11, pts, [], bounds);
  if (yb !== null) {
    const text = `baseline ${spreadText(baseSd)}`;
    const mid = SP.l + g.pw / 2;
    const base = placeLabel([
      [SP.l + 4, yb - 5, 'start'], [SP.l + 4, yb + 14, 'start'], [mid, yb - 5, 'middle'], [mid, yb + 14, 'middle'],
      [right - 4, yb - 5, 'end'], [right - 4, yb + 14, 'end'],
    ].map(([x, y, a]) => (a === 'middle' ? [x - (text.length * 6.6) / 2, y, 'start'] : [x, y, a])),
    text.length * 6.6, 9, pts, [last.box], bounds);
    parts.push(`<text class="sp-base-label" x="${base.c[0].toFixed(1)}" y="${base.c[1].toFixed(1)}" text-anchor="${base.c[2]}">${text}</text>`);
  }
  parts.push(`<text class="sp-last" x="${last.c[0].toFixed(1)}" y="${last.c[1].toFixed(1)}" text-anchor="${last.c[2]}">${label}</text>`);
  const first = validDate(runs[0]), lastD = validDate(runs[runs.length - 1]);
  const a = first ? monthDay(first) : '', b = lastD ? monthDay(lastD) : '';
  if (runs.length > 1 && a && a !== b) parts.push(`<text class="sp-tick" x="${SP.l}" y="${SP.h - 5}">${a}</text>`);
  if (b) parts.push(`<text class="sp-tick" x="${runs.length > 1 ? right : g.x(0)}" y="${SP.h - 5}" text-anchor="${runs.length > 1 ? 'end' : 'middle'}">${b}</text>`);
  return `<svg class="sp" width="${w}" height="${SP.h}" viewBox="0 0 ${w} ${SP.h}" aria-hidden="true" focusable="false">${parts.join('')}</svg>`;
}

// --------------------------------------------------------------- heatmap
// 10 columns = weeks (oldest left), 7 rows = Mon..Sun; DOM order runs
// week by week so a screen reader reads the days in calendar order.
function heatCells(runs) {
  const counts = new Map();
  for (const r of runs) {
    const k = r.date ? localDayKey(r.date) : '';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const dow = (new Date().getDay() + 6) % 7; // Mon=0
  const cells = [];
  for (let wk = 9; wk >= 0; wk--) {
    for (let d = 0; d < 7; d++) {
      const offset = wk * 7 + (dow - d);
      if (offset < 0) { cells.push({ future: true }); continue; }
      const day = localDay(offset);
      cells.push({ day, n: counts.get(localDayKey(day)) || 0, today: offset === 0 });
    }
  }
  return cells;
}

const heatLabel = (c) => `${monthDay(c.day)} · ${plural(c.n, 'run', 'runs')}`;

function monthLabels(cells) {
  const marks = [];
  for (let col = 0; col < 10; col++) {
    const week = cells.slice(col * 7, col * 7 + 7).filter((c) => !c.future);
    const first = week.find((c) => c.day.getDate() === 1);
    if (first) marks.push([col, first.day]);
  }
  if (!marks.length || marks[0][0] >= 2) marks.unshift([0, cells[0].day]);
  return marks.map(([col, d]) => `<span style="grid-column:${col + 1}">${d.toLocaleDateString('en-US', { month: 'short' })}</span>`).join('');
}

export class HistoryMode {
  // constructor stays render-free on purpose: History is built eagerly during
  // boot, and a render throw here once aborted the whole app mid-boot
  constructor(root, nav = null) {
    this.root = root;
    this.nav = nav;
    this.filter = 'all';
    this.showAll = false;
    this.sheet = null;
    this.ro = null;
  }

  activate() { this.render(); }

  deactivate() {
    this.closeSheet(false);
    if (this.ro) { this.ro.disconnect(); this.ro = null; }
  }

  go(name) {
    const nav = this.nav || (window.__rhythmChecker && window.__rhythmChecker.nav);
    if (nav) nav(name);
  }

  runs() {
    const all = store.get('runs') || [];
    if (this.filter === 'all') return all;
    return all.filter((r) => r.kind === this.filter);
  }

  render() {
    this.closeSheet(false);
    this.root.innerHTML = `
      <div class="screen hist">
        <div class="title-row">
          <h1 class="stamp">HISTORY</h1>
          <button id="hist-csv" type="button" class="btn btn--quiet hist-csv" aria-label="Export CSV">CSV${icon('down')}</button>
        </div>
        <div class="stat-strip hist-stats"></div>
        <div class="hist-filter" role="group" aria-label="Filter runs"></div>
        <div class="hist-body"></div>
      </div>`;
    seg(this.root.querySelector('.hist-filter'),
      FILTERS.map(([value, label]) => ({ value, label, data: { f: value } })),
      this.filter,
      (value) => { this.filter = value; this.showAll = false; this.fill(); });
    this.root.querySelector('#hist-csv').addEventListener('click', () => this.exportCsv());
    this.fill();
  }

  // everything the filter drives: tiles, charts, list
  fill() {
    const runs = this.runs().slice().sort((a, b) => time(a) - time(b));
    const csv = this.root.querySelector('#hist-csv');
    csv.disabled = !runs.length;

    const now = Date.now();
    const week = runs.filter((r) => (now - time(r)) < 7 * 86400000).length;
    const tile = (v, label) => `<div class="statbox${runs.length ? '' : ' is-empty'}"><b>${runs.length ? v : '—'}</b><span>${label}</span></div>`;
    this.root.querySelector('.hist-stats').innerHTML = tile(runs.length, 'RUNS')
      + tile(streakDays(runs), 'DAYS IN A ROW') + tile(week, 'LAST 7 DAYS');

    const body = this.root.querySelector('.hist-body');
    if (this.ro) { this.ro.disconnect(); this.ro = null; }
    if (!runs.length) {
      const [text, tools] = EMPTY[this.filter] || EMPTY.all;
      body.innerHTML = `
        <div class="empty hist-empty">
          <p>${text}</p>
          <div class="empty__actions">${tools.map((t) => `
            <button type="button" class="btn btn--secondary" data-to="${t}">${GO[t]}</button>`).join('')}
          </div>
        </div>`;
      body.querySelectorAll('[data-to]').forEach((b) => b.addEventListener('click', () => this.go(b.dataset.to)));
      return;
    }

    const shown = this.showAll ? runs.slice().reverse() : runs.slice(-PAGE).reverse();
    this.shown = shown;
    body.innerHTML = `
      <section class="card hist-card" aria-labelledby="hist-spread-h">
        <div class="sec-head">
          <h2 class="sec-head__stamp" id="hist-spread-h">SPREAD PER RUN</h2>
          <span class="sec-head__aside">lower = tighter</span>
        </div>
        <div class="spread-plot" tabindex="0" role="slider" aria-labelledby="hist-spread-h"></div>
        <p class="hist-caption spread-caption"></p>
      </section>
      <section class="card hist-card" aria-labelledby="hist-heat-h">
        <div class="sec-head"><h2 class="sec-head__stamp" id="hist-heat-h">RUNS PER DAY · 10 WEEKS</h2></div>
        <div class="heat-grid"></div>
        <div class="heat-legend" aria-hidden="true">runs/day
          <span class="heat-key"><span class="sw"></span>0</span>
          <span class="heat-key"><span class="sw h1"></span>1</span>
          <span class="heat-key"><span class="sw h2"></span>2</span>
          <span class="heat-key"><span class="sw h3"></span>3+</span>
        </div>
        <p class="hist-caption heat-caption" role="status"></p>
      </section>
      <div class="log-list">${shown.map((r, i) => this.rowHtml(r, i)).join('')}</div>
      ${runs.length > PAGE ? `<button id="hist-more" type="button" class="btn btn--quiet hist-more">${this.showAll ? 'SHOW LESS' : `SEE ALL ${runs.length}`}</button>` : ''}`;

    this.setupSpread(body.querySelector('.spread-plot'), runs.slice(-SPREAD_RUNS));
    this.setupHeat(body.querySelector('.heat-grid'), runs);
    body.querySelectorAll('.log-row').forEach((row) => {
      row.addEventListener('click', () => this.openSheet(this.shown[+row.dataset.i], row));
    });
    const more = body.querySelector('#hist-more');
    if (more) {
      more.addEventListener('click', () => {
        this.showAll = !this.showAll;
        this.fill();
        const again = this.root.querySelector('#hist-more');
        if (again) again.focus();
      });
    }
  }

  rowHtml(r, i) {
    const d = validDate(r);
    const mon = d ? `${d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()} ${d.getDate()}` : '—';
    const wd = d ? d.toLocaleDateString('en-US', { weekday: 'short' }) : '';
    const n = num(r.n);
    // wrap only between items, with the separator kept on the line it ends
    const meta = [bpmText(r), meterText(r), n === null ? null : plural(n, 'hit', 'hits'), avgText(r.mean)]
      .filter(Boolean).map((t, k, all) => `<span class="nw">${esc(t)}${k < all.length - 1 ? ' ·' : ''}</span>`).join(' ');
    const tag = this.filter === 'all' ? `<span class="log-tag">${TAG[r.kind] || 'RUN'}</span>` : '';
    const acc = r.kind === 'rudiment' && num(r.accuracy) !== null
      ? ` <span class="log-badge log-badge--acc">${r.accuracy.toFixed(0)}% hit</span>` : '';
    return `
      <button type="button" class="list-row log-row" data-i="${i}" aria-haspopup="dialog">
        <span class="log-date"><b>${mon}</b><span>${wd}</span></span>
        <span class="log-main">
          <span class="log-title">${esc(typeof r.label === 'string' && r.label ? r.label : (TAG[r.kind] || 'RUN'))}</span>
          <span class="log-meta">${tag}${meta}${acc}</span>
        </span>
        <span class="log-val"><span class="log-badge">${spreadText(r.sd)}</span><span class="log-unit">ms spread</span></span>
      </button>`;
  }

  setupSpread(host, runs) {
    const baseline = store.get('baseline');
    const baseSd = this.filter !== 'rudiment' && baseline ? num(baseline.sd) : null;
    const caption = this.root.querySelector('.spread-caption');
    let sel = runs.length - 1;
    let width = 0;
    let geo = null;
    const draw = () => {
      width = host.clientWidth || 326;
      geo = spreadGeometry(runs, width, baseSd);
      host.innerHTML = spreadSvg(runs, geo, baseSd, sel);
    };
    const pick = (i) => {
      sel = Math.max(0, Math.min(runs.length - 1, i));
      const r = runs[sel], d = validDate(r);
      const text = `${d ? `${monthDay(d)} · ` : ''}${typeof r.label === 'string' && r.label ? `${r.label} · ` : ''}${spreadText(r.sd)}${NBSP}ms`;
      caption.textContent = text;
      host.setAttribute('aria-valuenow', String(sel + 1));
      host.setAttribute('aria-valuetext', text);
      if (geo) host.innerHTML = spreadSvg(runs, geo, baseSd, sel);
    };
    host.setAttribute('aria-valuemin', '1');
    host.setAttribute('aria-valuemax', String(runs.length));
    draw();
    pick(sel);
    host.addEventListener('click', (ev) => {
      const x = ev.clientX - host.getBoundingClientRect().left;
      let best = 0;
      runs.forEach((_, i) => { if (Math.abs(geo.x(i) - x) < Math.abs(geo.x(best) - x)) best = i; });
      pick(best);
    });
    host.addEventListener('keydown', (ev) => {
      const to = { ArrowLeft: sel - 1, ArrowDown: sel - 1, ArrowRight: sel + 1, ArrowUp: sel + 1, Home: 0, End: runs.length - 1 }[ev.key];
      if (to === undefined) return;
      ev.preventDefault();
      pick(to);
    });
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => {
        if (host.isConnected && host.clientWidth && Math.abs(host.clientWidth - width) > 1) draw();
      });
      this.ro.observe(host);
    }
  }

  setupHeat(grid, runs) {
    const cells = heatCells(runs);
    const level = (n) => (n >= 3 ? 'h3' : n === 2 ? 'h2' : n === 1 ? 'h1' : 'h0');
    grid.innerHTML = `
      <div class="heat-months" aria-hidden="true">${monthLabels(cells)}</div>
      <div class="heat-days" aria-hidden="true"><span>M</span><span></span><span>W</span><span></span><span>F</span><span></span><span>S</span></div>
      <div class="heatmap" role="group" tabindex="0" aria-label="Runs per day, last 10 weeks">${cells.map((c) => (c.future
    ? '<i class="is-future" aria-hidden="true"></i>'
    : `<i class="${level(c.n)}${c.today ? ' is-today' : ''}" role="img" aria-label="${heatLabel(c)}"></i>`)).join('')}</div>`;
    const map = grid.querySelector('.heatmap');
    const caption = this.root.querySelector('.heat-caption');
    const today = cells.findIndex((c) => c.today);
    let sel = today;
    const pick = (i, mark) => {
      if (i < 0 || i >= cells.length || cells[i].future) return;
      sel = i;
      caption.textContent = heatLabel(cells[i]);
      if (!mark) return;
      map.querySelectorAll('i.is-sel').forEach((el) => el.classList.remove('is-sel'));
      map.children[i].classList.add('is-sel');
    };
    pick(today, false);
    map.addEventListener('click', (ev) => {
      const first = map.children[0].getBoundingClientRect();
      const box = map.getBoundingClientRect();
      const pitchX = first.width + 3, pitchY = first.height + 3;
      const col = Math.max(0, Math.min(9, Math.floor((ev.clientX - box.left + 1.5) / pitchX)));
      const row = Math.max(0, Math.min(6, Math.floor((ev.clientY - box.top + 1.5) / pitchY)));
      pick(col * 7 + row, true);
    });
    map.addEventListener('keydown', (ev) => {
      const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[ev.key];
      let to;
      if (step !== undefined) to = sel + step;
      else if (ev.key === 'Home') to = 0;
      else if (ev.key === 'End') to = today;
      else return;
      ev.preventDefault();
      pick(Math.min(today, Math.max(0, to)), true);
    });
  }

  // ------------------------------------------------------------ run sheet
  openSheet(r, opener) {
    if (!r) return;
    this.closeSheet(false);
    const d = validDate(r);
    const when = d ? `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : '';
    const n = num(r.n);
    const tile = (v, label, sub = '') => `<div class="statbox${v === null ? ' is-empty' : ''}"><b>${v === null ? '—' : v}</b><span>${label}</span>${sub ? `<em>${sub}</em>` : ''}</div>`;
    const pct = (v) => (num(v) === null ? null : `${Math.round(v)}<i class="unit">%</i>`);
    const count = (v) => (num(v) === null ? null : String(v));
    let tiles;
    if (r.kind === 'timing') {
      tiles = tile(count(r.n), 'HITS') + tile(pct(r.pocketPct), 'IN POCKET') + tile(count(r.unaligned), 'EXTRA HITS');
    } else {
      const acc = num(r.accuracy) === null ? '' : `${r.accuracy.toFixed(0)}% hit`;
      tiles = tile(count(r.n), 'HITS', acc) + tile(count(r.missed), 'MISSED') + tile(count(r.strays), 'EXTRA HITS');
    }
    const setup = [bpmText(r), meterText(r)].filter(Boolean).map(esc).join(' · ');
    const accents = r.kind === 'rudiment' && num(r.accentDb) !== null
      ? `<p class="hist-accents"><b>ACCENTS</b> ${nbsp(fmtSigned(r.accentDb, 1), 'dB')} over taps</p>` : '';
    const label = typeof r.label === 'string' && r.label ? r.label : (TAG[r.kind] || 'RUN');

    const scrim = document.createElement('div');
    scrim.className = 'scrim hist-scrim';
    const sheet = document.createElement('div');
    sheet.className = 'sheet hist-sheet';
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'hist-sheet-title');
    sheet.innerHTML = `
      <div class="sheet__hazard" aria-hidden="true"></div>
      <div class="hist-sheet__head">
        <h2 id="hist-sheet-title">${esc(label)}</h2>
        <button type="button" class="sheet__close" aria-label="Close">${icon('close')}</button>
      </div>
      <div class="hist-sheet__body">
        <p class="hist-sheet__when">${TAG[r.kind] || 'RUN'}${when ? ` · ${esc(when)}` : ''}</p>
        ${setup ? `<div class="summary">${setup}</div>` : ''}
        <div class="hero">
          <p class="hero__cap">SPREAD${n === null ? '' : ` · ${n} HITS`}</p>
          <b aria-label="plus or minus ${Math.abs(r.sd).toFixed(1)}">${spreadText(r.sd)}</b><span class="unit">ms</span>
          <p class="hero__def">How tightly the hits group.</p>
          <p class="hero__avg">${esc(avgText(r.mean, true))}</p>
        </div>
        <div class="stat-strip">${tiles}</div>
        ${accents}
      </div>`;
    this.root.append(scrim, sheet);

    const behind = [document.querySelector('header.chrome'), this.root.querySelector('.screen')]
      .filter((el) => el && !el.inert);
    behind.forEach((el) => { el.inert = true; });
    const close = sheet.querySelector('.sheet__close');
    this.sheet = { scrim, sheet, behind, opener };
    close.addEventListener('click', () => this.closeSheet(true));
    scrim.addEventListener('click', () => this.closeSheet(true));
    sheet.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); this.closeSheet(true); }
      if (ev.key === 'Tab') { ev.preventDefault(); close.focus(); }
    });
    close.focus();
  }

  closeSheet(restoreFocus) {
    const s = this.sheet;
    if (!s) return;
    this.sheet = null;
    s.scrim.remove();
    s.sheet.remove();
    s.behind.forEach((el) => { el.inert = false; });
    if (restoreFocus && s.opener && s.opener.isConnected) s.opener.focus();
  }

  exportCsv() {
    const runs = this.runs();
    const cols = ['date', 'kind', 'label', 'meter', 'bpmStart', 'bpmEnd', 'n', 'mean', 'sd', 'accuracy', 'missed', 'strays', 'pocketPct', 'unaligned', 'accentDb'];
    const csv = [cols.join(',')].concat(
      runs.map((r) => cols.map((c) => {
        const v = r[c];
        if (v === undefined || v === null) return '';
        let s = String(v);
        // string cells starting with =/+/-/@ would execute as formulas in
        // Excel/Sheets; a leading apostrophe forces them to plain text
        if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = `'${s}`;
        return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
      }).join(',')),
    ).join('\n');
    const a = document.createElement('a');
    // BOM so Excel decodes UTF-8 — every timing label carries a '÷'
    a.href = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'rhythm-checker-history.csv';
    a.click();
  }
}
