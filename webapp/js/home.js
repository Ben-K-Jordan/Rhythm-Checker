// Home: the practice hub. The Rudiments hub tile, four tool tiles with one
// factual status chip each, the run strip, and the player-feel presets.

import { store } from './store.js';
import { FEELS, applyFeel, restoreFeel } from './feel.js';
import { icon, fmtSigned, nbsp, seg, toast, esc, dayNum, streakDays } from './ui.js';

const NBSP = '\u00a0';
// toast separator: the NBSP keeps each "·" at the end of its line, so no
// wrapped line starts with one
const SEP = `${NBSP}· `;
const DAY = 86400000;

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

// The feel strip's last choice: no player feel. Same id and name as the
// Tuner's NONE so both strips read the same.
const NONE = 'none';

// Everything a feel UNDO writes back (feel.js restoreFeel), as one string:
// while it still matches, the UNDO is still an undo of the last pick only.
const UNDO_KEYS = ['feel', 'kit', 'preferredBpm', 'grooveRud'];
const undoStamp = () => JSON.stringify(UNDO_KEYS.map((k) => store.get(k) ?? null));

// what to put focus back on after a re-render replaced the focused control
function focusSelector(el) {
  if (el.dataset.nav) return `[data-nav="${el.dataset.nav}"]`;
  if (el.dataset.feel) return `.home-feel__seg [data-feel="${el.dataset.feel}"]`;
  return null;
}

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

  // The shell calls this after RESET ALL, an import or closing Settings: the
  // store may have changed under the screen, so read it again. A pending feel
  // UNDO stays while what it would put back over is untouched (Settings just
  // opened and closed); after a reset, import or kit edit it would overwrite
  // that change with a kit from before it, so then it goes.
  refresh() {
    if (this.feelToast && this.feelToast.stamp !== undoStamp()) this.closeFeelToast();
    const active = document.activeElement;
    const had = !!active && active !== document.body && this.root.contains(active);
    const sel = had ? focusSelector(active) : null;
    this.render();
    if (had && (!document.activeElement || document.activeElement === document.body)) {
      const el = (sel && this.root.querySelector(sel)) || this.root.querySelector('.hero-tile');
      if (el) el.focus({ preventScroll: true });
    }
    requestAnimationFrame(() => this.placeBurst());
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
            <span class="sec-head__aside">Loads drum targets + tempo<span class="home-feel__unit"> (BPM)</span></span>
          </div>
          <div class="seg--tall home-feel__seg" role="group" aria-labelledby="home-feel-title"></div>
        </section>

        <div class="home-foot">
          <span class="home-foot__bars" aria-hidden="true"></span>
          <span class="home-foot__text">NOTHING LEAVES THIS PHONE</span>
        </div>
      </div>`;

    const strip = this.root.querySelector('.home-feel__seg');
    const feel = store.get('feel');
    const feelSeg = seg(
      strip,
      [
        ...Object.entries(FEELS).map(([id, f]) => ({ value: id, label: f.label, sub: f.bpm, data: { feel: id } })),
        // NONE drops the feel only: kit targets, tempo and runs stay as they are
        { value: NONE, label: 'NONE', sub: 'kit targets stay', data: { feel: NONE }, aria: 'NONE, no player feel. Kit targets stay.' },
      ],
      FEELS[feel] ? feel : NONE,
      (id) => this.pickFeel(id),
    );
    for (const b of feelSeg.buttons) {
      // the four player cards stay .feel-card (the harness counts four)
      b.classList.add(b.dataset.feel === NONE ? 'feel-none' : 'feel-card');
      const name = document.createElement('span');
      name.className = 'feel-name';
      name.append(b.firstChild);
      b.prepend(name);
      // the range's unit gets its own span: below 360 px the cards show the
      // range alone (CSS keeps the unit for screen readers) and the aside
      // names BPM once
      const sub = b.querySelector('.seg__sub');
      const m = b.dataset.feel !== NONE && sub ? /^(.*?)\s*(BPM)$/.exec(sub.textContent) : null;
      if (m) {
        const unit = document.createElement('span');
        unit.className = 'feel-unit';
        unit.textContent = `${NBSP}${m[2]}`;
        sub.replaceChildren(m[1], unit);
      }
    }
    // seg() ignores a tap on the option it already shows. Here that tap means
    // "load it again": it puts the feel's targets back after hand-tuning.
    // Capture runs before seg's own handler, so .on still names the selection.
    strip.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !strip.contains(b) || !b.classList.contains('on')) return;
      if (b.dataset.feel !== NONE) this.pickFeel(b.dataset.feel);
    }, true);
    this.placeBurst();
  }

  hubChip(runs) {
    let lastRud = null;
    for (let i = runs.length - 1; i >= 0 && !lastRud; i--) if (runs[i] && runs[i].kind === 'rudiment') lastRud = runs[i];
    if (!lastRud) return '<span class="chip chip--amber-on-ink hero-tile__last">NO RUNS YET</span>';
    const age = ageWord(lastRud.date);
    return `<span class="chip chip--amber-on-ink hero-tile__last"><span>LAST${NBSP}·${NBSP}</span><span class="hero-tile__rud">${esc(rudimentName(lastRud.label))}</span>${age ? `<span>${NBSP}·${NBSP}${age}</span>` : ''}</span>`;
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

  // A fresh pick and a tap on the selected card both land here: either way
  // the feel's targets and tempo are written again, with UNDO.
  pickFeel(id) {
    if (id === NONE) {
      this.clearFeel();
      return;
    }
    const f = FEELS[id];
    const snapshot = applyFeel(id);
    if (!f || !snapshot) return;
    const tiles = this.root.querySelector('.home-tiles');
    if (tiles) tiles.innerHTML = this.tilesHTML(store.get('runs') || []);
    const n = snapshot.hits;
    this.feelUndoToast(
      [`${f.label} loaded`, f.genre, `${nbsp(n, n === 1 ? 'drum' : 'drums')} retuned`, nbsp(f.defaultBpm, 'BPM')].join(SEP),
      () => restoreFeel(snapshot),
    );
  }

  // NONE: forget the feel, keep everything it wrote (kit targets, tempo, runs)
  clearFeel() {
    const prev = store.get('feel');
    if (!FEELS[prev]) return; // already none
    store.set('feel', null);
    this.feelUndoToast('Feel cleared. Kit targets kept.', () => store.set('feel', prev));
  }

  feelUndoToast(text, undo) {
    this.feelToast = {
      text,
      stamp: undoStamp(),
      handle: toast(text, {
        // the strip the user just tapped stays clear of the toast, so the
        // next tap lands on a card, not on UNDO
        keepClear: this.root.querySelector('.home-feel__seg'),
        action: 'UNDO',
        onAction: () => {
          this.feelToast = null;
          undo();
          this.render();
          // the UNDO button just vanished with the toast; keep focus on the strip
          if (!document.activeElement || document.activeElement === document.body) {
            const card = this.root.querySelector('.home-feel__seg > button.on') || this.root.querySelector('.home-feel__seg > button');
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

