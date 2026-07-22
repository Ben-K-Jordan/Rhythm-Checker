// Feel presets: whole-kit voicings anchored to a player's sound, sized to
// YOUR drums. Selecting a feel writes real batter/reso targets per drum
// (diameter-interpolated), and the home hub + tuner both read it.

import { store } from './store.js';

export const FEELS = {
  bonham: {
    label: 'BONHAM', genre: 'HEAVY GROOVE', bpm: '72–96 BPM', defaultBpm: 84,
    tone: {
      tom: { 8: 190, 10: 160, 12: 130, 14: 105, 16: 85, 18: 72 },
      snare: { 13: 235, 14: 215 },
      kick: { 18: 58, 20: 55, 22: 52, 24: 48, 26: 45 },
    },
    reso: { tom: 1.06, snare: 1.42, kick: 1.02 },
    voice: 'OPEN & BOOMY',
    // the hand-to-foot "Bonham triplet" (L-R-K) and his shuffle fills are SINGLE
    // strokes — single-stroke roll/four/seven, plus paradiddles for the grooves
    vocab: ['single-stroke-roll', 'single-stroke-four', 'single-stroke-seven', 'single-paradiddle', 'double-paradiddle'],
  },
  barker: {
    label: 'BARKER', genre: 'PUNK SPEED', bpm: '150–190', defaultBpm: 170,
    tone: {
      tom: { 8: 210, 10: 175, 12: 145, 14: 112, 16: 95, 18: 80 },
      snare: { 13: 320, 14: 300 },
      kick: { 18: 72, 20: 68, 22: 65, 24: 60 },
    },
    reso: { tom: 1.19, snare: 1.5, kick: 1.05 },
    voice: 'HIGH & TIGHT',
    // drumline heritage: paradiddles (his backbone), the six-stroke roll he
    // favors for cascading fills, warm-up flams, and fast single strokes
    vocab: ['single-paradiddle', 'double-paradiddle', 'six-stroke-roll', 'flam-tap', 'single-stroke-roll'],
  },
  jordison: {
    label: 'JORDISON', genre: 'BLAST METAL', bpm: '200+', defaultBpm: 200,
    tone: {
      tom: { 8: 220, 10: 185, 12: 155, 14: 120, 16: 105, 18: 88 },
      snare: { 13: 290, 14: 265 },
      kick: { 18: 75, 20: 71, 22: 68, 24: 62 },
    },
    reso: { tom: 1.19, snare: 1.5, kick: 1.08 },
    voice: 'DEEP & DRY',
    // his cornerstones: the paradiddle split hand/foot over the double bass
    // (Surfacing, Purity), blazing single-stroke rolls, and flams for weight
    vocab: ['single-paradiddle', 'paradiddle-diddle', 'single-stroke-roll', 'flam', 'flam-tap'],
  },
};

export function roleOf(name) {
  const n = name.toLowerCase();
  if (n.includes('snare')) return 'snare';
  if (n.includes('kick') || n.includes('bass')) return 'kick';
  if (n.includes('floor') || n.includes('rack') || n.includes('tom')) return 'tom';
  return null;
}

// "8x10" / "5.5x14" -> diameter (the second number, depth x diameter)
export function diameterOf(name) {
  const m = name.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/i);
  return m ? +m[2] : null;
}

const ROLE_DEFAULT_DIA = { tom: 12, snare: 14, kick: 22 };

export function toneHz(feel, role, dia) {
  const curve = FEELS[feel].tone[role];
  const keys = Object.keys(curve).map(Number).sort((a, b) => a - b);
  if (dia <= keys[0]) return curve[keys[0]];
  if (dia >= keys[keys.length - 1]) return curve[keys[keys.length - 1]];
  let lo = keys[0];
  for (const k of keys) {
    if (k <= dia) lo = k;
    else return Math.round(curve[lo] + ((dia - lo) / (k - lo)) * (curve[k] - curve[lo]));
  }
  return curve[lo];
}

// Select a feel: remember it and write real targets onto the kit.
// Returns how many drums matched a role (0 = nothing was retuned).
export function applyFeel(feelId) {
  const feel = FEELS[feelId];
  if (!feel) return 0;
  store.set('feel', feelId);
  // seed this player's working tempo — their ballpark, you nudge from there.
  // preferredBpm feeds Timing + Pre-show; grooveRud.bpm overrides it in
  // Rudiments, so move that too when it exists.
  if (feel.defaultBpm) {
    store.set('preferredBpm', feel.defaultBpm);
    const gr = store.get('grooveRud');
    if (gr) store.set('grooveRud', { ...gr, bpm: feel.defaultBpm });
  }
  let hits = 0;
  for (const d of store.get('kit')) {
    const role = roleOf(d.name);
    if (!role) continue;
    const dia = diameterOf(d.name) || ROLE_DEFAULT_DIA[role];
    const batter = toneHz(feelId, role, dia);
    store.updateDrum(d.id, {
      targetHz: batter,
      resoHz: Math.round(batter * feel.reso[role]),
    });
    hits++;
  }
  return hits;
}

// The feel's target for one drum+head (for the tuner's preset stack display).
export function feelTargetFor(feelId, drum, head = 'batter') {
  const role = roleOf(drum.name);
  if (!role) return null;
  const dia = diameterOf(drum.name) || ROLE_DEFAULT_DIA[role];
  const batter = toneHz(feelId, role, dia);
  return head === 'reso' ? Math.round(batter * FEELS[feelId].reso[role]) : batter;
}
