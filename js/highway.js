// Note highway (spec 8.1): two time-scrolling lanes (R above, L below) under
// a scrolling notation strip, read against a fixed NOW line. Canvas only —
// the monitor, the tiles and #sr-status carry the same data as text.
//
// frame = {
//   t,                 audio-clock time now (s)
//   pxPerSec,          logical px per second (rudiments.highwayPxPerSec)
//   notes: [{ t, hand:'R'|'L', accent, grace, graceTimes:[t], buzz, r,
//             state:'coming'|'hit-perfect'|'hit-good'|'hit-ok'|'miss',
//             devMs, lateMs, beams, dot, tuplet, beatGroup }]  sorted by t
//   beats: [{ t, down }],
//   showGrades,
// }
// draw(null) paints the idle panel (faint staff only).

import { theme, fitCanvas } from './theme.js';

const LOGICAL_W = 420;
const NOW_FRAC = 0.22;
const STAFF_CSS = 44;      // staff strip height, CSS px
const PAST_ALPHA = 0.38;
const TIER_RING = { perfect: 4, good: 3, ok: 2 };

let extra = null;
function colours() {
  if (!extra) {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => (cs.getPropertyValue(name) || fallback).trim() || fallback;
    extra = {
      red: v('--red', '#e0301e'),
      white: v('--white', '#ffffff'),
      rule: v('--rule', '#cfc5ae'),
      cream: v('--cream4', '#f4efe2'),
      ink60: v('--ink60', '#5a534a'),
    };
  }
  return { ...theme(), ...extra };
}

function stateOf(n) {
  if (n.state === 'miss') return { kind: 'miss', tier: null };
  if (n.state && n.state.startsWith('hit-')) return { kind: 'hit', tier: n.state.slice(4) };
  return { kind: 'pending', tier: null };
}

export function createHighway(canvas) {
  const ctx = canvas.getContext('2d');
  let geo = null;
  let last = null;

  const disconnect = fitCanvas(canvas, LOGICAL_W, (g) => {
    geo = g;
    paint(last);
  });
  // canvas text needs the bundled faces; repaint once they are ready
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => paint(last));
  }

  function paint(frame) {
    if (!geo) return;
    const C = colours();
    const { w, h } = geo;
    const cpl = geo.cssPerLogical;
    const L = (css) => css / cpl;
    ctx.clearRect(0, 0, w, h);

    const staffH = L(STAFF_CSS);
    const laneH = h - staffH;
    const lane = { R: staffH + 0.30 * laneH, L: staffH + 0.74 * laneH };
    const nowX = NOW_FRAC * w;
    const sy = L(26);

    // staff strip
    ctx.fillStyle = C.cream;
    ctx.fillRect(0, 0, w, staffH);
    ctx.fillStyle = C.rule;
    ctx.fillRect(0, staffH - L(1), w, L(1));
    ctx.fillStyle = C.ink;
    ctx.globalAlpha = frame ? 1 : 0.3;
    ctx.fillRect(L(6), sy - L(0.7), w - L(12), L(1.4));
    ctx.globalAlpha = 1;
    if (!frame) return;

    const xOf = (t) => nowX + (t - frame.t) * frame.pxPerSec;
    const onScreen = (x, pad) => x > -pad && x < w + pad;

    // lane rails
    ctx.fillStyle = C.rule;
    ctx.fillRect(0, lane.R - L(0.5), w, L(1));
    ctx.fillRect(0, lane.L - L(0.5), w, L(1));

    // beat lines, kept clear of NOW so the judging line is never doubled
    for (const b of frame.beats) {
      const x = xOf(b.t);
      if (!onScreen(x, 4) || Math.abs(x - nowX) < L(8)) continue;
      ctx.globalAlpha = b.down ? 0.45 : 0.18;
      ctx.fillStyle = C.ink;
      const lw = L(b.down ? 2 : 1);
      ctx.fillRect(x - lw / 2, staffH, lw, laneH);
    }
    ctx.globalAlpha = 1;

    // NOW: the judging point; a puck centre crosses it exactly on its beat
    const nw = L(3);
    ctx.fillStyle = C.ink;
    ctx.fillRect(nowX - nw / 2, staffH, nw, laneH);

    drawStaff(frame, C, L, xOf, sy, staffH);

    for (const n of frame.notes) {
      const x = xOf(n.t);
      if (!onScreen(x, n.r + L(30))) continue;
      const st = stateOf(n);
      const past = (frame.t - n.t) * 1000 > (n.lateMs || 0);
      const own = n.hand === 'R' ? C.pink : C.blue;
      const other = n.hand === 'R' ? C.blue : C.pink;
      const y = lane[n.hand] || lane.R;
      ctx.globalAlpha = past ? PAST_ALPHA : 1;

      // flam/drag graces: small, in the other hand's lane, just before the primary
      if (n.graceTimes && n.graceTimes.length) {
        const gy = n.hand === 'R' ? lane.L : lane.R;
        const gr = Math.max(L(6), n.r * 0.4);
        for (const gt of n.graceTimes) {
          const gx = xOf(gt);
          ctx.beginPath();
          ctx.arc(gx, gy, gr, 0, Math.PI * 2);
          ctx.fillStyle = other;
          ctx.fill();
          ctx.lineWidth = L(1.5);
          ctx.strokeStyle = C.ink;
          ctx.stroke();
        }
      }

      if (n.accent) {
        ctx.beginPath();
        ctx.arc(x, y, n.r + L(4.5), 0, Math.PI * 2);
        ctx.lineWidth = L(3);
        ctx.strokeStyle = C.ink;
        ctx.stroke();
      }
      if (n.buzz) {
        ctx.setLineDash([L(4), L(4)]);
        ctx.beginPath();
        ctx.arc(x, y, n.r + L(n.accent ? 9 : 5), 0, Math.PI * 2);
        ctx.lineWidth = L(2);
        ctx.strokeStyle = C.ink;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.beginPath();
      ctx.arc(x, y, n.r, 0, Math.PI * 2);
      if (st.kind === 'miss') {
        // outline only, so the letter stays readable under the badge
        ctx.fillStyle = C.white;
        ctx.fill();
        ctx.lineWidth = L(3);
        ctx.strokeStyle = own;
        ctx.stroke();
      } else {
        ctx.fillStyle = own;
        ctx.fill();
        const ring = frame.showGrades && st.kind === 'hit' ? (TIER_RING[st.tier] || 2) : 2;
        ctx.lineWidth = L(ring);
        ctx.strokeStyle = C.ink;
        ctx.stroke();
      }

      ctx.fillStyle = st.kind === 'miss' ? own : C.white;
      ctx.font = `${(n.r * 1.3).toFixed(2)}px 'Anton', 'Arial Narrow', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(n.hand, x, y + n.r * 0.47);

      if (st.kind === 'miss') {
        const br = L(7);
        const bx = x + n.r * 0.72;
        const by = y - n.r * 0.72;
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fillStyle = C.ink;
        ctx.fill();
        const d = L(3);
        ctx.beginPath();
        ctx.moveTo(bx - d, by - d); ctx.lineTo(bx + d, by + d);
        ctx.moveTo(bx + d, by - d); ctx.lineTo(bx - d, by + d);
        ctx.lineWidth = L(2);
        ctx.strokeStyle = C.white;
        ctx.stroke();
        ctx.globalAlpha = past ? PAST_ALPHA : 1;
      } else if (st.kind === 'hit' && Number.isFinite(n.devMs)) {
        // timing as position: an ink tick 0.5 px per ms off a centre notch
        const ty = y - n.r - L(9);
        const off = L(Math.max(-30, Math.min(30, n.devMs * 0.5)));
        ctx.fillStyle = C.rule;
        ctx.fillRect(x - L(0.75), ty - L(3), L(1.5), L(6));
        ctx.fillStyle = C.ink;
        ctx.fillRect(x + off - L(1.25), ty - L(5), L(2.5), L(10));
      }
    }
    ctx.globalAlpha = 1;

    // NOW chip on top of everything in its column
    const label = 'NOW';
    ctx.font = `600 ${L(11).toFixed(2)}px 'Oswald', 'Arial Narrow', sans-serif`;
    const tw = ctx.measureText(label).width + L(10);
    const chipH = L(17);
    ctx.fillStyle = C.ink;
    ctx.fillRect(nowX - tw / 2, staffH, tw, chipH);
    ctx.fillStyle = C.paper;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, nowX, staffH + chipH / 2 + L(0.5));
    ctx.textBaseline = 'alphabetic';
  }

  // The scrolling staff: the same notes as the pucks, as notation (heads,
  // stems, beat-grouped beams, graces, accents above, buzz, tuplets).
  function drawStaff(frame, C, L, xOf, sy, staffH) {
    const notes = frame.notes;
    const w = geo.w;
    const stemBot = sy + L(15);
    const stemX = (n) => xOf(n.t) - L(4.6);
    const vis = (n) => { const x = xOf(n.t); return x > -L(40) && x < w + L(40); };
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, staffH);
    ctx.clip();
    for (const n of notes) {
      if (!vis(n)) continue;
      const x = xOf(n.t);
      ctx.globalAlpha = (frame.t - n.t) * 1000 > (n.lateMs || 0) ? PAST_ALPHA : 1;
      ctx.fillStyle = C.ink;
      ctx.strokeStyle = C.ink;
      for (const gt of n.graceTimes || []) {
        const gx = xOf(gt);
        ctx.save(); ctx.translate(gx, sy - L(1)); ctx.rotate(-0.32);
        ctx.beginPath(); ctx.ellipse(0, 0, L(3), L(2.2), 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        ctx.lineWidth = L(1);
        ctx.beginPath(); ctx.moveTo(gx + L(2.4), sy - L(2)); ctx.lineTo(gx + L(2.4), sy - L(11)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(gx - L(2), sy - L(7)); ctx.lineTo(gx + L(6), sy - L(11)); ctx.stroke();
      }
      ctx.save(); ctx.translate(x, sy); ctx.rotate(-0.32);
      ctx.beginPath(); ctx.ellipse(0, 0, L(5.6), L(4), 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.lineWidth = L(1.5);
      ctx.beginPath(); ctx.moveTo(stemX(n), sy + L(1)); ctx.lineTo(stemX(n), stemBot); ctx.stroke();
      if (n.dot) { ctx.beginPath(); ctx.arc(x + L(8), sy - L(2), L(1.6), 0, Math.PI * 2); ctx.fill(); }
      if (n.buzz) {
        for (let z = 0; z < 3; z++) {
          const yy = sy + L(6 + z * 3);
          ctx.beginPath(); ctx.moveTo(stemX(n) - L(4), yy + L(2)); ctx.lineTo(stemX(n) + L(4), yy - L(2)); ctx.stroke();
        }
      }
      if (n.accent) { // above the staff, never under the heads
        ctx.lineWidth = L(1.6);
        ctx.beginPath();
        ctx.moveTo(x - L(5), sy - L(15)); ctx.lineTo(x + L(4), sy - L(12)); ctx.lineTo(x - L(5), sy - L(9));
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    let i = 0;
    while (i < notes.length) {
      let j = i;
      while (j + 1 < notes.length && notes[j + 1].beatGroup === notes[i].beatGroup) j++;
      const group = notes.slice(i, j + 1);
      if (group.some(vis)) {
        drawBeams(group, C, L, stemX, stemBot);
        if (group[0].tuplet) {
          const xs = group.map((n) => xOf(n.t));
          ctx.fillStyle = C.ink60;
          ctx.font = `${L(11).toFixed(2)}px 'Space Mono', monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(String(group[0].tuplet), (Math.min(...xs) + Math.max(...xs)) / 2, L(10));
        }
      }
      i = j + 1;
    }
    ctx.restore();
  }

  function drawBeams(group, C, L, stemX, stemBot) {
    const gap = L(3.5);
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = L(2.5);
    let a = 0;
    while (a < group.length) {
      if (group[a].beams < 1) { a++; continue; }
      let b = a;
      while (b + 1 < group.length && group[b + 1].beams >= 1) b++;
      const run = group.slice(a, b + 1);
      const maxB = Math.max(...run.map((n) => n.beams));
      for (let lv = 1; lv <= maxB; lv++) {
        const y = stemBot - (lv - 1) * gap;
        let c = 0;
        while (c < run.length) {
          if (run[c].beams < lv) { c++; continue; }
          let d = c;
          while (d + 1 < run.length && run[d + 1].beams >= lv) d++;
          ctx.beginPath();
          if (d > c) {
            ctx.moveTo(stemX(run[c]), y); ctx.lineTo(stemX(run[d]), y);
          } else {
            const dir = run.length === 1 || (c > 0 && run[c - 1].beams >= lv) ? -1 : 1;
            const sx = stemX(run[c]);
            if (run.length === 1) { ctx.moveTo(sx, y); ctx.lineTo(sx + L(7), y - L(3)); }
            else { ctx.moveTo(sx, y); ctx.lineTo(sx + dir * L(7), y); }
          }
          ctx.stroke();
          c = d + 1;
        }
      }
      a = b + 1;
    }
  }

  return {
    draw(frame) {
      last = frame || null;
      paint(last);
    },
    destroy() {
      disconnect();
      last = null;
    },
  };
}
