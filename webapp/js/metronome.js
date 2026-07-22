// Sample-accurate metronome: the standard Web Audio lookahead scheduler.
// Clicks are placed on the audio clock ahead of time, so UI jank can never
// move a beat. The schedule doubles as the scoring grid.

import { store } from './store.js';

// Click voices, synthesized — no samples to load, identical timing behavior.
// 'woodblock': short resonant knock; 'beep': the plain sine; 'rim': a bright
// noise tick that cuts through headphone bleed the least.
export function playClick(ctx, time, accent, gain) {
  const voice = store.get('metronomeSound') || 'beep';
  const g = ctx.createGain();
  g.connect(ctx.destination);
  if (voice === 'rim') {
    const len = Math.ceil(ctx.sampleRate * 0.03);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = accent ? 3800 : 2600;
    g.gain.setValueAtTime(gain, time);
    src.connect(hp).connect(g);
    src.start(time);
    return;
  }
  const osc = ctx.createOscillator();
  if (voice === 'woodblock') {
    osc.frequency.setValueAtTime(accent ? 1150 : 820, time);
    osc.frequency.exponentialRampToValueAtTime(accent ? 780 : 560, time + 0.02);
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(gain * 1.05, time + 0.0008); // headroom so a loud click won't clip
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.035);
  } else {
    osc.frequency.value = accent ? 1318 : 880;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(gain, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
  }
  osc.connect(g);
  osc.start(time);
  osc.stop(time + 0.06);
}

export class Metronome {
  constructor(ctx) {
    this.ctx = ctx;
    this.bpm = 120;          // rate of the meter's pulse unit (♩ in /4, ♪ in /8)
    this.subdivision = 1;    // grid lines per pulse (clicks play on pulses only)
    this.meter = { pulses: 4, accents: [0] };
    this.running = false;
    this._timer = null;
    this._nextGrid = 0;      // next grid index to schedule
    this._startTime = 0;
    this.schedule = [];      // {time, index, isBeat, isAccent} — scoring grid
    this._lookahead = 0.12;  // seconds scheduled ahead
    this._interval = 25;     // ms between scheduler runs
    this.gain = 0.9; // loud enough to cut through a practice pad / kit
  }

  gridInterval() {
    return 60 / this.bpm / this.subdivision;
  }

  start(delay = 0.15) {
    if (this.running) return;
    this.running = true;
    this._startTime = this.ctx.currentTime + delay;
    this._nextGrid = 0;
    this.schedule = [];
    this._tick();
    this._timer = setInterval(() => this._tick(), this._interval);
  }

  stop() {
    this.running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  get startTime() {
    return this._startTime;
  }

  _tick() {
    const horizon = this.ctx.currentTime + this._lookahead;
    while (true) {
      const t = this._startTime + this._nextGrid * this.gridInterval();
      if (t > horizon) break;
      const isBeat = this._nextGrid % this.subdivision === 0;
      const pulseIndex = Math.floor(this._nextGrid / this.subdivision);
      const isAccent = isBeat
        && this.meter.accents.includes(pulseIndex % this.meter.pulses);
      if (isBeat) this._click(t, isAccent);
      this.schedule.push({ time: t, index: this._nextGrid, isBeat, isAccent });
      if (this.schedule.length > 4096) this.schedule.splice(0, 1024);
      this._nextGrid++;
    }
  }

  _click(time, accent) {
    playClick(this.ctx, time, accent, this.gain);
  }

  // Nearest grid line to an (already calibration-corrected) hit time.
  nearestGrid(t) {
    if (!this.schedule.length) return null;
    const interval = this.gridInterval();
    const idx = Math.round((t - this._startTime) / interval);
    if (idx < 0) return null;
    return { time: this._startTime + idx * interval, index: idx };
  }

  beatPhase(now) {
    const beat = 60 / this.bpm;
    const rel = (now - this._startTime) / beat;
    return rel - Math.floor(rel);
  }
}

// ---------------------------------------------------------------------------
// ChartPlayer: plays a *precomputed* click list (from meter.buildChartTimes)
// with the same lookahead pattern. Tempo ramps live in the precomputed
// offsets, so mid-run tempo changes stay sample-accurate.

export class ChartPlayer {
  constructor(ctx, clicks) {
    this.ctx = ctx;
    this.clicks = clicks; // [{offset, accent}] relative to t0
    this.running = false;
    this.t0 = 0;
    this.gain = 0.9; // loud enough to cut through a practice pad / kit
    this._next = 0;
    this._timer = null;
    this._lookahead = 0.12;
  }

  start(delay = 0.15) {
    if (this.running) return;
    this.running = true;
    this.t0 = this.ctx.currentTime + delay;
    this._next = 0;
    this._tick();
    this._timer = setInterval(() => this._tick(), 25);
  }

  stop() {
    this.running = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _tick() {
    const horizon = this.ctx.currentTime + this._lookahead;
    while (this._next < this.clicks.length) {
      const c = this.clicks[this._next];
      const t = this.t0 + c.offset;
      if (t > horizon) break;
      this._click(t, c.accent);
      this._next++;
    }
    if (this._next >= this.clicks.length) this.stop();
  }

  _click(time, accent) {
    playClick(this.ctx, time, accent, this.gain);
  }
}
