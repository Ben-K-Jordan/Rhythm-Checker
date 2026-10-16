// Shared DOM helpers for the v3 screens: toast, segmented controls, icons,
// run state, number formatting, the generated fact line and the polite
// screen-reader status region.

const MINUS = '−';
const NBSP = ' ';

// ----------------------------------------------------------- text + days
// HTML-escape for text interpolated into markup, attributes included
export function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const DAY = 86400000;

// local calendar day number: an evening run counts for the user's today,
// not UTC's tomorrow
export function dayNum(instant) {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return NaN;
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY;
}

// days in a row: consecutive local days with a run, ending today or yesterday
export function streakDays(runs) {
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

// ------------------------------------------------------------------ icons
// The bundled fonts have no arrows, triangles, ticks or crosses, so every
// glyph of that kind is inline SVG drawn in currentColor.
const STROKE = 'fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square" stroke-linejoin="miter"';
const ICONS = {
  play: '<path d="M6 3.5v17L20.5 12z"/>',
  stop: '<rect x="5" y="5" width="14" height="14"/>',
  check: `<path ${STROKE} stroke-width="3.4" d="M4 12.5l5 5L20 6.5"/>`,
  close: `<path ${STROKE} d="M6 6l12 12M18 6L6 18"/>`,
  back: `<path ${STROKE} d="M20 12H6M11.5 5.5L5 12l6.5 6.5"/>`,
  down: `<path ${STROKE} d="M12 4v14M5.5 12L12 18.5 18.5 12"/>`,
  ramp: `<path ${STROKE} d="M5.5 18.5L18 6M9 5.5h9.5V15"/>`,
  lock: '<rect x="5" y="10.5" width="14" height="10"/><path fill="none" stroke="currentColor" stroke-width="2.6" d="M8.3 10.5V8a3.7 3.7 0 0 1 7.4 0v2.5"/>',
  'tri-left': '<path d="M17 4v16L5 12z"/>',
  'tri-right': '<path d="M7 4v16l12-8z"/>',
  'tri-up': '<path d="M4 17h16L12 5z"/>',
  'tri-down': '<path d="M4 7h16l-8 12z"/>',
  cross: '<path d="M3.5 7.4L7.4 3.5 12 8.1l4.6-4.6 3.9 3.9-4.6 4.6 4.6 4.6-3.9 3.9-4.6-4.6-4.6 4.6-3.9-3.9 4.6-4.6z"/>',
};

export function icon(name) {
  const body = ICONS[name];
  if (!body) throw new Error(`unknown icon: ${name}`);
  return `<svg class="icon icon-${name}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">${body}</svg>`;
}

// ------------------------------------------------------------- formatting
export function fmtSigned(ms, digits = 0) {
  const v = Number(ms);
  if (ms === null || ms === undefined || !Number.isFinite(v)) return '—';
  const text = Math.abs(v).toFixed(digits);
  if (Number(text) === 0) return text;
  return (v < 0 ? MINUS : '+') + text;
}

// Negative offsets are early. Pass `digits`, the precision the value is shown
// at, and a value that shows as 0 (or 0.0) gets no word at all: '' — a centred
// offset is neither early nor late. Without `digits` the sign alone decides.
export function dirWord(ms, digits) {
  const v = Number(ms);
  if (digits !== undefined && Number(Math.abs(v).toFixed(digits)) === 0) return '';
  return v < 0 ? 'early' : 'late';
}

export function nbsp(value, unit) {
  return `${value}${NBSP}${unit}`;
}

// An offset's size as shown, NBSP before the unit, then its direction word
// only when the shown size is not 0: "12 ms early", "0.0 ms".
export function offsetText(ms, digits = 0, { upper = false, unit = 'ms' } = {}) {
  const word = dirWord(ms, digits);
  const text = nbsp(Math.abs(Number(ms)).toFixed(digits), unit);
  if (!word) return text;
  return `${text} ${upper ? word.toUpperCase() : word}`;
}

// Live monitor font size in px by glyph count (sign included).
export function monitorSize(str) {
  const n = Array.from(String(str)).length;
  if (n <= 3) return 120;
  if (n === 4) return 96;
  return 72;
}

// ------------------------------------------------------------- fact line
const one = (x) => Math.abs(x).toFixed(1);
const clip = (s) => (s.length > 100 ? `${s.slice(0, 99)}…` : s);

function rudimentsFact(d) {
  const notes = d.notes || 0;
  if (notes && d.missed >= 0.1 * notes) {
    const bars = d.missedBars && d.missedBars.length === 2
      ? (d.missedBars[0] === d.missedBars[1]
        ? `, most in bar ${d.missedBars[0]}`
        : `, most in bars ${d.missedBars[0]}–${d.missedBars[1]}`)
      : '';
    return `${d.missed} of ${notes} notes missed${bars}.`;
  }
  const avg = Math.abs(d.mean);
  if (avg >= 10 && d.sd <= avg / 2) {
    const lag = d.calibrationMs === null ? ' Likely phone lag.' : '';
    return `Hits sat ${offsetText(d.mean, 1)} as a group.${lag}`;
  }
  let worst = null;
  for (const s of d.strokes || []) {
    const diff = s.mean - d.mean;
    if (Math.abs(diff) >= 8 && (!worst || Math.abs(diff) > Math.abs(worst.diff))) worst = { name: s.name, diff };
  }
  if (worst) {
    return `${worst.name} sat ${nbsp(one(worst.diff), 'ms')} ${worst.diff > 0 ? 'later' : 'earlier'} than the other strokes.`;
  }
  const r = d.ramp;
  if (r && Math.abs(r.sdTo - r.sdFrom) >= 3) {
    return `Spread went from ±${nbsp(one(r.sdFrom), 'ms')} at ${r.bpmFrom} to ±${nbsp(one(r.sdTo), 'ms')} at ${nbsp(r.bpmTo, 'BPM')}.`;
  }
  return `${d.within} of ${d.hits} hits within ±${nbsp(d.windowMs, 'ms')} of the click.`;
}

// Where a handful of signed offsets actually sat, in whole ms as shown: one
// side -> "came 20–30 ms early"; both sides -> "ran from 30 ms early to 5 ms
// late"; all at 0 -> "came 0 ms from the click". Never a range of sizes under
// one direction word that some of the hits contradict. (Kept short: with
// 3-digit offsets and counts the whole fact still fits the 100-char cap.)
function offsetSpread(xs) {
  const shown = xs.map((x) => {
    const m = Math.round(Math.abs(x));
    return m === 0 ? 0 : Math.sign(x) * m;
  });
  const early = shown.filter((x) => x < 0).map((x) => -x);
  const late = shown.filter((x) => x > 0);
  if (early.length && late.length) {
    return `ran from ${nbsp(Math.max(...early), 'ms')} early to ${nbsp(Math.max(...late), 'ms')} late`;
  }
  if (!early.length && !late.length) return `came ${nbsp(0, 'ms')} from the click`;
  const sizes = shown.map((x) => Math.abs(x)); // any 0s belong in the range too
  const lo = Math.min(...sizes), hi = Math.max(...sizes);
  return `came ${nbsp(lo === hi ? lo : `${lo}–${hi}`, 'ms')} ${early.length ? 'early' : 'late'}`;
}

function timingFact(d) {
  const offs = d.offsets || [];
  const p = d.pocketMs;
  const inPocket = (xs) => xs.filter((x) => Math.abs(x) <= p).length;
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  if (offs.length > 6) {
    const first = offs.slice(0, 6), rest = offs.slice(6);
    if (Math.abs(mean(first) - mean(rest)) >= 15) {
      return `The first 6 hits ${offsetSpread(first)}. After that, ${inPocket(rest)} of ${rest.length} landed in the pocket.`;
    }
  }
  if (d.drift !== null && d.drift !== undefined && Math.abs(d.drift) >= 20) {
    return `From 5 s on, hits moved ${nbsp(Math.round(Math.abs(d.drift)), 'ms')} ${d.drift > 0 ? 'later' : 'earlier'} per minute.`;
  }
  return `${inPocket(offs)} of ${offs.length} hits landed in the pocket (±${nbsp(p, 'ms')}).`;
}

// kind 'rudiments': {notes, missed, missedBars:[a,b]|null, mean, sd,
//   calibrationMs, strokes:[{name, mean}], ramp:{sdFrom, bpmFrom, sdTo, bpmTo}|null,
//   hits, within, windowMs}
// kind 'timing': {offsets:[signed ms, in play order], pocketMs, drift: ms/min|null}
export function factLine(kind, data) {
  if (kind === 'rudiments') return clip(rudimentsFact(data));
  if (kind === 'timing') return clip(timingFact(data));
  throw new Error(`unknown fact kind: ${kind}`);
}

// ------------------------------------------------------- live region
function srStatus() {
  let el = document.getElementById('sr-status');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sr-status';
    el.className = 'sr-only';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  return el;
}

let announceTimer = null;
export function announce(text) {
  const el = srStatus();
  // clearing first makes a repeated identical message announce again
  el.textContent = '';
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { el.textContent = text; }, 40);
}

// ------------------------------------------------------------- run state
export const RUN_STATES = ['idle', 'countin', 'running', 'result', 'stopped'];

export function setRunState(modeRoot, state, label = '') {
  modeRoot.dataset.state = state;
  const mode = (modeRoot.id || '').replace(/^mode-/, '');
  document.dispatchEvent(new CustomEvent('rc:run', { detail: { mode, state, label } }));
}

// ------------------------------------------------------------------ toast
let toastTimer = null;

function toastEl() {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast hidden';
    document.body.appendChild(el);
  }
  el.classList.add('toast');
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  return el;
}

// One toast at a time; a new one replaces the old. Returns {close}.
// A toast floats over the end of the screen. While one is up, body.has-toast
// pads the screen (and the settings sheet) by --toast-space, so whatever it
// covers can be scrolled clear; `keepClear` is the block the user just acted
// on, scrolled up out from under it. The pad is only dropped when that cannot
// move the page: if the screen is scrolled into it, it stays until the user
// scrolls back out, so nothing ever jumps on its own when a toast times out.
const SCROLLERS = 'main, #settings-body';
let spaceHold = null;  // a closed toast's pad that still holds a scroller up
let current = null;    // { close, ms, refocus } for the toast on screen
let focusWired = false;

const shown = (sc) => sc.isConnected && sc.getClientRects().length > 0;

// stop watching; `keepClass` when a new toast takes the pad straight over
function endHold(keepClass) {
  if (!spaceHold) return;
  for (const sc of spaceHold.scrollers) sc.removeEventListener('scroll', spaceHold.check);
  spaceHold = null;
  if (!keepClass && !document.querySelector('#toast:not(.hidden)')) document.body.classList.remove('has-toast');
}

// would dropping the pad pull a scroller that is still on screen?
function padHolds() {
  return !!spaceHold && spaceHold.scrollers.some((sc, i) => shown(sc) && sc.scrollTop > spaceHold.limits[i]);
}

function holdToastSpace() {
  endHold(true);
  const body = document.body;
  const scrollers = [...document.querySelectorAll(SCROLLERS)].filter(shown);
  // how far each could scroll without the pad: measured, not assumed, since
  // not every screen takes it. scrollTop is restored in the same task, so
  // nothing is painted in between.
  const tops = scrollers.map((sc) => sc.scrollTop);
  body.classList.remove('has-toast');
  const limits = scrollers.map((sc) => sc.scrollHeight - sc.clientHeight);
  body.classList.add('has-toast');
  scrollers.forEach((sc, i) => { sc.scrollTop = tops[i]; });
  const check = () => { if (!padHolds()) endHold(false); };
  spaceHold = { scrollers, limits, check };
  if (!padHolds()) { endHold(false); return; }
  for (const sc of scrollers) sc.addEventListener('scroll', check, { passive: true });
}

// The shell calls this when a scroller leaves or resets on its own (the
// settings sheet closing, a screen change): a held pad that no longer holds
// anything up is dropped.
export function settleToastSpace() {
  if (spaceHold && !padHolds()) endHold(false);
}

// a keyboard user who reaches UNDO keeps the toast for as long as they stay on it
function wireToastFocus(el) {
  if (focusWired) return;
  focusWired = true;
  el.addEventListener('focusin', () => clearTimeout(toastTimer));
  el.addEventListener('focusout', (e) => {
    if (el.contains(e.relatedTarget) || !current || current.ms <= 0) return;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(current.close, current.ms);
  });
}

// returnFocus: where keyboard focus goes if the toast closes while holding it
// (an element, or a function returning one); defaults to keepClear's first control
export function toast(text, { action = null, onAction = null, ms = 6000, keepClear = null, returnFocus = null } = {}) {
  const el = toastEl();
  wireToastFocus(el);
  clearTimeout(toastTimer);
  const lost = el.contains(document.activeElement) && current ? current.refocus : null;
  endHold(true); // this toast takes over any pad still held: nothing moves in between
  el.replaceChildren();
  if (lost) lost();
  const msg = document.createElement('span');
  msg.className = 'toast__text';
  msg.textContent = text;
  el.appendChild(msg);
  const refocus = () => {
    let t = typeof returnFocus === 'function' ? returnFocus() : returnFocus;
    if (!t && keepClear) t = keepClear.matches('button, [tabindex]') ? keepClear : keepClear.querySelector('button:not(:disabled), [tabindex]');
    if (t && t.isConnected) t.focus({ preventScroll: true });
  };
  const close = () => {
    clearTimeout(toastTimer);
    const hadFocus = el.contains(document.activeElement);
    if (current && current.close === close) current = null;
    el.classList.add('hidden');
    el.replaceChildren();
    holdToastSpace();
    if (hadFocus) refocus();
  };
  current = { close, ms, refocus };
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast__action';
    btn.textContent = action;
    btn.addEventListener('click', () => {
      close();
      if (onAction) onAction();
    });
    el.appendChild(btn);
  }
  el.classList.remove('hidden');
  document.body.style.setProperty('--toast-space', `${el.offsetHeight + 16}px`);
  document.body.classList.add('has-toast');
  if (keepClear) {
    requestAnimationFrame(() => {
      if (!keepClear.isConnected || el.classList.contains('hidden')) return;
      const sc = keepClear.closest(SCROLLERS);
      const r = keepClear.getBoundingClientRect();
      const top = el.getBoundingClientRect().top - 8;
      // just far enough that it ends above the toast, never so far its top leaves the scroller
      const by = Math.min(r.bottom - top, sc ? r.top - sc.getBoundingClientRect().top : 0);
      if (sc && by > 0) sc.scrollTop += by;
    });
  }
  if (ms > 0) toastTimer = setTimeout(close, ms);
  return { close };
}

// ------------------------------------------------------- segmented control
// options: strings, or {value, label, sub, icon, data:{...dataset}, aria, disabled}.
// Renders one <button> per option into `container` (class .seg added),
// marks the active one with .on + aria-pressed, and calls
// onChange(value, button) when the user picks a different option.
export function seg(container, options, value, onChange) {
  const opts = options.map((o) => (typeof o === 'object' && o !== null ? o : { value: o, label: String(o) }));
  let current = value;
  container.classList.add('seg');
  const buttons = opts.map((o) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.value = String(o.value);
    for (const [k, v] of Object.entries(o.data || {})) b.dataset[k] = v;
    if (o.icon) b.insertAdjacentHTML('beforeend', icon(o.icon));
    b.append(document.createTextNode(o.label ?? String(o.value)));
    if (o.sub) {
      const s = document.createElement('span');
      s.className = 'seg__sub';
      s.textContent = o.sub;
      b.appendChild(s);
    }
    if (o.aria) b.setAttribute('aria-label', o.aria);
    if (o.disabled) b.disabled = true;
    b.addEventListener('click', () => {
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') return;
      if (o.value === current) return;
      api.set(o.value);
      if (onChange) onChange(o.value, b);
    });
    return b;
  });
  container.replaceChildren(...buttons);

  const scroller = container.classList.contains('seg--scroll');
  const markEnd = () => {
    container.classList.toggle('is-end', container.scrollLeft + container.clientWidth >= container.scrollWidth - 1);
  };
  const reveal = (b) => {
    if (!scroller) return;
    if (b) {
      // horizontal only: never scroll the page vertically to reach the chip
      const c = container.getBoundingClientRect(), r = b.getBoundingClientRect();
      if (r.left < c.left) container.scrollLeft -= c.left - r.left;
      else if (r.right > c.right - 24) container.scrollLeft += r.right - (c.right - 24);
    }
    markEnd();
  };
  if (scroller) container.addEventListener('scroll', markEnd, { passive: true });

  const api = {
    el: container,
    buttons,
    get value() { return current; },
    set(v) {
      current = v;
      let active = null;
      opts.forEach((o, i) => {
        const on = o.value === v;
        buttons[i].classList.toggle('on', on);
        buttons[i].setAttribute('aria-pressed', String(on));
        if (on) active = buttons[i];
      });
      reveal(active);
    },
  };
  api.set(value);
  return api;
}
