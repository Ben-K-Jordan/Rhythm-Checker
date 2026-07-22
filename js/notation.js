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

function gcd(a, b) { return b ? gcd(b, a % b) : a; }

// Written value of a note from the fraction of a beat it lasts (span / grid),
// reduced — so it's correct in BOTH binary grids (4, 8) and tuplet grids
// (3, 6). Keyed num/den: a whole triplet beat is a plain quarter (3/3 -> 1/1),
// not a dotted quarter; a 2/3 note is a quarter-note triplet, and so on.
// [beams (flags), dotted].
const VALUE = {
  '1/1': [0, false],  // quarter
  '1/2': [1, false],  // 8th
  '1/4': [2, false],  // 16th
  '1/8': [3, false],  // 32nd
  '1/3': [1, false],  // 8th-note triplet
  '1/6': [2, false],  // 16th-note sextuplet
  '2/3': [0, false],  // quarter-note triplet
  '3/4': [1, true],   // dotted 8th
  '3/8': [2, true],   // dotted 16th
  '3/16': [3, true],  // dotted 32nd
};

function valueOf(span, grid) {
  const g = gcd(span, grid);
  const [beams, dot] = VALUE[`${span / g}/${grid / g}`] || [0, false];
  return { beams, dot };
}

// A beat's real tuplet number: how many equal parts the notes actually divide
// it into. Three evenly-spaced notes in a sextuplet grid are a triplet (3),
// not a sextuplet (6); a single note filling the beat is no tuplet at all.
function tupletOf(grid, sibs) {
  let g = grid;
  for (const s of sibs) if (s) g = gcd(g, s);
  const eff = grid / g;
  return eff === 3 || eff === 6 ? eff : null;
}

// Pure musical interpretation of a rudiment, independent of any drawing: the
// beats, each a list of notes with their written duration (beams + dot),
// grace/buzz/accent, or a rest. Exposed so it can be audited directly.
export function notationModel(rud, opts = {}) {
  const accentOf = opts.accentOf || ((n) => n.accent);
  const { grid, beats } = rud;
  const perBeat = Array.from({ length: beats }, () => []);
  rud.notes.forEach((n, idx) => {
    perBeat[Math.floor(n.slot / grid)].push({ ...n, idx, sib: n.slot % grid });
  });
  return perBeat.map((raw, b) => {
    const ns = raw.sort((a, z) => a.sib - z.sib);
    if (!ns.length) return { beat: b, rest: true, notes: [] };
    const notes = ns.map((n, k) => {
      const nextSib = k + 1 < ns.length ? ns[k + 1].sib : grid;
      const v = valueOf(nextSib - n.sib, grid);
      return {
        idx: n.idx, sib: n.sib, span: nextSib - n.sib, hand: n.hand,
        beams: v.beams, dot: v.dot, grace: n.grace, buzz: n.buzz,
        accent: !!accentOf(n, n.idx),
      };
    });
    return { beat: b, rest: false, tuplet: tupletOf(grid, ns.map((n) => n.sib)), notes };
  });
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

  const model = notationModel(rud, { accentOf });

  const p = [];
  // staff line
  p.push(`<line x1="${padL - 8}" y1="${LY}" x2="${width - 8}" y2="${LY}" stroke="var(--ink)" stroke-width="1.4"/>`);
  // faint beat separators
  for (let b = 1; b < beats; b++) {
    p.push(`<line x1="${beatX(b)}" y1="${LY - 15}" x2="${beatX(b)}" y2="${LY + 15}" stroke="var(--line)" stroke-width="1"/>`);
  }

  for (const beat of model) {
    const b = beat.beat;
    if (beat.rest) { // a beat with no onset reads as a quarter rest
      const cx = beatX(b) + beatW * 0.5;
      p.push(`<path d="M ${cx - 3} ${LY - 13} L ${cx + 3} ${LY - 6} L ${cx - 3} ${LY - 1} L ${cx + 4} ${LY + 7}" fill="none" stroke="var(--ink)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`);
      continue;
    }
    const ns = beat.notes.map((n) => ({ ...n, x: noteX(b, n.sib) }));
    if (beat.tuplet) {
      p.push(`<text x="${beatX(b) + beatW * 0.5}" y="${LY - 25}" text-anchor="middle" font-family="var(--mono-font)" font-size="11" fill="var(--dim)">${beat.tuplet}</text>`);
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
      if (n.accent) {
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
