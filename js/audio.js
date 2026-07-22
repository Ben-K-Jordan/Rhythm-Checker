// Microphone engine: one AudioContext, worklet capture, a ring buffer of the
// last two seconds, and onset events timestamped on the audio clock.

import { OnsetDetector } from './dsp.js';

export class MicEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.running = false;
    this.level = 0;
    this._ring = null;
    this._ringStart = 0; // audio time of ring[0]
    this._detector = null;
    this._stream = null;
    this._workletLoaded = false;
    this._detectorLock = null; // a running session owns the detector config
    this._watchHealth();
  }

  get audioContext() {
    return this.ctx;
  }

  async start() {
    if (this.running) return;
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
    } catch (err) {
      throw new Error(
        'Microphone access was blocked. Allow the mic in your browser settings ' +
        `and reload. (${err.name || err})`,
      );
    }
    this._stream = stream;
    this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
    });
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (!this._workletLoaded) {
      await this.ctx.audioWorklet.addModule('worklet/capture.js');
      this._workletLoaded = true;
    }
    const src = this.ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(this.ctx, 'capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
    });
    src.connect(node);

    const sr = this.ctx.sampleRate;
    this._ring = new Float32Array(2 * sr);
    this._ringStart = 0;
    this._detector = new OnsetDetector(sr);
    node.port.onmessage = (e) => this._onBlock(e.data, sr);
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => this._lost('the microphone was taken away'));
      track.addEventListener('mute', () => this._lost('the microphone went silent'));
    }
    this.running = true;
    this.dispatchEvent(new Event('started'));
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
    if (ctxDead || trackDead) this._lost('audio was interrupted');
  }

  _lost(reason) {
    if (!this.running) return;
    this.running = false;
    this.dispatchEvent(new CustomEvent('lost', { detail: { reason } }));
  }

  // must be called from a user gesture (the reconnect tap)
  async reconnect() {
    if (this._stream) {
      for (const track of this._stream.getTracks()) track.stop();
      this._stream = null;
    }
    this.running = false;
    if (this.ctx && this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { /* recreated below via start() */ }
    }
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

  _apply({ refractory, threshold, minLevel } = {}) {
    if (!this._detector) return;
    if (refractory !== undefined) this._detector.refractory = refractory;
    if (threshold !== undefined) this._detector.threshold = threshold;
    // a user-set trigger floor (Calibrate, step 1) rides above every mode's
    // own minLevel: room noise below the TRIG line never fires a hit
    if (minLevel !== undefined) {
      this._detector.minLevel = Math.max(minLevel, this.triggerFloor || 0);
    }
  }

  setTriggerFloor(level) {
    this.triggerFloor = level || 0;
    if (this._detector) {
      this._detector.minLevel = Math.max(this._detector.minLevel, this.triggerFloor);
    }
  }

  _onBlock({ samples, startTime }, sr) {
    // ring buffer append (ring holds the most recent 2 s, contiguous)
    const ring = this._ring;
    if (samples.length >= ring.length) return;
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

  // Samples for [fromTime, fromTime+duration), or null if not (yet) buffered.
  grabWindow(fromTime, duration) {
    if (!this._ring) return null;
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
      this._lock = await navigator.wakeLock.request('screen');
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
