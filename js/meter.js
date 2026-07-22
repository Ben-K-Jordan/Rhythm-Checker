// Meters, tempo maps, and tap tempo — pure functions, no audio, no DOM.
//
// BPM convention (shown in the UI as ♩= or ♪=): BPM is the rate of the
// meter's pulse unit — the quarter note in /4 meters, the eighth in /8
// meters. That is what you set on a metronome for those meters, so it is
// what you set here.

export const METERS = [
  { id: '4/4', label: '4/4', unit: 4, pulses: 4, groupings: { '4': [0] } },
  { id: '3/4', label: '3/4', unit: 4, pulses: 3, groupings: { '3': [0] } },
  { id: '2/4', label: '2/4', unit: 4, pulses: 2, groupings: { '2': [0] } },
  { id: '5/4', label: '5/4', unit: 4, pulses: 5, groupings: { '3+2': [0, 3], '2+3': [0, 2] } },
  { id: '6/8', label: '6/8', unit: 8, pulses: 6, groupings: { '3+3': [0, 3] } },
  { id: '7/8', label: '7/8', unit: 8, pulses: 7, groupings: { '2+2+3': [0, 2, 4], '3+2+2': [0, 3, 5], '2+3+2': [0, 2, 5] } },
  { id: '9/8', label: '9/8', unit: 8, pulses: 9, groupings: { '3+3+3': [0, 3, 6] } },
  { id: '12/8', label: '12/8', unit: 8, pulses: 12, groupings: { '3+3+3+3': [0, 3, 6, 9] } },
];

export function meterById(id) {
  return METERS.find((m) => m.id === id) || METERS[0];
}

export function defaultGrouping(meter) {
  return Object.keys(meter.groupings)[0];
}

export function accentsFor(meter, grouping) {
  return meter.groupings[grouping] || meter.groupings[defaultGrouping(meter)];
}

export function unitGlyph(meter) {
  return meter.unit === 8 ? '♪' : '♩';
}

// ---------------------------------------------------------------------------
// Tempo map: precomputed times for a finite chart, with an optional ramp
// ("+addBpm every everyBars bars, capped at maxBpm"). All offsets are seconds
// relative to chart start.

export function buildChartTimes({ bpm, meter, grouping, sub, bars, ramp = null }) {
  const accents = accentsFor(meter, grouping);
  const steps = [];
  const clicks = [];
  const barOffsets = [];
  const segments = [];
  let t = 0;
  let curBpm = bpm;
  for (let bar = 0; bar < bars; bar++) {
    if (ramp && bar > 0 && bar % ramp.everyBars === 0) {
      curBpm = Math.min(ramp.maxBpm || 400, curBpm + ramp.addBpm);
    }
    if (!segments.length || segments[segments.length - 1].bpm !== curBpm) {
      segments.push({ bar, bpm: curBpm, offset: t });
    }
    barOffsets.push(t);
    const pulseDur = 60 / curBpm;
    for (let p = 0; p < meter.pulses; p++) {
      clicks.push({ offset: t + p * pulseDur, accent: accents.includes(p) });
      for (let s = 0; s < sub; s++) {
        steps.push(t + p * pulseDur + (s * pulseDur) / sub);
      }
    }
    t += meter.pulses * pulseDur;
  }
  return { steps, clicks, barOffsets, segments, total: t };
}

export function segmentAt(segments, offset) {
  let cur = segments[0];
  for (const s of segments) {
    if (s.offset <= offset + 1e-9) cur = s;
    else break;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Tap tempo: feed timestamps (seconds); returns the BPM implied by the median
// of the recent intervals, or null until there are enough taps. A gap longer
// than 2 s starts a fresh measurement.

export class TapTempo {
  constructor() {
    this.taps = [];
  }

  tap(time) {
    if (this.taps.length && time - this.taps[this.taps.length - 1] > 2) this.taps = [];
    this.taps.push(time);
    if (this.taps.length > 6) this.taps.shift();
    if (this.taps.length < 3) return null;
    const gaps = [];
    for (let i = 1; i < this.taps.length; i++) gaps.push(this.taps[i] - this.taps[i - 1]);
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    return Math.max(20, Math.min(400, Math.round(60 / median)));
  }

  reset() {
    this.taps = [];
  }
}
