// Pure DSP — no audio nodes, no DOM. Mirrors the Python engine's math so the
// same ground-truth tests can pin it (see selftest() at the bottom).

export const PITCH_MIN_HZ = 40;
export const PITCH_MAX_HZ = 1000;
export const PEAK_FLOOR_DB = 18;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function hzToNote(freq) {
  const midi = 69 + 12 * Math.log2(freq / 440);
  const n = Math.round(midi);
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

export function centsBetween(freq, reference) {
  return 1200 * Math.log2(freq / reference);
}

// ---------------------------------------------------------------------------
// FFT: iterative radix-2 Cooley-Tukey, in-place on re/im pairs.

export function fftInPlace(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('fft size must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

export function magnitudeSpectrum(samples, nFft) {
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  re.set(samples.subarray(0, Math.min(samples.length, nFft)));
  fftInPlace(re, im);
  const half = nFft / 2 + 1;
  const mags = new Float64Array(half);
  for (let i = 0; i < half; i++) mags[i] = Math.hypot(re[i], im[i]);
  return mags;
}

// ---------------------------------------------------------------------------
// Pitch: fundamental of a drum's ring. Drumheads ring inharmonic overtones
// (~1.59x, 2.14x...) that can out-shout the fundamental, so the answer is the
// LOWEST spectral peak within PEAK_FLOOR_DB of the strongest — never simply
// the loudest bin. Returns null when the window isn't a sustained tone;
// a wrong number would be worse than no number.

// `preSamples` (the moment just before the tap, same length) lets the gate
// reject peaks that were already ringing pre-onset — mains hum and monitor
// bleed are tonal and sustained, but they are not the drum.
export function estimatePitch(samples, sampleRate, preSamples = null) {
  if (samples.length < 0.1 * sampleRate) return null;

  // sustained-ring gate: >=5 blocks of 20 ms at >=10% of the loudest block
  const block = Math.max(1, Math.floor(0.02 * sampleRate));
  const nBlocks = Math.floor(samples.length / block);
  let maxRms = 0;
  const rms = new Float64Array(nBlocks);
  for (let b = 0; b < nBlocks; b++) {
    let acc = 0;
    for (let i = b * block; i < (b + 1) * block; i++) acc += samples[i] * samples[i];
    rms[b] = Math.sqrt(acc / block);
    if (rms[b] > maxRms) maxRms = rms[b];
  }
  if (maxRms <= 0) return null;
  let sustained = 0;
  for (let b = 0; b < nBlocks; b++) if (rms[b] >= 0.1 * maxRms) sustained++;
  if (sustained < 5) return null;

  const windowed = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    windowed[i] = samples[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (samples.length - 1)));
  }
  const nFft = 2 ** Math.ceil(Math.log2(windowed.length)) * 4;
  const mags = magnitudeSpectrum(windowed, nFft);
  const binHz = sampleRate / nFft;
  const lo = Math.max(1, Math.ceil(PITCH_MIN_HZ / binHz));
  const hi = Math.min(mags.length - 2, Math.floor(PITCH_MAX_HZ / binHz));
  if (hi - lo < 8) return null;

  let maxMag = 0;
  const sorted = [];
  for (let i = lo; i <= hi; i++) {
    if (mags[i] > maxMag) maxMag = mags[i];
    sorted.push(mags[i]);
  }
  if (maxMag <= 0) return null;
  sorted.sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (maxMag < 10 * median) return null; // broadband noise, not a ring

  let preMags = null;
  if (preSamples && preSamples.length >= 0.1 * sampleRate) {
    const n = Math.min(preSamples.length, windowed.length);
    const preWin = new Float64Array(windowed.length);
    for (let i = 0; i < n; i++) {
      preWin[i] = preSamples[preSamples.length - n + i]
        * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
    }
    preMags = magnitudeSpectrum(preWin, nFft);
  }

  const floor = maxMag * 10 ** (-PEAK_FLOOR_DB / 20);
  let peak = -1;
  for (let i = lo; i <= hi; i++) {
    if (mags[i] >= floor && mags[i] >= mags[i - 1] && mags[i] >= mags[i + 1]) {
      if (preMags && preMags[i] >= 0.6 * mags[i]) continue; // pre-existing tone
      peak = i;
      break; // lowest qualifying peak born at the tap = fundamental
    }
  }
  if (peak < 1) return null;

  // a stronger peak below the measurable band means the true fundamental is
  // sub-40 Hz and this peak is merely an overtone — admit ignorance instead
  const subLo = Math.max(1, Math.ceil(20 / binHz));
  for (let i = subLo; i < lo; i++) {
    if (mags[i] >= mags[peak]) return null;
  }

  const y0 = Math.log(mags[peak - 1] + 1e-12);
  const y1 = Math.log(mags[peak] + 1e-12);
  const y2 = Math.log(mags[peak + 1] + 1e-12);
  const denom = y0 - 2 * y1 + y2;
  let shift = Math.abs(denom) > 1e-12 ? (0.5 * (y0 - y2)) / denom : 0;
  shift = Math.max(-0.5, Math.min(0.5, shift));
  return (peak + shift) * binHz;
}

// ---------------------------------------------------------------------------
// Streaming onset detection for live scoring. Envelope follower: a fast
// tracker jumping over a slow floor = a hit. Sub-block refinement gives ~1 ms;
// device latency is constant and removed by calibration.

export class OnsetDetector {
  // A hit is a RISE: the envelope jumping well above where it sat a few
  // milliseconds ago. A ring, however long, only ever decays — so gating on
  // the rise (instead of inflating an adaptive floor after each hit, which
  // made earlier versions go deaf to 16ths and ghost notes) keeps equal and
  // softer hits detectable at any practice tempo without retriggering on
  // ringy drums.
  constructor(sampleRate, { refractory = 0.03, threshold = 4, minLevel = 0.01 } = {}) {
    this.sampleRate = sampleRate;
    this.refractory = refractory;
    this.threshold = threshold;
    this.minLevel = minLevel;
    this.slow = 1e-4;
    this.lastOnset = -Infinity;
    this.block = Math.max(16, Math.round(sampleRate * 0.0029)); // ~2.9 ms
    this._recent = [0, 0, 0, 0]; // fast values of the previous 4 blocks (~12 ms)
    this._warmup = 5;            // seed the floor before the first decision
    this._pending = null;        // onset maturing its level reading
    this._matureBlocks = Math.max(1, Math.round(0.025 / (this.block / sampleRate)));
    this._carry = null;          // unconsumed tail of the previous feed()
    this._carryTime = 0;
  }

  // samples: Float32Array; startTime: audio-clock seconds of samples[0].
  // Returns [{time, strength, level}] — possibly empty. Emission lags the hit
  // by ~25 ms so `level` (peak block RMS of the attack, the honest loudness
  // proxy for accent analysis) covers the whole attack, not its first 3 ms.
  feed(samples, startTime) {
    if (this._carry && this._carry.length) {
      const joined = new Float32Array(this._carry.length + samples.length);
      joined.set(this._carry, 0);
      joined.set(samples, this._carry.length);
      startTime = this._carryTime;
      samples = joined;
    }
    const out = [];
    let off = 0;
    for (; off + this.block <= samples.length; off += this.block) {
      let peak = 0;
      let acc = 0;
      for (let i = off; i < off + this.block; i++) {
        const a = Math.abs(samples[i]);
        acc += a * a;
        if (a > peak) peak = a;
      }
      const fast = Math.sqrt(acc / this.block);
      const t = startTime + off / this.sampleRate;

      if (this._pending) {
        this._pending.level = Math.max(this._pending.level, fast);
        if (--this._pending.blocksLeft <= 0) {
          out.push({ time: this._pending.time, strength: this._pending.strength, level: this._pending.level });
          this._pending = null;
        }
      }

      const recentMax = Math.max(...this._recent);
      if (this._warmup > 0) {
        // first blocks establish the floor; a steady signal present from
        // sample zero must not read as a phantom hit
        this._warmup--;
        this.slow = Math.max(this.slow, fast);
      } else if (
        fast > this.minLevel &&
        fast > this.threshold * this.slow &&
        fast >= 2.0 * recentMax &&
        t - this.lastOnset >= this.refractory
      ) {
        let hit = off;
        const gate = 0.5 * peak;
        for (let i = off; i < off + this.block; i++) {
          if (Math.abs(samples[i]) >= gate) { hit = i; break; }
        }
        this.lastOnset = startTime + hit / this.sampleRate;
        if (this._pending) { // flush an unmatured predecessor (tight flam)
          out.push({ time: this._pending.time, strength: this._pending.strength, level: this._pending.level });
        }
        this._pending = {
          time: this.lastOnset,
          strength: fast / Math.max(this.slow, 1e-6),
          level: fast,
          blocksLeft: this._matureBlocks,
        };
      } else {
        // asymmetric floor: drops fast in the gaps between hits, climbs only
        // slowly during a ring — so a long decay can't wall off the next hit
        const alpha = fast < this.slow ? 0.1 : 0.005;
        this.slow += alpha * (fast - this.slow);
        this.slow = Math.max(this.slow, 1e-5);
      }
      this._recent.shift();
      this._recent.push(fast);
    }
    this._carry = off < samples.length ? samples.slice(off) : null;
    this._carryTime = startTime + off / this.sampleRate;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Click-bleed guard: with echo cancellation off (necessary for drums), the
// mic hears the app's own metronome. A bleed "hit" lands near a click time at
// a level far below real drum hits — drop those once real hits establish a
// level, and disclose when a stretch of the session looks like bleed-only.

export class BleedGuard {
  constructor() {
    this._hitLevels = []; // recent accepted, clearly-real hit levels
    this.suspected = 0;
  }

  // nearClick: onset within ~±30 ms of a scheduled click. Returns true when
  // the onset should be DROPPED as probable metronome bleed.
  shouldDrop(level, nearClick) {
    const median = this._median();
    if (nearClick && median !== null && level < 0.15 * median) {
      this.suspected++;
      return true;
    }
    if (!nearClick || median === null || level >= 0.5 * median) {
      this._hitLevels.push(level);
      if (this._hitLevels.length > 12) this._hitLevels.shift();
    }
    return false;
  }

  _median() {
    if (this._hitLevels.length < 4) return null;
    const s = [...this._hitLevels].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  warning() {
    return this.suspected >= 3
      ? `${this.suspected} quiet hits landing exactly on clicks were ignored as `
        + 'probable metronome bleed — lower the click volume or move the phone '
        + 'if that seems wrong'
      : null;
  }
}

// ---------------------------------------------------------------------------
// Hit judgement for the trainer, shared with the pre-show check.

export const JUDGE_WINDOWS = {
  standard: { perfect: 20, good: 40, ok: 60 },
  pro: { perfect: 12, good: 25, ok: 40 },
};

export function judgeHit(devMs, windows = JUDGE_WINDOWS.standard) {
  const a = Math.abs(devMs);
  if (a <= windows.perfect) return 'perfect';
  if (a <= windows.good) return 'good';
  if (a <= windows.ok) return 'ok';
  return 'miss';
}

export function summarize(devsMs) {
  if (!devsMs.length) return null;
  const mean = devsMs.reduce((a, b) => a + b, 0) / devsMs.length;
  const varAcc = devsMs.reduce((a, b) => a + (b - mean) ** 2, 0);
  const sd = devsMs.length > 1 ? Math.sqrt(varAcc / (devsMs.length - 1)) : 0;
  const sortedD = [...devsMs].sort((a, b) => a - b);
  const mid = Math.floor(sortedD.length / 2);
  const median = sortedD.length % 2 // matches np.median (the Python engine)
    ? sortedD[mid]
    : (sortedD[mid - 1] + sortedD[mid]) / 2;
  return { n: devsMs.length, mean, median, sd };
}

// ---------------------------------------------------------------------------
// In-browser ground-truth checks, run by Playwright and the diagnostics view.

export function selftest() {
  const failures = [];
  const check = (name, cond) => { if (!cond) failures.push(name); };
  const sr = 48000;

  { // FFT: pure sine lands its energy in the right bin
    const n = 4096;
    const s = new Float32Array(n);
    const f = 187.5; // exactly bin 16 at 48k/4096
    for (let i = 0; i < n; i++) s[i] = Math.sin((2 * Math.PI * f * i) / sr);
    const mags = magnitudeSpectrum(s, n);
    let best = 0;
    for (let i = 1; i < mags.length; i++) if (mags[i] > mags[best]) best = i;
    check('fft-sine-bin', best === 16);
  }

  { // pitch: inharmonic drum tone with louder overtones, across the kit range
    const modes = [[1.0, 1.0], [1.59, 1.3], [2.14, 0.6]];
    for (const f0 of [55, 110, 141, 196, 330]) {
      const dur = 0.35;
      const s = new Float32Array(Math.floor(dur * sr));
      for (let i = 0; i < s.length; i++) {
        const t = i / sr;
        for (const [ratio, amp] of modes) {
          s[i] += amp * Math.exp(-t / (0.3 / ratio)) * Math.sin(2 * Math.PI * f0 * ratio * t);
        }
      }
      const got = estimatePitch(s, sr);
      check(`pitch-${f0}`, got !== null && Math.abs(got - f0) < 0.7);
    }
  }

  { // pitch: noise must yield null, damped thud must yield null
    const noise = new Float32Array(Math.floor(0.35 * sr));
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
    for (let i = 0; i < noise.length; i++) noise[i] = 0.1 * rand();
    check('pitch-noise-null', estimatePitch(noise, sr) === null);
    const thud = new Float32Array(Math.floor(0.35 * sr));
    for (let i = 0; i < Math.floor(0.04 * sr); i++) {
      thud[i] = Math.exp(-i / (0.01 * sr)) * Math.sin((2 * Math.PI * 120 * i) / sr);
    }
    check('pitch-damped-null', estimatePitch(thud, sr) === null);
  }

  { // onset detector: the regimes an earlier version went deaf in, plus
    // false-positive controls — every case must stay exact
    const synth = (hits, ring, dur) => {
      const s = new Float32Array(Math.floor(dur * sr));
      let seed = 7;
      const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
      for (let i = 0; i < s.length; i++) s[i] = 0.002 * rand();
      for (const { t, a } of hits) {
        const start = Math.floor(t * sr);
        const n = Math.min(Math.floor(ring * 6 * sr), s.length - start);
        for (let i = 0; i < n; i++) {
          s[start + i] += a * Math.exp(-i / (ring * sr)) * Math.sin((2 * Math.PI * 800 * i) / sr);
        }
      }
      return s;
    };
    const detect = (s) => {
      const det = new OnsetDetector(sr);
      const found = [];
      for (let off = 0; off < s.length; off += 1024) {
        found.push(...det.feed(s.subarray(off, Math.min(off + 1024, s.length)), off / sr));
      }
      return found;
    };
    const grid = (bpm, div, n, amp) => Array.from(
      { length: n }, (_, i) => ({ t: 0.4 + (i * 60) / bpm / div, a: amp ? amp(i) : 0.8 }),
    );
    const regimes = [
      ['16ths@200', synth(grid(200, 4, 32), 0.005, 3.2), 32],
      ['ring-16ths@120', synth(grid(120, 4, 32), 0.05, 4.6), 32],
      ['accents+taps@160', synth(grid(160, 4, 24, (i) => (i % 4 === 0 ? 0.9 : 0.3)), 0.005, 3), 24],
      ['ghosts-after-accents', synth(
        [].concat(...Array.from({ length: 6 }, (_, k) => [
          { t: 0.4 + k * 0.6, a: 0.9 }, { t: 0.52 + k * 0.6, a: 0.15 },
        ])), 0.005, 4.2), 12],
      ['fp-ringy-singles', synth(grid(60, 1, 6), 0.2, 6.5), 6],
      ['fp-noise-only', synth([], 0.005, 2), 0],
    ];
    for (const [name, s, expect] of regimes) {
      check(`onset-${name}`, detect(s).length === expect);
    }
    const truthHits = grid(120, 4, 32);
    const found = detect(synth(truthHits, 0.005, 4.6));
    check('onset-count', found.length === truthHits.length);
    if (found.length === truthHits.length) {
      const worst = Math.max(...found.map((o, i) => Math.abs(o.time - truthHits[i].t) * 1000));
      check('onset-accuracy-2ms', worst < 2);
    }
    // steady tone from sample zero must not fire a phantom first-block onset
    const tone = new Float32Array(2 * sr);
    for (let i = 0; i < tone.length; i++) tone[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr);
    check('onset-no-first-block-phantom', detect(tone).length === 0);
    check('summarize-median-even-n', summarize([1, 2, 3, 10]).median === 2.5);
  }

  { // onset level: a half-amplitude hit reports ~half the level (accents rely on this)
    const dur = 2;
    const s = new Float32Array(dur * sr);
    const place = (t0, amp) => {
      const start = Math.floor(t0 * sr);
      for (let i = 0; i < Math.floor(0.05 * sr); i++) {
        s[start + i] += amp * Math.exp(-i / (0.005 * sr)) * Math.sin((2 * Math.PI * 800 * i) / sr);
      }
    };
    place(0.4, 0.8);
    place(0.9, 0.4);
    const det = new OnsetDetector(sr);
    const found = [];
    for (let off = 0; off + 1024 <= s.length; off += 1024) {
      found.push(...det.feed(s.subarray(off, off + 1024), off / sr));
    }
    const ratio = found.length === 2 ? found[1].level / found[0].level : 0;
    check('onset-level-ratio', found.length === 2 && ratio > 0.35 && ratio < 0.65);
  }

  { // judgement windows and honest summary
    check('judge-perfect', judgeHit(-15) === 'perfect');
    check('judge-good', judgeHit(33) === 'good');
    check('judge-miss', judgeHit(75) === 'miss');
    const s = summarize([-10, 0, 10]);
    check('summary', s.n === 3 && Math.abs(s.mean) < 1e-9 && Math.abs(s.sd - 10) < 1e-9);
  }

  return { passed: failures.length === 0, failures };
}
