// History: every completed run, saved automatically, shown honestly.
// The spread (SD) trend across sessions is the number that tells you whether
// the practice is working — no medals, just the graph moving.

import { store } from './store.js';
import { theme } from './theme.js';

export class HistoryMode {
  constructor(root) {
    this.root = root;
    this.filter = 'all';
    this.render();
  }

  activate() {
    this.render(); // runs may have been added since last view
  }

  runs() {
    const all = store.get('runs') || [];
    if (this.filter === 'all') return all;
    return all.filter((r) => r.kind === this.filter);
  }

  render() {
    const runs = this.runs();
    this.root.innerHTML = `
      <div class="mode-head">
        <div class="seg">
          <button data-f="all" class="${this.filter === 'all' ? 'on' : ''}">All</button>
          <button data-f="rudiment" class="${this.filter === 'rudiment' ? 'on' : ''}">Rudiments</button>
          <button data-f="timing" class="${this.filter === 'timing' ? 'on' : ''}">Timing</button>
        </div>
        <button id="hist-csv" ${runs.length ? '' : 'disabled'}>Export CSV</button>
      </div>
      ${runs.length ? `
        <canvas id="hist-trend" width="900" height="160"></canvas>
        <p class="dim">spread (SD, ms) per session — lower and flatter is tighter. Last ${Math.min(runs.length, 40)} shown.</p>
        <div class="hist-table">
          <div class="hist-row hist-head">
            <span>date</span><span>what</span><span>meter</span><span>tempo</span>
            <span>hits</span><span>mean</span><span>SD</span><span>quality</span>
          </div>
          ${runs.slice(-60).reverse().map((r) => `
            <div class="hist-row">
              <span>${r.date.slice(5, 10)} ${r.date.slice(11, 16)}</span>
              <span>${(r.label || '').replace(/</g, '&lt;')}</span>
              <span>${r.meter || '4/4'}</span>
              <span>${r.bpmStart}${r.bpmEnd !== r.bpmStart ? '→' + r.bpmEnd : ''}</span>
              <span>${r.n}</span>
              <span>${r.mean >= 0 ? '+' : ''}${r.mean.toFixed(1)}</span>
              <span>${r.sd.toFixed(1)}</span>
              <span>${r.kind === 'rudiment'
                ? `${r.accuracy != null ? r.accuracy.toFixed(0) + '%' : '—'}${r.missed ? ` · ${r.missed} miss` : ''}`
                : `${r.pocketPct != null ? r.pocketPct.toFixed(0) + '% pocket' : '—'}`}</span>
            </div>`).join('')}
        </div>`
      : `<div class="explain"><p>No sessions yet. Every completed rudiment run and
         timing check lands here automatically — come back after a few and watch
         the spread column. That number falling over weeks is the whole point.</p></div>`}`;

    this.root.querySelectorAll('.seg button').forEach((b) => {
      b.addEventListener('click', () => { this.filter = b.dataset.f; this.render(); });
    });
    const csvBtn = this.root.querySelector('#hist-csv');
    if (csvBtn) csvBtn.addEventListener('click', () => this.exportCsv());
    if (runs.some((r) => r.kind !== 'show')) this.drawTrend(runs);
  }

  drawTrend(runs) {
    const cv = this.root.querySelector('#hist-trend');
    const ctx = cv.getContext('2d');
    const w = cv.width;
    const h = cv.height;
    ctx.clearRect(0, 0, w, h);
    const recent = runs.filter((r) => r.kind !== 'show').slice(-40);
    const maxSd = Math.max(12, ...recent.map((r) => r.sd));
    const x = (i) => 30 + (i / Math.max(1, recent.length - 1)) * (w - 60);
    const y = (sd) => h - 20 - (sd / maxSd) * (h - 40);
    // 10 ms reference line
    const T = theme();
    ctx.strokeStyle = T.line;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(30, y(10));
    ctx.lineTo(w - 30, y(10));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = T.dim;
    ctx.font = '11px ' + T.mono;
    ctx.fillText('10 ms', 2, y(10) + 4);
    ctx.strokeStyle = T.pink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    recent.forEach((r, i) => {
      if (i === 0) ctx.moveTo(x(i), y(r.sd));
      else ctx.lineTo(x(i), y(r.sd));
    });
    ctx.stroke();
    ctx.fillStyle = T.pink;
    recent.forEach((r, i) => {
      ctx.beginPath();
      ctx.arc(x(i), y(r.sd), 3, 0, 7);
      ctx.fill();
    });
  }

  exportCsv() {
    const runs = this.runs();
    const cols = ['date', 'kind', 'label', 'meter', 'bpmStart', 'bpmEnd', 'n', 'mean', 'sd', 'accuracy', 'missed', 'strays', 'pocketPct', 'unaligned'];
    const csv = [cols.join(',')].concat(
      runs.map((r) => cols.map((c) => {
        const v = r[c];
        if (v === undefined || v === null) return '';
        return typeof v === 'string' ? `"${v.replaceAll('"', '""')}"` : String(v);
      }).join(',')),
    ).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'rhythm-checker-history.csv';
    a.click();
  }
}
