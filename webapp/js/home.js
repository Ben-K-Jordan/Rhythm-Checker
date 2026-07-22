// Home: the practice hub. PRACTICE/SHOW arm toggle, feel presets, poster
// tiles into every module, and an honest session strip — real numbers only.

import { store } from './store.js';
import { FEELS, applyFeel } from './feel.js';

function escText(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// consecutive practice days ending today or yesterday
function streakDays(runs) {
  const days = new Set(runs.map((r) => (r.date || '').slice(0, 10)));
  if (!days.size) return 0;
  const day = (offset) => {
    const d = new Date(Date.now() - offset * 86400000);
    return d.toISOString().slice(0, 10);
  };
  let start = 0;
  if (!days.has(day(0))) {
    if (!days.has(day(1))) return 0;
    start = 1;
  }
  let n = 0;
  while (days.has(day(start + n))) n++;
  return n;
}

const ICON = {
  tuner: `<svg width="30" height="30" viewBox="0 0 40 40" fill="none" stroke="#141210" stroke-width="2.4" stroke-linecap="round"><path d="M6 30a14 14 0 0 1 28 0"/><line x1="20" y1="30" x2="28" y2="16"/><circle cx="20" cy="30" r="2.6" fill="#141210"/></svg>`,
  timing: `<svg width="30" height="30" viewBox="0 0 40 40" fill="none" stroke="#141210" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"><path d="M15 6h10l5 28H10z"/><line x1="20" y1="30" x2="25" y2="12"/><line x1="10" y1="26" x2="30" y2="26"/></svg>`,
  calibrate: `<svg width="30" height="30" viewBox="0 0 40 40" fill="none" stroke="#141210" stroke-width="2.4" stroke-linecap="round"><circle cx="20" cy="20" r="13"/><line x1="20" y1="2" x2="20" y2="9"/><line x1="20" y1="31" x2="20" y2="38"/><line x1="2" y1="20" x2="9" y2="20"/><line x1="31" y1="20" x2="38" y2="20"/><circle cx="20" cy="20" r="2.6" fill="#141210"/></svg>`,
  history: `<svg width="30" height="30" viewBox="0 0 40 40" fill="none" stroke="#141210" stroke-width="2.4" stroke-linecap="round"><line x1="8" y1="34" x2="8" y2="22"/><line x1="16" y1="34" x2="16" y2="14"/><line x1="24" y1="34" x2="24" y2="20"/><line x1="32" y1="34" x2="32" y2="8"/></svg>`,
  drum: `<svg width="34" height="34" viewBox="0 0 40 40" fill="none" stroke="#f2ecdd" stroke-width="2.4"><circle cx="20" cy="20" r="16"/><circle cx="20" cy="20" r="7"/><line x1="26" y1="6" x2="33" y2="15" stroke-width="3" stroke-linecap="round"/></svg>`,
};

export class HomeMode {
  constructor(root, nav) {
    this.root = root;
    this.nav = nav;
    this.render();
  }

  activate() { this.render(); }

  render() {
    const runs = store.get('runs') || [];
    const feel = store.get('feel');
    const last = runs[runs.length - 1];
    const streak = streakDays(runs);
    this.root.innerHTML = `
      <div class="home-title">RHYTHM<br><span>CHECKER</span></div>

      <div class="arm-toggle">
        <button class="arm-seg on"><span class="led"></span>PRACTICE</button>
        <button class="arm-seg" id="home-show">SHOW &#9654;</button>
      </div>

      <div class="feel-wrap">
        <div class="feel-label"><span class="chip-stamp">Feel presets</span></div>
        <div class="feel-grid">
          ${Object.entries(FEELS).map(([id, f]) => `
            <button class="feel-card ${feel === id ? 'on' : ''}" data-feel="${id}">
              <div class="feel-name">${f.label}</div>
              <div class="feel-genre">${f.genre}</div>
              <div class="feel-bpm">${f.bpm}</div>
            </button>`).join('')}
        </div>
      </div>

      <div class="modules">
        <span class="chip-stamp">Modules</span>
        <button class="hero-tile" data-nav="rudiments">
          ${ICON.drum}
          <div class="hero-name">RUDIMENTS</div>
          <span class="hero-arrow">&#9656;</span>
        </button>
        <div class="module-grid">
          <button class="module-tile" data-nav="tuner">${ICON.tuner}<div><div class="module-name">TUNER</div></div></button>
          <button class="module-tile" data-nav="timing">${ICON.timing}<div><div class="module-name">TIMING</div></div></button>
          <button class="module-tile" data-nav="calibrate">${ICON.calibrate}<div><div class="module-name">CALIBRATE</div></div></button>
          <button class="module-tile" data-nav="history">${ICON.history}<div><div class="module-name">HISTORY</div></div></button>
        </div>
      </div>

      <div class="stat-strip">
        <div class="statbox"><b>${runs.length}</b><span>Sessions</span></div>
        ${last && typeof last.mean === 'number'
    ? `<div class="statbox ${Math.abs(last.mean) <= store.get('pocketMs') ? 'green' : ''}"><b>${last.mean >= 0 ? '+' : ''}${last.mean.toFixed(0)}</b><span>Last &middot; ms</span></div>`
    : `<div class="statbox"><b>&mdash;</b><span>Last &middot; ms</span></div>`}
        <div class="statbox"><b>${streak}</b><span>Streak</span></div>
      </div>`;

    this.root.querySelectorAll('[data-nav]').forEach((b) => {
      b.addEventListener('click', () => this.nav(b.dataset.nav));
    });
    this.root.querySelector('#home-show').addEventListener('click', () => this.nav('preshow'));
    this.root.querySelectorAll('[data-feel]').forEach((b) => {
      b.addEventListener('click', () => {
        applyFeel(b.dataset.feel); // also seeds the working tempo
        this.render();
      });
    });
  }
}

export { escText };
