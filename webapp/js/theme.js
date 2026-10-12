// Canvas code can't read CSS — this bridges the design tokens so every chart
// and highway draws in the same ink as the rest of the app.

let cache = null;

export function theme() {
  if (!cache) {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (cs.getPropertyValue(name) || fallback).trim();
    cache = {
      ink: v('--ink', '#16140f'),
      panel: v('--panel', '#ede8da'),
      line: v('--line', '#cfc8b6'),
      paper: v('--paper', '#f6f2e8'),
      dim: v('--dim', '#6f6a5c'),
      pink: v('--pink', '#d92308'),
      acid: v('--acid', '#b57e00'),
      green: v('--green', '#187a38'),
      blue: v('--blue', '#1f5fd6'),
      mono: v('--mono-font', 'ui-monospace, Menlo, monospace'),
    };
  }
  return cache;
}

// Sizes a canvas's backing store to its CSS box x DPR and gives draw code a
// uniform logical coordinate space `logicalW` wide. Never changes the CSS
// box, so the observer cannot loop. Draw with the returned w/h, never
// cv.width/cv.height. Returns a disconnect function.
export function fitCanvas(cv, logicalW, onResize) {
  const ro = new ResizeObserver(() => {
    const r = cv.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.height * dpr);
    const k = cv.width / logicalW;
    const ctx = cv.getContext('2d');
    ctx.setTransform(k, 0, 0, k, 0, 0);
    onResize({ w: logicalW, h: (logicalW * r.height) / r.width, k, cssPerLogical: r.width / logicalW });
  });
  ro.observe(cv);
  return () => ro.disconnect();
}

// Shared mic-level mapping for the header meter and Calibrate: linear RMS
// level -> 0..1 over -60..-6 dB.
export function levelFrac(level) {
  if (!(level > 0)) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(level) + 60) / 54));
}

let holdHint = null;
function holdHintId() {
  if (!holdHint || !holdHint.isConnected) {
    holdHint = document.getElementById('hold-hint') || document.createElement('span');
    holdHint.id = 'hold-hint';
    holdHint.className = 'sr-only';
    holdHint.textContent = 'Press and hold';
    if (!holdHint.isConnected) document.body.appendChild(holdHint);
  }
  return holdHint.id;
}

// Press-and-hold for destructive actions: a stray tap can never wipe
// anything. Pointer or Enter/Space held for holdMs confirms. With `label`
// the button narrates: `armedLabel` while held, `label` otherwise.
// The third argument may also be a plain number (holdMs), as before.
export function holdToConfirm(button, onConfirm, opts = {}) {
  const o = typeof opts === 'number' ? { holdMs: opts } : opts;
  const holdMs = o.holdMs ?? 600;
  const label = o.label ?? null;
  const armedLabel = o.armedLabel ?? 'KEEP HOLDING…';
  let timer = null;
  const setLabel = (text) => {
    if (label === null) return;
    const slot = button.querySelector('.hold__label') || button;
    slot.textContent = text;
  };
  const arm = () => {
    if (timer || button.disabled) return;
    button.classList.add('holding');
    setLabel(armedLabel);
    timer = setTimeout(() => {
      timer = null;
      button.classList.remove('holding');
      setLabel(label);
      onConfirm();
    }, holdMs);
  };
  const release = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    button.classList.remove('holding');
    setLabel(label);
  };
  const isHoldKey = (ev) => ev.key === 'Enter' || ev.key === ' ';
  button.style.setProperty('--hold-ms', `${holdMs}ms`);
  if (!button.hasAttribute('aria-describedby')) button.setAttribute('aria-describedby', holdHintId());
  if (label !== null) setLabel(label);
  button.addEventListener('pointerdown', (ev) => { ev.preventDefault(); arm(); });
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('pointerleave', release);
  button.addEventListener('keydown', (ev) => {
    if (!isHoldKey(ev)) return;
    ev.preventDefault();
    if (!ev.repeat) arm();
  });
  button.addEventListener('keyup', (ev) => { if (isHoldKey(ev)) release(); });
  button.addEventListener('blur', release);
}
