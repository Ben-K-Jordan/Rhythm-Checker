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
