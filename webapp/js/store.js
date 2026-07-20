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
};

const MAX_RUNS = 500;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const data = JSON.parse(raw);
    return { ...structuredClone(DEFAULTS), ...data };
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
  exportJson() {
    return JSON.stringify(state, null, 2);
  },
  importJson(text) {
    const data = JSON.parse(text); // throws on garbage — caller shows the error
    if (typeof data !== 'object' || data === null || !Array.isArray(data.kit)) {
      throw new Error('not a Rhythm Checker backup file');
    }
    state = { ...structuredClone(DEFAULTS), ...data };
    persist();
  },
  reset() {
    state = structuredClone(DEFAULTS);
    persist();
  },
};
