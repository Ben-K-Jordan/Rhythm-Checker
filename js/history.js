// History: every finished run, by spread and by day. The filter drives the
// stat tiles, both charts and the list; a row opens a read-only run sheet.

import { store } from './store.js';
import { icon, seg, fmtSigned, nbsp, esc, streakDays } from './ui.js';

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

function validDate(r) {
  const d = new Date(r.date);
  return Number.isNaN(d.getTime()) ? null : d;
}

const monthDay = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const time = (r) => { const d = validDate(r); return d ? d.getTime() : 0; };
const plural = (n, one, many) => `${n}${NBSP}${n === 1 ? one : many}`;
const spreadText = (sd) => `±${Math.abs(sd).toFixed(1)}`;
// "(R-lead)" never breaks after its hyphen: a word joiner (U+2060), not
// U+2011, which none of the bundled fonts carries
const keepLead = (label) => label.replace(/\b([RL])-(lead)\b/g, '$1-\u2060$2');

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

// One series per run kind. A line only ever joins runs of the same kind, and
// a kind keeps its mark on every filter: rudiments circles, timing squares.
// A single series is drawn in ink; with both kinds on the chart (sp--multi)
// timing is an ink60 dashed line, so the kinds differ by mark and dash, not
// by hue. A kind this build does not know (hand-edited backup) gets hollow
// rings with no line, since nothing says those runs belong together.
const SERIES = {
  rudiment: { name: 'RUDIMENTS', word: 'Rudiments', cls: 'sp-s--rud', shape: 'circle', line: true },
  timing: { name: 'TIMING', word: 'Timing', cls: 'sp-s--tim', shape: 'square', line: true },
  other: { name: 'OTHER', word: 'Other runs', cls: 'sp-s--other', shape: 'circle', line: false },
};
const seriesOf = (r) => (r.kind === 'rudiment' || r.kind === 'timing' ? r.kind : 'other');

// run indexes per series, series in their fixed order (legend, description)
function seriesGroups(runs) {
  const groups = new Map(Object.keys(SERIES).map((k) => [k, []]));
  runs.forEach((r, i) => groups.get(seriesOf(r)).push(i));
  for (const [k, idx] of groups) if (!idx.length) groups.delete(k);
  return groups;
}

function markSvg(kind, [x, y], clamped, big) {
  const cls = `sp-dot ${SERIES[kind].cls}`;
  // clamped: an arrowhead pinned to the top edge
  if (clamped) return `<path class="${cls}" d="M${(x - 5).toFixed(1)} ${(y + 4).toFixed(1)}h10l-5 -8z"/>`;
  const r = big ? 5.5 : 4;
  if (SERIES[kind].shape === 'square') {
    return `<rect class="${cls}" x="${(x - r).toFixed(1)}" y="${(y - r).toFixed(1)}" width="${2 * r}" height="${2 * r}"/>`;
  }
  return `<circle class="${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"/>`;
}

// legend key: a short stroke of the series line with its mark on it
function keySvg(kind) {
  const s = SERIES[kind];
  const line = s.line ? `<line class="sp-line ${s.cls}" x1="1" x2="23" y1="7" y2="7"/>` : '';
  return `<svg class="sp-key" width="24" height="14" viewBox="0 0 24 14" aria-hidden="true" focusable="false">${line}${markSvg(kind, [12, 7], false, false)}</svg>`;
}

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
// and clear of every line in `paths`, their dots and the boxes in `avoid`.
// ok is false when no candidate is clear; the fallback is then the first one
// that at least stays inside the plot and off the other labels (the text's
// white halo keeps it legible over a line), else the first candidate.
function placeLabel(cands, width, height, paths, avoid, bounds) {
  const boxOf = ([ax, ay, anchor]) => {
    const x0 = anchor === 'end' ? ax - width : ax;
    return [x0, ay - height, x0 + width, ay + 3];
  };
  const inside = (box) => box[0] >= bounds[0] && box[2] <= bounds[2] && box[1] >= bounds[1] && box[3] <= bounds[3];
  let fallback = null;
  for (const c of cands) {
    const box = boxOf(c);
    if (!inside(box) || avoid.some((b) => overlaps(b, box))) continue;
    const pad = [box[0] - 4, box[1] - 4, box[2] + 4, box[3] + 4];
    if (paths.some((pts) => boxHitsLine(pad, pts))) {
      if (!fallback) fallback = { c, box, ok: false };
      continue;
    }
    return { c, box, ok: true };
  }
  return fallback || { c: cands[0], box: boxOf(cands[0]), ok: false };
}

// baseSd: the timing baseline, drawn only when the chart shows timing alone.
// endLabel: false on ALL, where the legend row carries the latest values.
function spreadSvg(runs, g, baseSd, sel, endLabel) {
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
  const groups = seriesGroups(runs);
  // what a label must stay clear of: each series' own line, or lone dots
  const paths = [];
  for (const [k, idx] of groups) {
    const line = idx.map((i) => pts[i]);
    if (!SERIES[k].line) { line.forEach((p) => paths.push([p])); continue; }
    paths.push(line);
    if (line.length > 1) {
      parts.push(`<polyline class="sp-line ${SERIES[k].cls}" points="${line.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}"/>`);
    }
  }
  // marks after every line, so another kind's line never crosses over a mark
  for (const [k, idx] of groups) {
    idx.forEach((i, j) => parts.push(markSvg(k, pts[i], runs[i].sd > top, j === idx.length - 1)));
  }
  if (sel !== null && pts[sel]) {
    parts.push(`<circle class="sp-sel" cx="${pts[sel][0].toFixed(1)}" cy="${pts[sel][1].toFixed(1)}" r="8.5"/>`);
  }
  // endLabel (one kind on the chart): its latest value, above-left of the
  // last mark unless the line is there. With two kinds no number goes in the
  // plot: their end marks sit side by side at the right edge, and a value
  // between them reads as either kind's. The legend row names each kind's
  // latest value instead.
  const placed = [];
  const labels = [];
  const only = endLabel && groups.size === 1 ? [...groups][0] : null;
  if (only && SERIES[only[0]].line) {
    const i = only[1][only[1].length - 1];
    const [lx, ly] = pts[i];
    const label = `${spreadText(runs[i].sd)}${NBSP}ms`;
    const p = placeLabel([
      [lx - 10, ly - 10, 'end'], [lx - 10, ly + 20, 'end'], [lx - 14, ly + 5, 'end'],
      [lx - 10, ly - 24, 'end'], [lx - 10, ly + 34, 'end'],
      [lx + 12, ly - 10, 'start'], [lx + 12, ly + 20, 'start'],
    ], label.length * 7.9, 11, paths, placed, bounds);
    placed.push(p.box);
    labels.push(`<text class="sp-last" x="${p.c[0].toFixed(1)}" y="${p.c[1].toFixed(1)}" text-anchor="${p.c[2]}">${label}</text>`);
  }
  if (yb !== null) {
    const text = `baseline ${spreadText(baseSd)}`;
    const mid = SP.l + g.pw / 2;
    const tw = text.length * 6.6;
    const base = placeLabel([
      [SP.l + 4, yb - 5, 'start'], [SP.l + 4, yb + 14, 'start'], [mid, yb - 5, 'middle'], [mid, yb + 14, 'middle'],
      [right - 4, yb - 5, 'end'], [right - 4, yb + 14, 'end'],
      [SP.l + 4, yb - 19, 'start'], [SP.l + 4, yb + 28, 'start'], [right - 4, yb - 19, 'end'], [right - 4, yb + 28, 'end'],
    ].map(([x, y, a]) => (a === 'middle' ? [x - tw / 2, y, 'start'] : [x, y, a])),
    tw, 9, paths, placed, bounds);
    if (base.ok) {
      parts.push(`<text class="sp-base-label" x="${base.c[0].toFixed(1)}" y="${base.c[1].toFixed(1)}" text-anchor="${base.c[2]}">${text}</text>`);
    } else {
      // every slot by the hairline crosses the data: key it in the date row
      // instead (between the first and last date), never over the marks
      const kx = mid - (tw + 18) / 2, ky = SP.h - 5;
      parts.push(`<line class="sp-base" x1="${kx.toFixed(1)}" x2="${(kx + 14).toFixed(1)}" y1="${(ky - 4).toFixed(1)}" y2="${(ky - 4).toFixed(1)}"/>`);
      parts.push(`<text class="sp-base-label" x="${(kx + 18).toFixed(1)}" y="${ky}">${text}</text>`);
    }
  }
  parts.push(...labels);
  const first = validDate(runs[0]), lastD = validDate(runs[runs.length - 1]);
  const a = first ? monthDay(first) : '', b = lastD ? monthDay(lastD) : '';
  if (runs.length > 1 && a && a !== b) parts.push(`<text class="sp-tick" x="${SP.l}" y="${SP.h - 5}">${a}</text>`);
  if (b) parts.push(`<text class="sp-tick" x="${runs.length > 1 ? right : g.x(0)}" y="${SP.h - 5}" text-anchor="${runs.length > 1 ? 'end' : 'middle'}">${b}</text>`);
  return `<svg class="sp${groups.size > 1 ? ' sp--multi' : ''}" width="${w}" height="${SP.h}" viewBox="0 0 ${w} ${SP.h}" aria-hidden="true" focusable="false">${parts.join('')}</svg>`;
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

// a run's identity across an import (stored runs carry no id)
const runKey = (r) => JSON.stringify([r.date, r.kind, r.label, r.sd, r.mean, r.n]);

// a selector for the same control after a re-render
function focusSelector(el) {
  if (el.id) return `#${el.id}`;
  if (el.dataset.f) return `.hist-filter [data-f="${el.dataset.f}"]`;
  if (el.dataset.to) return `[data-to="${el.dataset.to}"]`;
  if (el.classList.contains('log-row')) return `.log-row[data-i="${el.dataset.i}"]`;
  for (const c of ['spread-plot', 'heatmap']) if (el.classList.contains(c)) return `.${c}`;
  return null;
}

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

  // The shell calls this after RESET ALL, an import or closing Settings: the
  // store may have changed under the screen. Redraw from it with the same
  // filter (and SEE ALL state). An open run sheet stays open, rebuilt from the
  // stored run, only while that run still exists; otherwise it closes.
  refresh() {
    const open = this.sheet;
    const active = document.activeElement;
    const had = !!active && active !== document.body && this.root.contains(active);
    const inSheet = had && !!open && open.sheet.contains(active);
    const sel = had && !inSheet ? focusSelector(active) : null;
    const run = open ? this.findRun(open.run) : null;
    this.render();
    if (run) {
      const i = Array.isArray(this.shown) ? this.shown.indexOf(run) : -1;
      this.openSheet(run, i < 0 ? null : this.root.querySelector(`.log-row[data-i="${i}"]`), { focus: inSheet });
    }
    if (had && (!document.activeElement || document.activeElement === document.body)) this.refocus(sel);
  }

  // the stored run a sheet was opened on: the same object, or after an import
  // replaced every object, the run with the same date, kind, label and numbers
  findRun(r) {
    if (!r) return null;
    const all = store.get('runs') || [];
    if (all.includes(r)) return r;
    const key = runKey(r);
    return all.find((x) => x && runKey(x) === key) || null;
  }

  // focus a control on this screen after the one that had it went away
  refocus(sel) {
    const ok = (el) => el && el.isConnected && !el.disabled && !el.closest('[inert]') && el.getClientRects().length;
    const el = [sel && this.root.querySelector(sel), this.root.querySelector('.hist-filter button.on')].find(ok);
    if (el) el.focus({ preventScroll: true });
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
      + tile(streakDays(runs), streakDays(runs) === 1 ? 'DAY IN A ROW' : 'DAYS IN A ROW') + tile(week, 'LAST 7 DAYS');

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
        <div class="sp-legend" aria-hidden="true" hidden></div>
        <div class="spread-plot" tabindex="0" role="slider" aria-labelledby="hist-spread-h" aria-describedby="hist-spread-desc"></div>
        <p class="sr-only" id="hist-spread-desc"></p>
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

    this.setupSpread(body.querySelector('.spread-plot'), runs.slice(-SPREAD_RUNS), runs.length);
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
          <span class="log-title">${esc(keepLead(typeof r.label === 'string' && r.label ? r.label : (TAG[r.kind] || 'RUN')))}</span>
          <span class="log-meta">${tag}${meta}${acc}</span>
        </span>
        <span class="log-val"><span class="log-badge">${spreadText(r.sd)}</span><span class="log-unit">ms spread</span></span>
      </button>`;
  }

  setupSpread(host, runs, total) {
    // the baseline is a timing number: it is drawn only when the chart shows
    // timing runs alone, never under rudiments or a mix of both
    const baseline = store.get('baseline');
    const baseSd = this.filter === 'timing' && baseline ? num(baseline.sd) : null;
    const mixed = this.filter === 'all';
    const groups = seriesGroups(runs);
    const caption = this.root.querySelector('.spread-caption');

    // ALL: one legend row per kind (its mark and line, its name, its latest
    // value, all ink text), since two end marks share the plot's right edge.
    // A single-kind filter already says which kind is plotted.
    const ms = (sd) => `${spreadText(sd)}${NBSP}ms`;
    const legend = this.root.querySelector('.sp-legend');
    legend.hidden = !mixed;
    legend.classList.toggle('sp--multi', groups.size > 1);
    legend.innerHTML = mixed
      ? [...groups].map(([k, idx]) => `<span class="sp-legend__key">${keySvg(k)}<span class="sp-legend__name">${SERIES[k].name}</span><span class="sp-legend__val">last <b>${ms(runs[idx[idx.length - 1]].sd)}</b></span></span>`).join('')
      : '';

    // text alternative for the picture: what is plotted, per series
    const seriesText = (k, idx, named) => {
      const sds = idx.map((i) => runs[i].sd);
      const lo = Math.min(...sds), hi = Math.max(...sds);
      const range = idx.length > 1 ? `, ${ms(lo)} to ${ms(hi)}` : '';
      return `${named ? `${SERIES[k].word}: ` : ''}${plural(idx.length, 'run', 'runs')}${range}, latest ${ms(runs[idx[idx.length - 1]].sd)}.`;
    };
    const order = runs.length > 1 ? ', oldest to newest' : '';
    const scope = total > runs.length ? `Latest ${runs.length} of ${total} runs` : plural(runs.length, 'run', 'runs');
    const desc = mixed
      ? [`${scope}${order}, lower is tighter.${groups.size > 1 ? ' Each kind is plotted on its own.' : ''}`,
        ...[...groups].map(([k, idx]) => seriesText(k, idx, true))]
      : [`${SERIES[this.filter] ? SERIES[this.filter].word : 'Runs'}${order}, lower is tighter.`,
        ...[...groups].map(([k, idx]) => seriesText(k, idx, false)),
        ...(baseSd === null ? [] : [`Timing baseline ${ms(baseSd)}.`])];
    this.root.querySelector('#hist-spread-desc').textContent = desc.join(' ');

    let sel = runs.length - 1;
    let width = 0;
    let geo = null;
    const draw = () => {
      width = host.clientWidth || 326;
      geo = spreadGeometry(runs, width, baseSd);
      host.innerHTML = spreadSvg(runs, geo, baseSd, sel, !mixed);
    };
    const pick = (i) => {
      sel = Math.max(0, Math.min(runs.length - 1, i));
      const r = runs[sel], d = validDate(r);
      const text = [
        d ? monthDay(d) : null,
        mixed ? SERIES[seriesOf(r)].name : null,
        typeof r.label === 'string' && r.label ? keepLead(r.label) : null,
        ms(r.sd),
      ].filter(Boolean).join(' · ');
      caption.textContent = text;
      host.setAttribute('aria-valuenow', String(sel + 1));
      host.setAttribute('aria-valuetext', text);
      if (geo) host.innerHTML = spreadSvg(runs, geo, baseSd, sel, !mixed);
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
  // focus: false when re-opened by refresh() while focus is elsewhere (the
  // Settings sheet), which must keep it
  openSheet(r, opener, { focus = true } = {}) {
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
        <h2 id="hist-sheet-title">${esc(keepLead(label))}</h2>
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
    this.sheet = { scrim, sheet, behind, opener, run: r };
    close.addEventListener('click', () => this.closeSheet(true));
    scrim.addEventListener('click', () => this.closeSheet(true));
    sheet.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); this.closeSheet(true); }
      if (ev.key === 'Tab') { ev.preventDefault(); close.focus(); }
    });
    if (focus) close.focus();
  }

  closeSheet(restoreFocus) {
    const s = this.sheet;
    if (!s) return;
    this.sheet = null;
    s.scrim.remove();
    s.sheet.remove();
    // clear exactly what openSheet set, even under an inert #app (the mic-lost
    // overlay): nothing else would ever clear the header's flag. Elements that
    // were already inert when the sheet opened are not in `behind`.
    s.behind.forEach((el) => { el.inert = false; });
    if (!restoreFocus) return;
    // the row it opened from can be gone (refresh re-rendered the list)
    if (s.opener && s.opener.isConnected) s.opener.focus();
    else this.refocus(null);
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
