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

export function estimatePitch(samples, sampleRate) {
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

  const floor = maxMag * 10 ** (-PEAK_FLOOR_DB / 20);
  let peak = -1;
  for (let i = lo; i <= hi; i++) {
    if (mags[i] >= floor && mags[i] >= mags[i - 1] && mags[i] >= mags[i + 1]) {
      peak = i;
      break; // lowest qualifying peak = fundamental
    }
  }
  if (peak < 1) return null;

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
  constructor(sampleRate, { refractory = 0.03, threshold = 4, minLevel = 0.01 } = {}) {
    this.sampleRate = sampleRate;
    this.refractory = refractory;
    this.threshold = threshold;
    this.minLevel = minLevel;
    this.slow = 1e-4;
    this.lastOnset = -Infinity;
    this.block = Math.max(16, Math.round(sampleRate * 0.0029)); // ~2.9 ms
    this.slowAlpha = 0.02; // slow floor adapts over ~50 blocks (~150 ms)
  }

  // samples: Float32Array; startTime: audio-clock seconds of samples[0].
  // Returns [{time, strength}] — possibly empty.
  feed(samples, startTime) {
    const out = [];
    for (let off = 0; off + this.block <= samples.length; off += this.block) {
      let peak = 0;
      let acc = 0;
      for (let i = off; i < off + this.block; i++) {
        const a = Math.abs(samples[i]);
        acc += a * a;
        if (a > peak) peak = a;
      }
      const fast = Math.sqrt(acc / this.block);
      const t = startTime + off / this.sampleRate;
      if (
        fast > this.minLevel &&
        fast > this.threshold * this.slow &&
        t - this.lastOnset >= this.refractory
      ) {
        let hit = off;
        const gate = 0.5 * peak;
        for (let i = off; i < off + this.block; i++) {
          if (Math.abs(samples[i]) >= gate) { hit = i; break; }
        }
        this.lastOnset = startTime + hit / this.sampleRate;
        out.push({ time: this.lastOnset, strength: fast / Math.max(this.slow, 1e-6) });
        this.slow = Math.max(this.slow, fast * 0.5); // decay ≠ second onset
      } else {
        this.slow += this.slowAlpha * (fast - this.slow);
        this.slow = Math.max(this.slow, 1e-5);
      }
    }
    return out;
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
  const median = sortedD[Math.floor(sortedD.length / 2)];
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

  { // onset detector: click train recovered with ms accuracy
    const dur = 3;
    const s = new Float32Array(dur * sr);
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
    for (let i = 0; i < s.length; i++) s[i] = 0.002 * rand();
    const truth = [];
    for (let k = 0; k < 10; k++) {
      const t0 = 0.3 + k * 0.25;
      truth.push(t0);
      const start = Math.floor(t0 * sr);
      for (let i = 0; i < Math.floor(0.05 * sr); i++) {
        s[start + i] += Math.exp(-i / (0.005 * sr)) * Math.sin((2 * Math.PI * 800 * i) / sr);
      }
    }
    const det = new OnsetDetector(sr);
    const found = [];
    const chunk = 1024;
    for (let off = 0; off + chunk <= s.length; off += chunk) {
      found.push(...det.feed(s.subarray(off, off + chunk), off / sr));
    }
    check('onset-count', found.length === truth.length);
    if (found.length === truth.length) {
      const worst = Math.max(...found.map((o, i) => Math.abs(o.time - truth[i]) * 1000));
      check('onset-accuracy-4ms', worst < 4);
    }
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
