// Local persistence: kit presets, tuning targets, timing baselines, latency
// calibration. localStorage only — nothing ever leaves the device.

const KEY = 'rhythm-checker-v1';

const DEFAULTS = {
  calibrationMs: null,          // measured system latency; null = not calibrated
  pocketMs: 10,
  tuneToleranceCents: 10,       // tuner in-tune window per drum
  judgeMode: 'standard',        // 'standard' | 'pro'
  lugCount: 6,
  feel: null,                   // 'bonham' | 'barker' | 'jordison' | 'haake' | null — kit voicing preset
  metronomeSound: 'woodblock',  // 'woodblock' | 'beep' | 'rim'
  showGrades: false,            // honest default: numbers, not grades
  trigger: null,                // user-set detector floor (level units), null = auto
  kit: [
    // {id, name, targetHz|null} — Ben's kit (depth x diameter), targets set
    // for a tight high-crack snare pop (Cunningham/Jordison territory)
    { id: 'snare', name: 'Snare 5.5x14', targetHz: 260, resoHz: 390 },
    { id: 'rack10', name: 'Rack 8x10', targetHz: 165, resoHz: 196 },
    { id: 'rack12', name: 'Rack 9x12', targetHz: 135, resoHz: 161 },
    { id: 'floor16', name: 'Floor 14x16', targetHz: 90, resoHz: 107 },
    { id: 'kick22', name: 'Kick 18x22', targetHz: 60, resoHz: 63 },
    { id: 'rack8', name: 'Rack 7x8 (sometimes)', targetHz: 195, resoHz: 232 },
    { id: 'floor16b', name: 'Floor 16x16 (sometimes)', targetHz: 82, resoHz: 98 },
  ],
  baseline: null,               // {bpm, subdivision, mean, sd, pocketPct, date}
  preferredBpm: 120,
  grooveRud: null,              // {bpm, meterId, grouping}
  grooveTiming: null,
  runs: [],                     // every completed session, append-only (capped)
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
  if (data.feel === null || ['bonham', 'barker', 'jordison', 'haake'].includes(data.feel)) clean.feel = data.feel ?? null;
  if (['woodblock', 'beep', 'rim'].includes(data.metronomeSound)) clean.metronomeSound = data.metronomeSound;
  if (typeof data.showGrades === 'boolean') clean.showGrades = data.showGrades;
  const trig = numOrNull(data.trigger);
  if (trig !== undefined) clean.trigger = trig;
  if (Array.isArray(data.kit)) {
    // ids are app-generated ('snare', 'drum-<ts>') and land in HTML attributes
    // — a backup id with quotes/spaces would break out of the attribute and
    // desync the rename/delete handlers, so enforce the generated shape
    const kit = data.kit.filter((d) => d && typeof d === 'object'
      && typeof d.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(d.id)
      && typeof d.name === 'string'
      && (d.targetHz === null || num(d.targetHz) !== undefined))
      .map((d) => ({ id: d.id, name: d.name, targetHz: d.targetHz,
        resoHz: d.resoHz === null || num(d.resoHz) !== undefined ? (d.resoHz ?? null) : null }));
    // an explicitly empty kit is a choice and stays empty; an array whose
    // entries were all garbage is corruption and degrades to defaults
    if (kit.length || data.kit.length === 0) clean.kit = kit;
  }
  // baseline and grooves are REBUILT field-by-field, never spread: a backup
  // is attacker-controllable text, and grouping/meterId render into HTML and
  // drive grid math — anything not shaped like '7/8' / '2+2+3' is dropped
  const b = data.baseline;
  if (b && typeof b === 'object'
    && [b.bpm, b.subdivision, b.mean, b.sd, b.pocketPct].every((v) => num(v) !== undefined)) {
    clean.baseline = { bpm: b.bpm, subdivision: b.subdivision, mean: b.mean, sd: b.sd, pocketPct: b.pocketPct };
    if (typeof b.date === 'string' && !Number.isNaN(Date.parse(b.date))) clean.baseline.date = b.date;
  }
  for (const key of ['grooveRud', 'grooveTiming']) {
    const g = data[key];
    if (!g || typeof g !== 'object' || num(g.bpm) === undefined) continue;
    const groove = { bpm: g.bpm };
    if (typeof g.meterId === 'string' && /^\d{1,2}\/\d{1,2}$/.test(g.meterId)) groove.meterId = g.meterId;
    if (typeof g.grouping === 'string' && /^\d{1,2}(\+\d{1,2}){0,7}$/.test(g.grouping)) groove.grouping = g.grouping;
    clean[key] = groove;
  }
  if (Array.isArray(data.runs)) {
    clean.runs = data.runs
      .filter((r) => r && typeof r === 'object' && num(r.sd) !== undefined && num(r.mean) !== undefined)
      // a run's date must be a real parseable string — an epoch number is
      // coerced, anything else is dropped (a bad date once aborted boot).
      // getTime() is the throw-free validity probe: toISOString() on an
      // out-of-range epoch (|ms| > 8.64e15) throws and would abort the import
      .map((r) => {
        if (num(r.date) === undefined) return r;
        const d = new Date(r.date);
        return Number.isNaN(d.getTime()) ? { ...r, date: null } : { ...r, date: d.toISOString() };
      })
      .filter((r) => typeof r.date === 'string' && !Number.isNaN(Date.parse(r.date)))
      // accuracy feeds .toFixed() in the history badge — a non-number here
      // (hand-edited backup) must degrade to "no badge", not a crash
      .map((r) => (r.accuracy == null || num(r.accuracy) !== undefined ? r : { ...r, accuracy: undefined }))
      .slice(-MAX_RUNS);
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
      if (mine) {
        mine.targetHz = d.targetHz;
        if (d.resoHz === null || typeof d.resoHz === 'number') mine.resoHz = d.resoHz;
      }
      else {
        state.kit = [...state.kit,
          { id: `drum-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: d.name, targetHz: d.targetHz }];
      }
    }
    state.kit = [...state.kit];
    persist();
  },
  exportJson() {
    // latency AND the trigger floor are properties of THIS device's audio
    // chain (its mic, its room), never of the backup — importJson ignores
    // any imported value, but don't even write them, so the "never travels
    // with a backup" promise holds literally.
    const { calibrationMs, trigger, ...rest } = state;
    return JSON.stringify(rest, null, 2);
  },
  importJson(text) {
    const data = JSON.parse(text); // throws on garbage — caller shows the error
    if (typeof data !== 'object' || data === null || !Array.isArray(data.kit)) {
      throw new Error('not a Rhythm Checker backup file');
    }
    const current = state;
    state = sanitize(data);
    // device-local values stay: carrying latency or the detector floor across
    // devices would silently skew every timing score on this one
    state.calibrationMs = current.calibrationMs;
    state.trigger = current.trigger;
    persist();
  },
  reset() {
    state = structuredClone(DEFAULTS);
    persist();
  },
};
