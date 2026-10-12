// Microphone engine: one AudioContext, worklet capture, a ring buffer of the
// last two seconds, and onset events timestamped on the audio clock.

import { OnsetDetector } from './dsp.js';

export class MicEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.running = false;
    this._starting = false;  // a start() in flight — reject overlapping calls
    this.level = 0;
    this._ring = null;
    this._ringStart = 0;     // audio time of ring[0]
    this._ringValidFrom = Infinity; // ring contents before this are stale/zeros
    this._lastBlockEnd = null;
    this._detector = null;
    this._stream = null;
    this._src = null;        // current graph nodes, torn down on restart
    this._node = null;
    this._workletLoaded = false;
    this._detectorLock = null; // a running session owns the detector config
    this._lastOpts = null;     // last detector config, reapplied on reconnect
    this._baseMinLevel = 0.01; // mode's own floor, before the user trigger rides it
    this._watchHealth();
  }

  get audioContext() {
    return this.ctx;
  }

  async start() {
    if (this.running || this._starting) return; // a second tap mid-start must not open a second pipeline
    this._starting = true;
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false, // these three eat drum transients
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
          },
        });
      } catch {
        throw new Error('The mic is blocked. In iPhone Settings, allow the microphone for Safari, then reopen the app.');
      }
      this._stream = stream;
      await this._ensureContext();
      this._teardownGraph(); // orphans from a previous run on a surviving context
      const src = this.ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(this.ctx, 'capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      });
      src.connect(node);
      this._src = src;
      this._node = node;

      const sr = this.ctx.sampleRate;
      this._ring = new Float32Array(2 * sr);
      this._ringStart = 0;
      this._ringValidFrom = Infinity; // no captured audio yet — the first block sets it
      this._lastBlockEnd = null;
      this._detector = new OnsetDetector(sr);
      // a reconnect must not silently reset the active mode's detector config
      // or the user's calibrated trigger floor — reapply what was in force
      this._apply(this._lastOpts || {});
      node.port.onmessage = (e) => this._onBlock(e.data, sr);
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => this._lost('Another app took the mic.'));
        track.addEventListener('mute', () => this._lost('The mic went silent.'));
      }
      this.running = true;
      this.dispatchEvent(new Event('started'));
    } finally {
      this._starting = false;
    }
  }

  _teardownGraph() {
    if (this._node) {
      try { this._node.port.postMessage('stop'); } catch { /* context already gone */ }
      try { this._node.port.onmessage = null; this._node.disconnect(); } catch { /* already gone */ }
    }
    if (this._src) { try { this._src.disconnect(); } catch { /* already gone */ } }
    this._node = null;
    this._src = null;
  }

  // A context iOS has closed (or wedged in its non-standard 'interrupted'
  // state after a call / Siri / media-server reset) can never be resumed —
  // resume() either rejects forever or never settles. Try a bounded resume,
  // then tear down and rebuild. The worklet registry dies with its context,
  // so 'capture' must be re-registered on the new one.
  async _ensureContext() {
    if (this.ctx && this.ctx.state !== 'closed') {
      try {
        await Promise.race([
          this.ctx.resume(),
          new Promise((_, rej) => { setTimeout(() => rej(new Error('resume timed out')), 1000); }),
        ]);
      } catch { /* fall through to the rebuild */ }
    }
    if (!this.ctx || this.ctx.state !== 'running') {
      try { if (this.ctx) await this.ctx.close(); } catch { /* already closed */ }
      this.ctx = null;
      this._workletLoaded = false;
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: 'interactive',
      });
      if (this.ctx.state !== 'running') {
        // the fresh context needs the same bound — an unbounded await here
        // would hang the reconnect tap forever with no error surfaced
        await Promise.race([
          this.ctx.resume(),
          new Promise((_, rej) => {
            setTimeout(() => rej(new Error('Audio did not restart. Tap RECONNECT to try again.')), 1500);
          }),
        ]);
      }
    }
    if (!this._workletLoaded) {
      await this.ctx.audioWorklet.addModule('worklet/capture.js');
      this._workletLoaded = true;
    }
  }

  // iOS suspends the AudioContext and kills mic tracks on screen lock, app
  // switch, calls, and Siri — and does not reliably restore them. Watch for
  // it and surface a reconnect path instead of a dead-looking app.
  _watchHealth() {
    const checkSoon = () => setTimeout(() => this._checkHealth(), 350);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkSoon();
    });
    window.addEventListener('pageshow', checkSoon);
  }

  _checkHealth() {
    if (!this.running) return;
    const ctxDead = this.ctx && this.ctx.state !== 'running';
    const trackDead = this._stream
      && this._stream.getTracks().some((t) => t.readyState === 'ended' || t.muted);
    if (ctxDead || trackDead) this._lost('iPhone paused the audio: a call, the lock screen or another app.');
  }

  _lost(reason) {
    if (!this.running) return;
    this.running = false;
    this.dispatchEvent(new CustomEvent('lost', { detail: { reason } }));
  }

  // must be called from a user gesture (the reconnect tap); start() →
  // _ensureContext() resumes the context or rebuilds it if it's dead
  async reconnect() {
    if (this._starting) return; // a reconnect is already in flight
    if (this._stream) {
      for (const track of this._stream.getTracks()) track.stop();
      this._stream = null;
    }
    this.running = false;
    await this.start();
  }

  // A running session locks the detector config so a mid-run tab switch
  // can't clobber it (the tuner's 300 ms refractory would swallow every
  // other eighth note at 120 BPM).
  lockDetector(token, opts) {
    this._detectorLock = token;
    this._apply(opts);
  }

  unlockDetector(token) {
    if (this._detectorLock === token) this._detectorLock = null;
  }

  setDetectorOptions(opts = {}) {
    if (this._detectorLock) return;
    this._apply(opts);
  }

  _apply(opts = {}) {
    const { refractory, threshold, minLevel } = opts;
    this._lastOpts = { ...this._lastOpts, ...opts }; // survives a reconnect's fresh detector
    if (!this._detector) return;
    if (refractory !== undefined) this._detector.refractory = refractory;
    if (threshold !== undefined) this._detector.threshold = threshold;
    // a user-set trigger floor (Calibrate, step 1) rides above every mode's
    // own minLevel: room noise below the TRIG line never fires a hit
    if (minLevel !== undefined) {
      this._baseMinLevel = minLevel;
      this._detector.minLevel = Math.max(minLevel, this.triggerFloor || 0);
    }
  }

  setTriggerFloor(level) {
    this.triggerFloor = level || 0;
    if (this._detector) {
      // rebuild from the mode's own floor, not the current effective value —
      // maxing against the latter would ratchet: lowering or clearing the
      // TRIG line in Calibrate would never actually lower the live floor
      this._detector.minLevel = Math.max(this._baseMinLevel, this.triggerFloor);
    }
  }

  _onBlock({ samples, startTime }, sr) {
    // ring buffer append (ring holds the most recent 2 s, contiguous)
    const ring = this._ring;
    if (samples.length >= ring.length) return;
    // a dropped input quantum (or a fresh start) breaks contiguity: samples
    // already in the ring predate the gap, so serving them under post-gap
    // timestamps would hand out time-shifted audio as if it were real —
    // remember where valid audio begins and let grabWindow refuse the rest
    if (this._lastBlockEnd === null || Math.abs(startTime - this._lastBlockEnd) > 64 / sr) {
      this._ringValidFrom = startTime;
    }
    this._lastBlockEnd = startTime + samples.length / sr;
    ring.copyWithin(0, samples.length);
    ring.set(samples, ring.length - samples.length);
    this._ringStart = startTime + samples.length / sr - ring.length / sr;

    let acc = 0;
    for (let i = 0; i < samples.length; i++) acc += samples[i] * samples[i];
    this.level = Math.sqrt(acc / samples.length);

    for (const onset of this._detector.feed(samples, startTime)) {
      this.dispatchEvent(new CustomEvent('onset', { detail: onset }));
    }
  }

  // Samples for [fromTime, fromTime+duration), or null if not (yet) buffered
  // — including audio from before a capture gap: null over wrong.
  grabWindow(fromTime, duration) {
    if (!this._ring) return null;
    if (fromTime < this._ringValidFrom) return null;
    const sr = this.ctx.sampleRate;
    const start = Math.round((fromTime - this._ringStart) * sr);
    const n = Math.round(duration * sr);
    if (start < 0 || start + n > this._ring.length) return null;
    return this._ring.slice(start, start + n);
  }

  now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }
}

// Screen wake lock for the duration of a session: iOS auto-lock (30 s default)
// would otherwise fire mid hands-check while both hands hold sticks.
export class SessionWakeLock {
  constructor() {
    this._lock = null;
    this._want = false;
    document.addEventListener('visibilitychange', () => {
      if (this._want && document.visibilityState === 'visible') this._request();
    });
  }

  async acquire() {
    this._want = true;
    await this._request();
  }

  async _request() {
    if (!('wakeLock' in navigator)) return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!this._want) { // released while the request was in flight
        lock.release().catch(() => {});
        return;
      }
      this._lock = lock;
    } catch { /* low battery or unsupported: the session still runs */ }
  }

  release() {
    this._want = false;
    if (this._lock) {
      this._lock.release().catch(() => {});
      this._lock = null;
    }
  }
}

export const wakeLock = new SessionWakeLock();
