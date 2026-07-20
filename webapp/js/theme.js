// Canvas code can't read CSS — this bridges the design tokens so every chart
// and highway draws in the same ink as the rest of the app.

let cache = null;

export function theme() {
  if (!cache) {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (cs.getPropertyValue(name) || fallback).trim();
    cache = {
      ink: v('--ink', '#0b0b0d'),
      panel: v('--panel', '#141419'),
      line: v('--line', '#2b2b33'),
      paper: v('--paper', '#f2efe6'),
      dim: v('--dim', '#8d8d99'),
      pink: v('--pink', '#ff2e63'),
      acid: v('--acid', '#ffe600'),
      green: v('--green', '#00e054'),
      blue: v('--blue', '#3aa6ff'),
      mono: v('--mono-font', 'ui-monospace, Menlo, monospace'),
    };
  }
  return cache;
}

// 600 ms press-and-hold for destructive actions: a stray tap on show day can
// never disarm or overwrite anything. The button narrates its own progress.
export function holdToConfirm(button, onConfirm, holdMs = 600) {
  let timer = null;
  const arm = (ev) => {
    ev.preventDefault();
    button.classList.add('holding');
    timer = setTimeout(() => {
      button.classList.remove('holding');
      timer = null;
      onConfirm();
    }, holdMs);
  };
  const release = () => {
    button.classList.remove('holding');
    if (timer) clearTimeout(timer);
    timer = null;
  };
  button.style.setProperty('--hold-ms', `${holdMs}ms`);
  button.addEventListener('pointerdown', arm);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('pointerleave', release);
}
