// Shared DOM helpers for the v3 screens: toast, segmented controls, icons,
// run state, number formatting, the generated fact line and the polite
// screen-reader status region.

const MINUS = '−';
const NBSP = ' ';

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

// Negative offsets are early.
export function dirWord(ms) {
  return ms < 0 ? 'early' : 'late';
}

export function nbsp(value, unit) {
  return `${value}${NBSP}${unit}`;
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
    return `Hits sat ${nbsp(one(d.mean), 'ms')} ${dirWord(d.mean)} as a group.${lag}`;
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

function timingFact(d) {
  const offs = d.offsets || [];
  const p = d.pocketMs;
  const inPocket = (xs) => xs.filter((x) => Math.abs(x) <= p).length;
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  if (offs.length > 6) {
    const first = offs.slice(0, 6), rest = offs.slice(6);
    const m1 = mean(first);
    if (Math.abs(m1 - mean(rest)) >= 15) {
      const mags = first.map((x) => Math.round(Math.abs(x)));
      const lo = Math.min(...mags), hi = Math.max(...mags);
      const span = lo === hi ? `${lo}` : `${lo}–${hi}`;
      return `The first 6 hits came ${nbsp(span, 'ms')} ${dirWord(m1)}. After that, ${inPocket(rest)} of ${rest.length} landed in the pocket.`;
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
export function toast(text, { action = null, onAction = null, ms = 6000 } = {}) {
  const el = toastEl();
  clearTimeout(toastTimer);
  el.replaceChildren();
  const msg = document.createElement('span');
  msg.className = 'toast__text';
  msg.textContent = text;
  el.appendChild(msg);
  const close = () => {
    clearTimeout(toastTimer);
    el.classList.add('hidden');
    el.replaceChildren();
  };
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
