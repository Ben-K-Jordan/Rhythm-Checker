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
    this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
    });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    await this.ctx.audioWorklet.addModule('worklet/capture.js');
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
    this.running = true;
    this.dispatchEvent(new Event('started'));
  }

  setDetectorOptions({ refractory, threshold, minLevel } = {}) {
    if (!this._detector) return;
    if (refractory !== undefined) this._detector.refractory = refractory;
    if (threshold !== undefined) this._detector.threshold = threshold;
    if (minLevel !== undefined) this._detector.minLevel = minLevel;
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
