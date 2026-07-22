// History: the session log. A 10-week practice heatmap, filter chips, and
// every run with its honest badge. Weeks don't lie.

import { store } from './store.js';

const PAGE = 6;

function esc(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function dayKey(offsetDays) {
  return new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);
}

function streakDays(runs) {
  const days = new Set(runs.map((r) => (r.date || '').slice(0, 10)));
  if (!days.size) return 0;
  let start = days.has(dayKey(0)) ? 0 : days.has(dayKey(1)) ? 1 : -1;
  if (start < 0) return 0;
  let n = 0;
  while (days.has(dayKey(start + n))) n++;
  return n;
}

const TAG = {
  show: ['SHOW', 'red'],
  rudiment: ['RUDIMENTS', 'ink'],
  timing: ['TIMING', 'blue'],
  tuner: ['TUNER', 'green'],
};

export class HistoryMode {
  constructor(root) {
    this.root = root;
    this.filter = 'all';
    this.showAll = false;
    this.render();
  }

  activate() { this.render(); }

  runs() {
    const all = store.get('runs') || [];
    if (this.filter === 'all') return all;
    if (this.filter === 'practice') return all.filter((r) => r.kind !== 'show');
    return all.filter((r) => r.kind === this.filter);
  }

  badge(r) {
    if (r.kind === 'show') {
      return r.result === 'DIALED'
        ? '<span class="log-badge solid green">DIALED</span>'
        : `<span class="log-badge solid red">${r.result || 'SHOW'}</span>`;
    }
    if (r.kind === 'rudiment' && r.accuracy != null) return `<span class="log-badge">${r.accuracy.toFixed(0)}%</span>`;
    if (r.kind === 'timing') return `<span class="log-badge">${r.mean >= 0 ? '+' : ''}${r.mean.toFixed(0)} MS</span>`;
    return '<span class="log-badge">&mdash;</span>';
  }

  render() {
    const all = store.get('runs') || [];
    const runs = this.runs();
    const week = all.filter((r) => (Date.now() - new Date(r.date).getTime()) < 7 * 86400000).length;

    // 10-week heatmap: columns = weeks (oldest left), rows = Mon..Sun
    const counts = new Map();
    for (const r of all) {
      const k = (r.date || '').slice(0, 10);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const today = new Date();
    const dow = (today.getDay() + 6) % 7; // Mon=0
    const cells = [];
    for (let wk = 9; wk >= 0; wk--) {
      for (let d = 0; d < 7; d++) {
        const offset = wk * 7 + (dow - d);
        const key = offset >= 0 ? dayKey(offset) : null;
        const c = key ? counts.get(key) || 0 : -1;
        const cls = c < 0 ? 'future' : c === 0 ? '' : c === 1 ? 'l1' : c === 2 ? 'l2' : 'l3';
        cells.push(`<i class="${cls}" ${key ? `title="${key}: ${Math.max(0, c)}"` : ''}></i>`);
      }
    }

    const shown = this.showAll ? runs.slice().reverse() : runs.slice(-PAGE).reverse();
    this.root.innerHTML = `
      <div class="title-stamp" style="font-size:46px">HISTORY</div>

      <div class="stat-strip">
        <div class="statbox ink"><b>${all.length}</b><span>Sessions</span></div>
        <div class="statbox red"><b>${streakDays(all)}</b><span>Day streak</span></div>
        <div class="statbox"><b>${week}</b><span>This week</span></div>
      </div>

      <div class="heat-card">
        <div class="heat-head"><span class="chip-stamp">10 weeks</span>
          <span class="heat-legend">LESS <i></i><i class="l1"></i><i class="l2"></i><i class="l3"></i> MORE</span></div>
        <div class="heatmap">${cells.join('')}</div>
      </div>

      <div class="log-filters">
        ${[['all', 'All'], ['practice', 'Practice'], ['show', 'Show'], ['rudiment', 'Rudiments'], ['timing', 'Timing']].map(([id, label]) => `
          <button class="pill ${this.filter === id ? 'on' : ''}" data-f="${id}">${label}</button>`).join('')}
        <span style="flex:1"></span>
        <button id="hist-csv" class="pill" title="export CSV" ${runs.length ? '' : 'disabled'}>CSV &#8595;</button>
      </div>

      <div class="log-list">
        ${shown.length ? shown.map((r) => {
    const [tag, tone] = TAG[r.kind] || ['RUN', 'ink'];
    const d = new Date(r.date);
    const mon = d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
    const wd = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
    return `
          <div class="log-row">
            <span class="log-date"><b>${mon} ${d.getDate()}</b><i>${wd}</i></span>
            <span class="log-tag ${tone}">${tag}</span>
            <span class="log-title">${esc(r.label || '')}</span>
            ${this.badge(r)}
          </div>`;
  }).join('') : `<div class="log-empty">No sessions yet. Every completed run lands here automatically —
        come back after a few and watch the spread fall.</div>`}
      </div>
      ${runs.length > PAGE ? `
        <button id="hist-more" class="log-more">SHOWING ${shown.length} OF ${runs.length} &mdash; ${this.showAll ? 'SHOW LESS &#9652;' : 'SEE ALL &#9662;'}</button>` : ''}`;

    this.root.querySelectorAll('[data-f]').forEach((b) => {
      b.addEventListener('click', () => { this.filter = b.dataset.f; this.showAll = false; this.render(); });
    });
    const more = this.root.querySelector('#hist-more');
    if (more) more.addEventListener('click', () => { this.showAll = !this.showAll; this.render(); });
    const csvBtn = this.root.querySelector('#hist-csv');
    if (csvBtn) csvBtn.addEventListener('click', () => this.exportCsv());
  }

  exportCsv() {
    const runs = this.runs();
    const cols = ['date', 'kind', 'label', 'meter', 'bpmStart', 'bpmEnd', 'n', 'mean', 'sd', 'accuracy', 'missed', 'strays', 'pocketPct', 'result', 'heldPct', 'accentDb'];
    const csv = [cols.join(',')].concat(
      runs.map((r) => cols.map((c) => {
        const v = r[c];
        if (v === undefined || v === null) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
      }).join(',')),
    ).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'rhythm-checker-history.csv';
    a.click();
  }
}
