// Rhythm-notation for the rudiments — a real single-line drum staff drawn from
// the same note data the highway plays, so you can SIGHT-READ each rudiment:
// noteheads at their onsets, stems, beams (by beat), flams/drags as grace
// notes, accents, buzz tremolos, tuplet numbers, and R/L sticking underneath.
//
// It reads the onset grid: a note lasts until the next onset in its beat (or
// the beat end), which turns a roll's trailing gaps into the longer note you
// actually play — e.g. a five-stroke roll reads RRLL (32nds) + an 8th, not
// four notes and a pile of rests. Pure: (rudiment) -> SVG string. Inline SVG
// inherits the page's CSS variables, so it themes itself.

// span (in grid cells) -> [beams removed by halving, dotted?]. Covers every
// span the 40 rudiments actually produce: {1,2,3,4,6,8}.
const SPAN = { 1: [0, false], 2: [1, false], 4: [2, false], 8: [3, false], 3: [1, true], 6: [2, true] };
// beams for a single grid cell: 8th-triplet=1, 16th=2, 16th-sextuplet=2, 32nd=3
const CELL_BEAMS = { 3: 1, 4: 2, 6: 2, 8: 3 };

function valueOf(span, grid) {
  const [halved, dot] = SPAN[span] || [0, false];
  return { beams: Math.max(0, (CELL_BEAMS[grid] || 2) - halved), dot };
}

const LY = 46;        // staff line / notehead centre
const STEM_BOT = 74;  // stem tip (stems point down)
const STICK_Y = 95;   // sticking letters
const H = 104;

export function rudimentNotationSVG(rud, opts = {}) {
  const lead = opts.lead || 'R';
  const accentOf = opts.accentOf || ((n) => n.accent);
  const swap = (h) => (lead === 'L' ? (h === 'R' ? 'L' : 'R') : h);
  const { grid, beats } = rud;

  const beatW = Math.max(70, grid * 12);
  const padL = 40;
  const padR = 16;
  const width = padL + beats * beatW + padR;
  const beatX = (b) => padL + b * beatW;
  const noteX = (b, s) => beatX(b) + (s / grid) * beatW + 6;
  const stemX = (x) => x - 5.2;

  // group notes by beat, in order
  const perBeat = Array.from({ length: beats }, () => []);
  rud.notes.forEach((n, idx) => {
    perBeat[Math.floor(n.slot / grid)].push({ ...n, idx, sib: n.slot % grid });
  });

  const p = [];
  // staff line
  p.push(`<line x1="${padL - 8}" y1="${LY}" x2="${width - 8}" y2="${LY}" stroke="var(--ink)" stroke-width="1.4"/>`);
  // faint beat separators
  for (let b = 1; b < beats; b++) {
    p.push(`<line x1="${beatX(b)}" y1="${LY - 15}" x2="${beatX(b)}" y2="${LY + 15}" stroke="var(--line)" stroke-width="1"/>`);
  }

  for (let b = 0; b < beats; b++) {
    const ns = perBeat[b].sort((a, z) => a.sib - z.sib);
    if (!ns.length) { // a beat with no onset reads as a quarter rest
      const cx = beatX(b) + beatW * 0.5;
      p.push(`<path d="M ${cx - 3} ${LY - 13} L ${cx + 3} ${LY - 6} L ${cx - 3} ${LY - 1} L ${cx + 4} ${LY + 7}" fill="none" stroke="var(--ink)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`);
      continue;
    }
    for (let k = 0; k < ns.length; k++) {
      const nextSib = k + 1 < ns.length ? ns[k + 1].sib : grid;
      const v = valueOf(nextSib - ns[k].sib, grid);
      ns[k].beams = v.beams;
      ns[k].dot = v.dot;
      ns[k].x = noteX(b, ns[k].sib);
    }
    // tuplet number over triplet/sextuplet beats
    if ((grid === 3 || grid === 6) && ns.length) {
      p.push(`<text x="${beatX(b) + beatW * 0.5}" y="${LY - 25}" text-anchor="middle" font-family="var(--mono-font)" font-size="11" fill="var(--dim)">${grid}</text>`);
    }
    for (const n of ns) {
      const { x } = n;
      const sx = stemX(x);
      p.push(`<ellipse cx="${x}" cy="${LY}" rx="6" ry="4.4" transform="rotate(-18 ${x} ${LY})" fill="var(--ink)"/>`);
      p.push(`<line x1="${sx}" y1="${LY + 1}" x2="${sx}" y2="${STEM_BOT}" stroke="var(--ink)" stroke-width="1.6"/>`);
      if (n.dot) p.push(`<circle cx="${x + 9}" cy="${LY - 2}" r="1.6" fill="var(--ink)"/>`);
      if (n.buzz) {
        for (let z = 0; z < 3; z++) {
          const yy = LY + 9 + z * 4;
          p.push(`<line x1="${sx - 4}" y1="${yy + 2}" x2="${sx + 4}" y2="${yy - 2}" stroke="var(--ink)" stroke-width="1.5"/>`);
        }
      }
      if (accentOf(n, n.idx)) {
        p.push(`<path d="M ${x - 6} ${LY - 16} L ${x + 4} ${LY - 12.5} L ${x - 6} ${LY - 9}" fill="none" stroke="var(--ink)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`);
      }
      for (let g = 0; g < n.grace; g++) {
        const gx = x - 11 - g * 7.5;
        p.push(`<ellipse cx="${gx}" cy="${LY - 1}" rx="3" ry="2.3" transform="rotate(-18 ${gx} ${LY - 1})" fill="var(--ink)"/>`);
        p.push(`<line x1="${gx + 2.5}" y1="${LY - 2}" x2="${gx + 2.5}" y2="${LY - 13}" stroke="var(--ink)" stroke-width="1"/>`);
        p.push(`<line x1="${gx - 2}" y1="${LY - 8}" x2="${gx + 6}" y2="${LY - 13}" stroke="var(--ink)" stroke-width="1"/>`);
      }
      const hand = swap(n.hand);
      p.push(`<text x="${x}" y="${STICK_Y}" text-anchor="middle" font-family="var(--mono-font)" font-weight="700" font-size="12" fill="${hand === 'R' ? 'var(--pink)' : 'var(--blue)'}">${hand}</text>`);
    }
    drawBeams(ns, p);
  }

  return `<svg viewBox="0 0 ${width} ${H}" height="78" preserveAspectRatio="xMinYMid meet" class="rud-notation-svg" role="img" aria-label="${rud.name} notation">${p.join('')}</svg>`;
}

// Beam by level: the 8th-beam spans every beamable note in the beat; each
// higher level (16th, 32nd) spans only the sub-runs fast enough for it, with
// stubs for a lone fast note. Rests / quarter notes (0 beams) break the group.
function drawBeams(ns, p) {
  const gap = 4.2;
  const th = 3;
  const sx = (n) => n.x - 5.2;
  let i = 0;
  while (i < ns.length) {
    if (ns[i].beams < 1) { i++; continue; }
    let j = i;
    while (j + 1 < ns.length && ns[j + 1].beams >= 1) j++;
    const group = ns.slice(i, j + 1);
    if (group.length === 1) {
      const n = group[0];
      for (let L = 1; L <= n.beams; L++) {
        const y = STEM_BOT - (L - 1) * gap;
        p.push(`<line x1="${sx(n)}" y1="${y}" x2="${sx(n) + 8}" y2="${y - 3}" stroke="var(--ink)" stroke-width="${th}"/>`);
      }
    } else {
      const maxB = Math.max(...group.map((n) => n.beams));
      for (let L = 1; L <= maxB; L++) {
        const y = STEM_BOT - (L - 1) * gap;
        let a = 0;
        while (a < group.length) {
          if (group[a].beams < L) { a++; continue; }
          let bb = a;
          while (bb + 1 < group.length && group[bb + 1].beams >= L) bb++;
          if (bb > a) {
            p.push(`<line x1="${sx(group[a])}" y1="${y}" x2="${sx(group[bb])}" y2="${y}" stroke="var(--ink)" stroke-width="${th}"/>`);
          } else {
            const dir = a > 0 && group[a - 1].beams >= L ? -1 : 1;
            p.push(`<line x1="${sx(group[a])}" y1="${y}" x2="${sx(group[a]) + dir * 8}" y2="${y}" stroke="var(--ink)" stroke-width="${th}"/>`);
          }
          a = bb + 1;
        }
      }
    }
    i = j + 1;
  }
}
