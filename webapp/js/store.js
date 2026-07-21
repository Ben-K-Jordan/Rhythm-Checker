// Local persistence: kit presets, tuning targets, timing baselines, latency
// calibration. localStorage only — nothing ever leaves the device.

const KEY = 'rhythm-checker-v1';

const DEFAULTS = {
  calibrationMs: null,          // measured system latency; null = not calibrated
  pocketMs: 10,
  tuneToleranceCents: 10,       // pre-show pass window per drum
  judgeMode: 'standard',        // 'standard' | 'pro'
  lugCount: 6,
  kit: [
    // {id, name, targetHz|null}
    { id: 'snare', name: 'Snare', targetHz: null },
    { id: 'tom1', name: 'Rack Tom', targetHz: null },
    { id: 'floor', name: 'Floor Tom', targetHz: null },
    { id: 'kick', name: 'Kick', targetHz: null },
  ],
  baseline: null,               // {bpm, subdivision, mean, sd, pocketPct, date}
  preferredBpm: 120,
  grooveRud: null,              // {bpm, meterId, grouping}
  grooveTiming: null,
  runs: [],                     // every completed session, append-only (capped)
  show: null,                   // armed show ritual: {armedAt, stageTime, drums, hands}
};

const MAX_RUNS = 500;

// Field-by-field validation: a drifted or hand-edited backup must degrade to
// defaults per field, never half-brick the whole app on the next launch.
function sanitize(data) {
  const clean = structuredClone(DEFAULTS);
  if (typeof data !== 'object' || data === null) return clean;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const numOrNull = (v) => (v === null ? null : num(v));

  const cal = numOrNull(data.calibrationMs);
  if (cal !== undefined) clean.calibrationMs = cal;
  for (const key of ['pocketMs', 'tuneToleranceCents', 'lugCount', 'preferredBpm']) {
    const v = num(data[key]);
    if (v !== undefined) clean[key] = v;
  }
  if (data.judgeMode === 'standard' || data.judgeMode === 'pro') clean.judgeMode = data.judgeMode;
  if (Array.isArray(data.kit)) {
    const kit = data.kit.filter((d) => d && typeof d === 'object'
      && typeof d.id === 'string' && typeof d.name === 'string'
      && (d.targetHz === null || num(d.targetHz) !== undefined))
      .map((d) => ({ id: d.id, name: d.name, targetHz: d.targetHz }));
    if (kit.length) clean.kit = kit;
  }
  const b = data.baseline;
  if (b && typeof b === 'object'
    && [b.bpm, b.subdivision, b.mean, b.sd, b.pocketPct].every((v) => num(v) !== undefined)) {
    clean.baseline = { ...b };
  }
  for (const key of ['grooveRud', 'grooveTiming']) {
    const g = data[key];
    if (g && typeof g === 'object' && num(g.bpm) !== undefined) clean[key] = { ...g };
  }
  if (Array.isArray(data.runs)) {
    clean.runs = data.runs
      .filter((r) => r && typeof r === 'object' && num(r.sd) !== undefined && num(r.mean) !== undefined)
      .slice(-MAX_RUNS);
  }
  const s = data.show;
  if (s && typeof s === 'object' && num(s.armedAt) !== undefined && num(s.stageTime) !== undefined) {
    clean.show = {
      armedAt: s.armedAt,
      stageTime: s.stageTime,
      drums: s.drums && typeof s.drums === 'object' ? s.drums : null,
      hands: s.hands && typeof s.hands === 'object' ? s.hands : null,
    };
  }
  return clean;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    return sanitize(JSON.parse(raw));
  } catch {
    return structuredClone(DEFAULTS);
  }
}

let state = load();

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch { /* storage full/blocked: keep running in memory */ }
}

export const store = {
  get: (key) => state[key],
  set(key, value) {
    state[key] = value;
    persist();
  },
  updateDrum(id, patch) {
    state.kit = state.kit.map((d) => (d.id === id ? { ...d, ...patch } : d));
    persist();
  },
  addDrum(name) {
    const id = `drum-${Date.now()}`;
    state.kit = [...state.kit, { id, name, targetHz: null }];
    persist();
    return id;
  },
  removeDrum(id) {
    state.kit = state.kit.filter((d) => d.id !== id);
    persist();
  },
  addRun(run) {
    state.runs = [...(state.runs || []), { date: new Date().toISOString(), ...run }];
    if (state.runs.length > MAX_RUNS) state.runs = state.runs.slice(-MAX_RUNS);
    persist();
  },
  exportKitJson() {
    return JSON.stringify({ rhythmCheckerKit: state.kit }, null, 2);
  },
  // merge another player's targets by drum name; never touches baseline,
  // history, or calibration — those are personal
  importKitJson(text) {
    const data = JSON.parse(text);
    const kit = data.rhythmCheckerKit || data.kit;
    if (!Array.isArray(kit)) throw new Error('not a kit-targets file');
    for (const d of kit) {
      if (!d || typeof d.name !== 'string'
        || (d.targetHz !== null && typeof d.targetHz !== 'number')) continue;
      const mine = state.kit.find((x) => x.name.toLowerCase() === d.name.toLowerCase());
      if (mine) mine.targetHz = d.targetHz;
      else {
        state.kit = [...state.kit,
          { id: `drum-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: d.name, targetHz: d.targetHz }];
      }
    }
    state.kit = [...state.kit];
    persist();
  },
  exportJson() {
    return JSON.stringify(state, null, 2);
  },
  importJson(text) {
    const data = JSON.parse(text); // throws on garbage — caller shows the error
    if (typeof data !== 'object' || data === null || !Array.isArray(data.kit)) {
      throw new Error('not a Rhythm Checker backup file');
    }
    const current = state;
    state = sanitize(data);
    // latency is a property of THIS device's audio chain, not of the backup:
    // carrying it across devices would silently skew every timing score
    state.calibrationMs = current.calibrationMs;
    persist();
  },
  reset() {
    state = structuredClone(DEFAULTS);
    persist();
  },
};
