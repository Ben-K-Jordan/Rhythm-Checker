// The 40 Essential (PAS International) Drum Rudiments.
//
// Each rudiment is a rhythmic PHRASE spanning `grid * beats` slots, written as
// a space-separated token string (`seq`). One token per slot:
//   .        rest (no note in this slot)
//   R / L    a normal stroke with that hand
//   R!       an accented stroke  (trailing !)
//   fR / fL  a FLAM  (one grace note just before the primary)
//   dR / dL  a DRAG  (two grace notes just before the primary)
//   zR / zL  a BUZZ  (multiple-bounce stroke)
// accents combine with grace/buzz, e.g. `fR!`, `dL!`, `zR!`.
//
// `grid` = slots per quarter-note pulse (4 = 16ths, 3 = triplet 8ths,
// 6 = sextuplets, 8 = 32nds). `beats` is derived from the token count.
//
// The mic hears WHEN a stroke lands, not which hand — sticking letters are
// guidance, and grace notes (flams/drags/buzz) render for feel but are scored
// at their PRIMARY (the detector's refractory merges a flam into one onset).
//
// The accent editor is available on every rudiment (default 'built-in' shows
// its own written accents). `editable: true` is kept as a hint marking the
// pure single/double/paradiddle patterns whose whole point is free accent
// placement, but it no longer gates the editor.

function parseSeq(seq, grid) {
  const tokens = seq.trim().split(/\s+/);
  const notes = [];
  tokens.forEach((tok, slot) => {
    if (tok === '.') return;
    let t = tok;
    let grace = 0;
    let buzz = false;
    if (t[0] === 'f') { grace = 1; t = t.slice(1); }
    else if (t[0] === 'd') { grace = 2; t = t.slice(1); }
    else if (t[0] === 'z') { buzz = true; t = t.slice(1); }
    let accent = false;
    if (t.endsWith('!')) { accent = true; t = t.slice(0, -1); }
    const hand = t.toUpperCase();
    if (hand !== 'R' && hand !== 'L') throw new Error(`bad token "${tok}" in "${seq}"`);
    notes.push({ slot, hand, accent, grace, buzz });
  });
  return { notes, beats: tokens.length / grid, slots: tokens.length };
}

// [num, id, name, category, grid, seq, editable?]
const RAW = [
  // ---------------------------------------------------------- I. ROLLS
  // A. single-stroke
  [1, 'single-stroke-roll', 'Single Stroke Roll', 'roll', 4, 'R L R L R L R L', true],
  [2, 'single-stroke-four', 'Single Stroke Four', 'roll', 4, 'R! L R L L! R L R'],
  [3, 'single-stroke-seven', 'Single Stroke Seven', 'roll', 4, 'R! L R L R L R .'],
  // B. multiple bounce
  [4, 'multiple-bounce-roll', 'Multiple Bounce Roll', 'roll', 4, 'zR! zL zR zL zR! zL zR zL'],
  [5, 'triple-stroke-roll', 'Triple Stroke Roll', 'roll', 6, 'R R R L L L R R R L L L'],
  // C. double-stroke open rolls
  [6, 'double-stroke-roll', 'Double Stroke Open Roll', 'roll', 4, 'R R L L R R L L', true],
  [7, 'five-stroke-roll', 'Five Stroke Roll', 'roll', 8, 'R R L L R! . . .'],
  [8, 'six-stroke-roll', 'Six Stroke Roll', 'roll', 6, 'R! L L R R L!'],
  [9, 'seven-stroke-roll', 'Seven Stroke Roll', 'roll', 8, 'R R L L R R L! .'],
  [10, 'nine-stroke-roll', 'Nine Stroke Roll', 'roll', 8, 'R R L L R R L L R! . . . . . . .'],
  [11, 'ten-stroke-roll', 'Ten Stroke Roll', 'roll', 8, 'R R L L R R L L R! . . . L! . . .'],
  [12, 'eleven-stroke-roll', 'Eleven Stroke Roll', 'roll', 8, 'R R L L R R L L R R L! . . . . .'],
  [13, 'thirteen-stroke-roll', 'Thirteen Stroke Roll', 'roll', 8, 'R R L L R R L L R R L L R! . . .'],
  [14, 'fifteen-stroke-roll', 'Fifteen Stroke Roll', 'roll', 8, 'R R L L R R L L R R L L R R L! .'],
  [15, 'seventeen-stroke-roll', 'Seventeen Stroke Roll', 'roll', 8,
    'R R L L R R L L R R L L R R L L R! . . . . . . .'],

  // ------------------------------------------------------- II. DIDDLES
  [16, 'single-paradiddle', 'Single Paradiddle', 'diddle', 4, 'R! L R R L! R L L', true],
  [17, 'double-paradiddle', 'Double Paradiddle', 'diddle', 6, 'R! L R L R R L! R L R L L', true],
  [18, 'triple-paradiddle', 'Triple Paradiddle', 'diddle', 4,
    'R! L R L R L R R L! R L R L R L L', true],
  [19, 'paradiddle-diddle', 'Single Paradiddle-Diddle', 'diddle', 6, 'R! L R R L L', true],

  // --------------------------------------------------------- III. FLAMS
  [20, 'flam', 'Flam', 'flam', 4, 'fR! . . . fL! . . .'],
  [21, 'flam-accent', 'Flam Accent', 'flam', 3, 'fR! L R fL! R L'],
  [22, 'flam-tap', 'Flam Tap', 'flam', 4, 'fR! R fL! L fR! R fL! L'],
  [23, 'flamacue', 'Flamacue', 'flam', 4, 'fR L! R L fL R! L R'],
  [24, 'flam-paradiddle', 'Flam Paradiddle', 'flam', 4, 'fR! L R R fL! R L L'],
  [25, 'flammed-mill', 'Single Flammed Mill', 'flam', 4, 'fR! R L R fL! L R L'],
  [26, 'flam-paradiddle-diddle', 'Flam Paradiddle-Diddle', 'flam', 6,
    'fR! L R R L L fL! R L L R R'],
  [27, 'pataflafla', 'Pataflafla', 'flam', 4, 'fR! L R fL fR L R fL!'],
  [28, 'swiss-army-triplet', 'Swiss Army Triplet', 'flam', 3, 'fR! R L fL! L R'],
  [29, 'inverted-flam-tap', 'Inverted Flam Tap', 'flam', 4, 'R fL! L fR! R fL! L fR!'],
  [30, 'flam-drag', 'Flam Drag', 'flam', 3, 'fR! dL R fL! dR L'],

  // --------------------------------------------------------- IV. DRAGS
  [31, 'drag', 'Drag', 'drag', 4, 'dR! . . . dL! . . .'],
  [32, 'single-drag-tap', 'Single Drag Tap', 'drag', 4, 'dR . L! . dL . R! .'],
  [33, 'double-drag-tap', 'Double Drag Tap', 'drag', 6, 'dR . dL . R! . dL . dR . L! .'],
  [34, 'lesson-25', 'Lesson 25', 'drag', 6, 'dR . L . R! . dL . R . L! .'],
  [35, 'single-dragadiddle', 'Single Dragadiddle', 'drag', 4, 'R! dR L R L! dL R L'],
  [36, 'drag-paradiddle-1', 'Drag Paradiddle #1', 'drag', 4, 'R! dL R R L! dR L L'],
  [37, 'drag-paradiddle-2', 'Drag Paradiddle #2', 'drag', 4, 'R! dL R L R R L! dR L R L L'],
  [38, 'single-ratamacue', 'Single Ratamacue', 'drag', 3, 'dR L R! dL R L!'],
  [39, 'double-ratamacue', 'Double Ratamacue', 'drag', 3, 'dR L dR L R! . dL R dL R L! .'],
  [40, 'triple-ratamacue', 'Triple Ratamacue', 'drag', 3,
    'dR L dR L dR L R! . . dL R dL R dL R L! . .'],
];

export const CATEGORIES = [
  { id: 'roll', label: 'Roll Rudiments' },
  { id: 'diddle', label: 'Paradiddle Rudiments' },
  { id: 'flam', label: 'Flam Rudiments' },
  { id: 'drag', label: 'Drag Rudiments' },
];

export const RUDIMENTS = RAW.map(([num, id, name, cat, grid, seq, editable]) => {
  const { notes, beats, slots } = parseSeq(seq, grid);
  return { num, id, name, cat, grid, beats, slots, notes, editable: !!editable };
});

export function rudimentById(id) {
  return RUDIMENTS.find((r) => r.id === id) || RUDIMENTS[0];
}

// Structural self-check. The numbered rolls are objectively verifiable: an
// "N-Stroke Roll" must have exactly N primary strokes per phrase. Returns a
// list of problems (empty = clean). Machine-checked by the browser harness.
const STROKE_COUNT = {
  'five-stroke-roll': 5, 'six-stroke-roll': 6, 'seven-stroke-roll': 7,
  'nine-stroke-roll': 9, 'ten-stroke-roll': 10, 'eleven-stroke-roll': 11,
  'thirteen-stroke-roll': 13, 'fifteen-stroke-roll': 15, 'seventeen-stroke-roll': 17,
};
export function validateRudiments() {
  const errs = [];
  if (RUDIMENTS.length !== 40) errs.push(`expected 40 rudiments, got ${RUDIMENTS.length}`);
  const nums = RUDIMENTS.map((r) => r.num).sort((a, b) => a - b);
  for (let i = 1; i <= 40; i++) if (nums[i - 1] !== i) { errs.push(`numbering gap near ${i}`); break; }
  for (const r of RUDIMENTS) {
    if (!['roll', 'diddle', 'flam', 'drag'].includes(r.cat)) errs.push(`${r.id}: bad category ${r.cat}`);
    if (Math.round(r.beats) !== r.beats || r.beats < 1) errs.push(`${r.id}: non-integer beats ${r.beats}`);
    for (const n of r.notes) {
      if (n.slot >= r.slots || n.slot < 0) errs.push(`${r.id}: slot ${n.slot} out of range`);
      if (n.hand !== 'R' && n.hand !== 'L') errs.push(`${r.id}: bad hand`);
    }
    if (STROKE_COUNT[r.id] && r.notes.length !== STROKE_COUNT[r.id]) {
      errs.push(`${r.id}: ${r.notes.length} strokes, expected ${STROKE_COUNT[r.id]}`);
    }
  }
  return errs;
}
