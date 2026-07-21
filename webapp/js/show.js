// Live show monitor: the click runs in your in-ears, the mic hears the kit,
// every hit is judged against the grid for the whole set. Songs are split on
// long silences (walking to the next tune), and the set ends in one honest
// verdict: DIALED or NOT YET, with per-song drift to back it up.

import { Metronome } from './metronome.js';
import { BleedGuard, summarize } from './dsp.js';
import { store } from './store.js';
import { wakeLock } from './audio.js';

const SONG_GAP_S = 8;        // silence this long = next song
const HOLD_TOL_MS = 40;      // a hit inside this window "held" the tempo
const DIALED_HELD_PCT = 75;  // hold at least this much of the set to stamp DIALED

export class ArmedSession extends EventTarget {
  constructor(mic, { bpm, subdivision = 1 }) {
    super();
    this.mic = mic;
    this.metro = new Metronome(mic.audioContext);
    this.metro.bpm = bpm;
    this.metro.subdivision = subdivision;
    this.metro.meter = { pulses: 4, accents: [0] };
    this.running = false;
    this.songs = [[]];       // devMs lists, one per song
    this.lastHitT = null;
    this.peakDriftMs = 0;
    this._recent = [];
    this._onOnset = (e) => this._score(e.detail);
  }

  start() {
    this.running = true;
    this.startedAt = this.mic.now();
    this.bleed = new BleedGuard();
    this._lostHandler = () => {
      this.dispatchEvent(new CustomEvent('miclost'));
    };
    this.mic.addEventListener('lost', this._lostHandler);
    this.mic.lockDetector(this, { refractory: 0.03, threshold: 4, minLevel: 0.01 });
    this.mic.addEventListener('onset', this._onOnset);
    wakeLock.acquire();
    this.metro.start();
  }

  elapsed() {
    return this.running ? this.mic.now() - this.startedAt : 0;
  }

  _score(onset) {
    if (!this.running) return;
    const cal = (store.get('calibrationMs') || 0) / 1000;
    const t = onset.time - cal;
    if (t < this.metro.startTime + 2 * (60 / this.metro.bpm)) return;
    const grid = this.metro.nearestGrid(t);
    if (!grid) return;
    const devMs = (t - grid.time) * 1000;
    const nearClick = Math.abs(devMs) <= 30 && grid.index % this.metro.subdivision === 0;
    if (this.bleed.shouldDrop(onset.level || 0, nearClick)) return;
    const maxDev = 0.4 * this.metro.gridInterval() * 1000;
    if (Math.abs(devMs) > maxDev) return; // between grid lines: not attributable
    if (this.lastHitT !== null && t - this.lastHitT >= SONG_GAP_S) {
      this.songs.push([]);
      this.dispatchEvent(new CustomEvent('song', { detail: { index: this.songs.length - 1 } }));
    }
    this.lastHitT = t;
    this.songs[this.songs.length - 1].push(devMs);
    this._recent.push(devMs);
    if (this._recent.length > 16) this._recent.shift();
    const rolling = this._recent.reduce((a, b) => a + b, 0) / this._recent.length;
    if (Math.abs(rolling) > Math.abs(this.peakDriftMs)) this.peakDriftMs = rolling;
    this.dispatchEvent(new CustomEvent('hit', {
      detail: { devMs, rollingMs: rolling, song: this.songs.length - 1 },
    }));
  }

  liveStats() {
    const all = this.songs.flat();
    const held = all.length
      ? (100 * all.filter((d) => Math.abs(d) <= HOLD_TOL_MS).length) / all.length
      : null;
    return {
      hits: all.length,
      heldPct: held,
      peakDriftMs: this.peakDriftMs,
      song: this.songs.length,
      rollingMs: this._recent.length
        ? this._recent.reduce((a, b) => a + b, 0) / this._recent.length
        : null,
    };
  }

  // Stop listening and produce the verdict. Honest rules, stated plainly:
  // DIALED means you were inside ±40 ms for at least 75% of the set's hits.
  finish() {
    if (!this.running) return null;
    this._teardown();
    const perSong = this.songs
      .filter((s) => s.length >= 4) // a couple of stray hits is not a song
      .map((devs, i) => {
        const s = summarize(devs);
        return {
          song: i + 1,
          n: devs.length,
          meanMs: +s.mean.toFixed(1),
          heldPct: +((100 * devs.filter((d) => Math.abs(d) <= HOLD_TOL_MS).length) / devs.length).toFixed(0),
        };
      });
    const all = this.songs.flat();
    if (!all.length) return { empty: true, elapsedS: this.mic.now() - this.startedAt };
    const stats = summarize(all);
    const heldPct = (100 * all.filter((d) => Math.abs(d) <= HOLD_TOL_MS).length) / all.length;
    const byTight = [...perSong].sort((a, b) => Math.abs(a.meanMs) - Math.abs(b.meanMs));
    return {
      result: heldPct >= DIALED_HELD_PCT ? 'DIALED' : 'NOT YET',
      bpm: this.metro.bpm,
      elapsedS: this.mic.now() - this.startedAt,
      n: all.length,
      meanMs: +stats.mean.toFixed(1),
      sdMs: +stats.sd.toFixed(1),
      heldPct: +heldPct.toFixed(0),
      peakDriftMs: +this.peakDriftMs.toFixed(1),
      tightest: byTight[0] || null,
      loosest: byTight[byTight.length - 1] || null,
      perSong,
      warning: this.bleed.warning(),
    };
  }

  cancel() {
    this._teardown();
  }

  _teardown() {
    this.running = false;
    this.metro.stop();
    this.mic.removeEventListener('onset', this._onOnset);
    if (this._lostHandler) this.mic.removeEventListener('lost', this._lostHandler);
    this.mic.unlockDetector(this);
    wakeLock.release();
  }
}
