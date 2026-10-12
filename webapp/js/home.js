// Home: the practice hub. The Rudiments hub tile, four tool tiles with one
// factual status chip each, the run strip, and the player-feel presets.

import { store } from './store.js';
import { FEELS, applyFeel, restoreFeel } from './feel.js';
import { icon, fmtSigned, nbsp, seg, toast } from './ui.js';

function escText(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

const NBSP = '\u00a0';
const DAY = 86400000;

// local calendar day number: an evening run counts for the user's today,
// not UTC's tomorrow
function dayNum(instant) {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return NaN;
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY;
}

// consecutive practice days ending today or yesterday
function streakDays(runs) {
  const days = new Set(runs.map((r) => dayNum(r.date)).filter(Number.isFinite));
  if (!days.size) return 0;
  const today = dayNum(Date.now());
  let start = today;
  if (!days.has(start)) {
    if (!days.has(today - 1)) return 0;
    start = today - 1;
  }
  let n = 0;
  while (days.has(start - n)) n++;
  return n;
}

function ageWord(instant) {
  const n = dayNum(Date.now()) - dayNum(instant);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 'TODAY';
  return n === 1 ? '1 DAY AGO' : `${n} DAYS AGO`;
}

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

// stored labels read "Single Paradiddle (R-lead)"; the chip names the rudiment
const rudimentName = (label) => String(label || '').replace(/\s*\([^)]*\)\s*$/, '').toUpperCase();

const SVG = (body, cls = '') => `<svg class="${cls}" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="square" aria-hidden="true" focusable="false">${body}</svg>`;
const ICON = {
  rudiments: '<svg class="hero-tile__icon" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="3.4" aria-hidden="true" focusable="false"><circle cx="20" cy="20" r="17"/><circle cx="20" cy="20" r="8"/></svg>',
  tuner: SVG('<path d="M3 19a10 10 0 0 1 20 0"/><path d="M13 19l5-9"/>'),
  timing: SVG('<path d="M9 3h8l5 20H4z" stroke-linejoin="miter"/><path d="M13 19l6-12"/>'),
  history: SVG('<path d="M4 23V15M10 23V9M16 23V13M22 23V4"/>'),
  calibrate: SVG('<circle cx="13" cy="13" r="8"/><path d="M13 1v6M13 19v6M1 13h6M19 13h6"/>'),
};

const BURST_SIZE = 76;
const BURST_LIFT = 18; // px the burst reaches up over the hazard tape

export class HomeMode {
  constructor(root, nav) {
    this.root = root;
    this.nav = nav;
    this.feelToast = null;
    this.root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-nav]');
      if (t && this.root.contains(t)) this.nav(t.dataset.nav);
    });
    const place = () => this.placeBurst();
    window.addEventListener('resize', place, { passive: true });
    document.addEventListener('scroll', place, { passive: true, capture: true });
    this.render();
  }

  activate() {
    this.render();
    requestAnimationFrame(() => this.placeBurst());
  }

  deactivate() {
    // UNDO belongs to this screen: other screens would keep showing the
    // targets it is about to put back
    this.closeFeelToast();
  }

  render() {
    const runs = store.get('runs') || [];
    const cal = store.get('calibrationMs');
    const last = runs[runs.length - 1];
    const lastSpread = last && finite(last.sd) ? `±${last.sd.toFixed(1)}` : null;

    this.root.innerHTML = `
      <div class="screen home">
        <div class="home-burst" aria-hidden="true"><span class="home-burst__fill"><b>100%</b><b>HONEST</b></span></div>
        ${finite(cal) ? '' : `
        <section class="card home-first" aria-labelledby="home-first-title">
          <div class="home-first__top">
            <span class="home-first__kicker">BEFORE YOUR FIRST RUN</span>
            <span class="chip chip--warn">1 MIN</span>
          </div>
          <h2 class="home-first__title" id="home-first-title">CALIBRATE THIS PHONE</h2>
          <p class="home-first__body">One minute. Until then every early/late number includes the phone's own lag.</p>
          <button type="button" class="btn--secondary home-first__go" data-nav="calibrate">GO${icon('tri-right')}</button>
        </section>`}

        <button type="button" class="hero-tile" data-nav="rudiments">
          <span class="hero-tile__row">
            ${ICON.rudiments}
            <span class="hero-tile__name">RUDIMENTS</span>
            <span class="hero-tile__go">${icon('play')}</span>
          </span>
          <span class="hero-tile__what">All 40 PAS rudiments against the click. Every hit in${NBSP}ms.</span>
          ${this.hubChip(runs)}
        </button>

        <div class="home-tiles">${this.tilesHTML(runs)}</div>

        <div class="stat-strip home-stats${runs.length ? '' : ' hidden'}">
          <div class="statbox"><b>${runs.length}</b><span>RUNS</span></div>
          <div class="statbox"><b>${streakDays(runs)}</b><span>DAYS IN A ROW</span></div>
          <div class="statbox${lastSpread ? '' : ' is-empty'}${lastSpread && lastSpread.length >= 5 ? ' statbox--long' : ''}">
            <b>${lastSpread ? `${lastSpread}<i class="unit">${NBSP}ms</i>` : '—'}</b><span>LAST SPREAD</span>
          </div>
        </div>

        <section class="home-feel" aria-labelledby="home-feel-title">
          <div class="sec-head">
            <h2 class="sec-head__stamp" id="home-feel-title">PLAYER FEEL</h2>
            <span class="sec-head__aside">Loads drum targets + tempo</span>
          </div>
          <div class="seg--tall home-feel__seg" role="group" aria-labelledby="home-feel-title"></div>
        </section>

        <div class="home-foot">
          <span class="home-foot__bars" aria-hidden="true"></span>
          <span class="home-foot__text">NOTHING LEAVES THIS PHONE</span>
        </div>
      </div>`;

    const feelSeg = seg(
      this.root.querySelector('.home-feel__seg'),
      Object.entries(FEELS).map(([id, f]) => ({ value: id, label: f.label, sub: f.bpm, data: { feel: id } })),
      store.get('feel'),
      (id) => this.pickFeel(id),
    );
    for (const b of feelSeg.buttons) {
      b.classList.add('feel-card');
      const name = document.createElement('span');
      name.className = 'feel-name';
      name.append(b.firstChild);
      b.prepend(name);
    }
    this.placeBurst();
  }

  hubChip(runs) {
    let lastRud = null;
    for (let i = runs.length - 1; i >= 0 && !lastRud; i--) if (runs[i] && runs[i].kind === 'rudiment') lastRud = runs[i];
    if (!lastRud) return '<span class="chip chip--amber-on-ink hero-tile__last">NO RUNS YET</span>';
    const age = ageWord(lastRud.date);
    return `<span class="chip chip--amber-on-ink hero-tile__last"><span>LAST${NBSP}·${NBSP}</span><span class="hero-tile__rud">${escText(rudimentName(lastRud.label))}</span>${age ? `<span>${NBSP}·${NBSP}${age}</span>` : ''}</span>`;
  }

  tilesHTML(runs) {
    const kit = store.get('kit') || [];
    const tuned = kit.filter((d) => finite(d.targetHz) || finite(d.resoHz)).length;
    const base = store.get('baseline');
    const cal = store.get('calibrationMs');
    const now = Date.now();
    const recent = runs.filter((r) => now - new Date(r.date).getTime() < 7 * DAY).length;

    const tile = (nav, name, what, chip) => `
      <button type="button" class="module-tile" data-nav="${nav}">
        <span class="module-tile__name">${ICON[nav]}${name}</span>
        <span class="module-tile__what">${what}</span>
        ${chip}
      </button>`;
    return [
      tile('tuner', 'TUNER', 'Tap a head. Read Hz and cents.',
        `<span class="chip">${tuned ? `${tuned} OF ${kit.length} DRUMS SET` : 'NO TARGETS YET'}</span>`),
      tile('timing', 'TIMING', 'Hold a tempo. See where you drift.',
        `<span class="chip">${base && finite(base.sd) ? `BASELINE ±${nbsp(base.sd.toFixed(1), 'ms')}` : 'NO BASELINE'}</span>`),
      tile('history', 'HISTORY', 'Every run by day. Spread over time.',
        `<span class="chip">${runs.length ? `${recent} IN LAST 7 DAYS` : 'EMPTY'}</span>`),
      tile('calibrate', 'CALIBRATE', 'Phone lag and mic floor. Once per phone.',
        finite(cal)
          ? `<span class="chip chip--ok">${icon('check')}${nbsp(fmtSigned(-cal), 'ms')} SET</span>`
          : '<span class="chip chip--warn">NEEDS TEST</span>'),
    ].join('');
  }

  pickFeel(id) {
    const f = FEELS[id];
    const snapshot = applyFeel(id);
    if (!f || !snapshot) return;
    const tiles = this.root.querySelector('.home-tiles');
    if (tiles) tiles.innerHTML = this.tilesHTML(store.get('runs') || []);
    const n = snapshot.hits;
    const text = `${f.label} loaded · ${f.genre} · ${nbsp(n, n === 1 ? 'drum' : 'drums')} retuned · ${nbsp(f.defaultBpm, 'BPM')}`;
    this.feelToast = {
      text,
      handle: toast(text, {
        action: 'UNDO',
        onAction: () => {
          this.feelToast = null;
          restoreFeel(snapshot);
          this.render();
          // the UNDO button just vanished with the toast; keep focus on the strip
          if (!document.activeElement || document.activeElement === document.body) {
            const card = this.root.querySelector('.feel-card.on') || this.root.querySelector('.feel-card');
            if (card) card.focus();
          }
        },
      }),
    };
  }

  closeFeelToast() {
    const t = this.feelToast;
    this.feelToast = null;
    if (!t) return;
    const shown = document.querySelector('#toast:not(.hidden) .toast__text');
    if (shown && shown.textContent === t.text) t.handle.close();
  }

  // The burst sits on the hazard tape, outside the scrolling <main> that
  // would clip it, so it is fixed, placed from main's top edge, and hidden
  // once the content scrolls under it.
  placeBurst() {
    if (!this.root.classList.contains('active')) return;
    const burst = this.root.querySelector('.home-burst');
    const screen = this.root.querySelector('.home');
    if (!burst || !screen) return;
    const main = this.root.closest('main') || screen;
    const s = screen.getBoundingClientRect();
    const tape = main.getBoundingClientRect().top;
    const scrolled = (document.scrollingElement ? document.scrollingElement.scrollTop : 0) > 2
      || main.scrollTop > 2;
    burst.style.top = `${Math.round(tape - BURST_LIFT)}px`;
    burst.style.left = `${Math.round(s.right - BURST_SIZE - 6)}px`;
    burst.classList.toggle('is-off', scrolled);
  }
}

export { escText };
