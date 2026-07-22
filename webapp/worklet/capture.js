// AudioWorkletProcessor: ships raw mic blocks to the main thread with their
// position on the audio clock, so every onset is timestamped on the same
// clock the metronome schedules on.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = [];
    this.batchFrames = 0;
    this.batchStartFrame = -1;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      // If the audio clock skipped ahead (an input underrun dropped quanta),
      // the samples we've buffered are no longer contiguous with what's
      // arriving. Flush first so every posted batch is contiguous and its
      // startTime is exact — otherwise onsets after the gap mis-time.
      if (this.batchStartFrame >= 0 && currentFrame !== this.batchStartFrame + this.batchFrames) {
        this._flush();
      }
      if (this.batchStartFrame < 0) this.batchStartFrame = currentFrame;
      this.batch.push(new Float32Array(ch));
      this.batchFrames += ch.length;
      if (this.batchFrames >= 1024) this._flush();
    }
    return true;
  }

  _flush() {
    if (!this.batchFrames) return;
    const joined = new Float32Array(this.batchFrames);
    let off = 0;
    for (const b of this.batch) { joined.set(b, off); off += b.length; }
    this.port.postMessage(
      { samples: joined, startTime: this.batchStartFrame / sampleRate },
      [joined.buffer],
    );
    this.batch = [];
    this.batchFrames = 0;
    this.batchStartFrame = -1;
  }
}

registerProcessor('capture', CaptureProcessor);
