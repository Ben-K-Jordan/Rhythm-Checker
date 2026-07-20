// Sample-accurate metronome: the standard Web Audio lookahead scheduler.
// Clicks are placed on the audio clock ahead of time, so UI jank can never
// move a beat. The schedule doubles as the scoring grid.

export class Metronome {
  constructor(ctx) {
    this.ctx = ctx;
    this.bpm = 120;
    this.subdivision = 1;    // grid lines per beat (clicks play on beats only)
    this.accentEvery = 4;    // beats per bar
    this.running = false;
    this._timer = null;
    this._nextGrid = 0;      // next grid index to schedule
    this._startTime = 0;
    this.schedule = [];      // {time, index, isBeat, isAccent} — scoring grid
    this._lookahead = 0.12;  // seconds scheduled ahead
    this._interval = 25;     // ms between scheduler runs
    this.gain = 0.5;
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
      const beatIndex = Math.floor(this._nextGrid / this.subdivision);
      const isAccent = isBeat && beatIndex % this.accentEvery === 0;
      if (isBeat) this._click(t, isAccent);
      this.schedule.push({ time: t, index: this._nextGrid, isBeat, isAccent });
      if (this.schedule.length > 4096) this.schedule.splice(0, 1024);
      this._nextGrid++;
    }
  }

  _click(time, accent) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.frequency.value = accent ? 1318 : 880;
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(this.gain, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(time);
    osc.stop(time + 0.06);
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
