// Calibrate, two steps made simple:
//  1) MIC INPUT — a live level meter; one AUTO button sets the trigger floor
//     just above room noise (drag to fine-tune). Below the line never counts.
//  2) AUDIO LATENCY — a guided test: a big dot flashes ON every click, you hit
//     with it, dots fill as your taps land, and the median tap-vs-click offset
//     is this phone's lag, subtracted from every future score.

import { Metronome } from './metronome.js';
import { store } from './store.js';

const CLICKS = 10;        // total clicks in the test
const IGNORE_FIRST = 2;   // warm-up clicks (find the beat) — not scored
const CLICK_S = 0.6;      // 100 BPM: unhurried, unambiguous
const LEAD_S = 3.0;       // 3-2-1 countdown before the first click (get set)

export class CalibrateMode {
  constructor(root, mic) {
    this.root = root;
    this.mic = mic;
    this.running = false;
    this.phase = 'idle'; // idle | testing
    this.peak = 0;
    this.render();
    mic.addEventListener('onset', (e) => this.onHit(e.detail));
  }

  activate() {
    this.mic.setDetectorOptions({ refractory: 0.15, threshold: 2.5, minLevel: 0.01 });
    if (!this._meterT) this._meterT = setInterval(() => this.drawMeter(), 90);
  }

  deactivate() {
    clearInterval(this._meterT);
    this._meterT = null;
    if (this.running) this.abort();
  }

  frac(level) {
    if (level <= 0) return 0;
    return Math.max(0, Math.min(1, (20 * Math.log10(level) + 60) / 54));
  }

  drawMeter() {
    if (!this.root.classList.contains('active')) return;
    const fill = this.root.querySelector('#cal-level');
    const peakEl = this.root.querySelector('#cal-peak');
    if (!fill) return;
    const lvl = this.mic.level || 0;
    this.peak = Math.max(this.peak * 0.985, lvl);
    fill.style.width = `${(this.frac(lvl) * 100).toFixed(1)}%`;
    if (peakEl) peakEl.textContent = lvl > 0 ? `PEAK ${(20 * Math.log10(this.peak)).toFixed(0)} dB` : 'PEAK —';
  }

  render() {
    const cal = store.get('calibrationMs');
    const trig = store.get('trigger');
    const trigPct = trig ? this.frac(trig) * 100 : 18;
    this.root.innerHTML = `
      <div class="status-row" style="align-items:flex-end">
        <div class="title-stamp" style="margin:0">CALIBRATE</div>
        <span class="chip-stamp ${cal === null ? 'warn' : 'set'}">${cal === null ? 'NEEDS TEST' : 'SET'}</span>
      </div>

      <div class="cal-card">
        <div class="cal-head"><span class="num-chip">1</span><b>MIC INPUT</b><span class="cal-spacer"></span><span class="drop" style="pointer-events:none">BUILT-IN MIC &#9662;</span></div>
        <div class="cal-cap" style="display:flex;justify-content:space-between"><span>INPUT LEVEL</span><span id="cal-peak" class="cal-peak">PEAK &mdash;</span></div>
        <div class="trig-wrap">
          <div id="trig-label" class="trig-label" style="left:${trigPct.toFixed(1)}%">TRIG</div>
          <div class="level-track" id="level-track">
            <div id="cal-level" class="level-fill"></div>
            <div class="level-gaps"></div>
            <div id="trig-mark" class="trig-mark" style="left:${trigPct.toFixed(1)}%"></div>
          </div>
        </div>
        <div class="cal-step1-foot">
          <button id="trig-auto" class="btn amber">AUTO SET</button>
          <p class="cal-note">Stay quiet, tap AUTO to read the room — or drag TRIG just above the noise. Under the line never counts as a hit.</p>
        </div>
      </div>

      <div class="cal-card lat-card">
        <div class="cal-head"><span class="num-chip">2</span><b>AUDIO LATENCY</b></div>
        <div class="lat-body" id="lat-body">${this.latIdleHtml(cal)}</div>
      </div>

      <div class="cal-actions">
        <button id="cal-clear" class="btn">RESET</button>
        <button id="cal-done" class="btn green">SAVE &amp; DONE &#10003;</button>
      </div>`;

    this.bindStatic();
    this.bindLatIdle();
  }

  latIdleHtml(cal) {
    return `
      <div class="lat-diagram">
        <div class="lat-end"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#141210" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>YOU HIT</span></div>
        <div class="lat-line"><div class="lat-dot"></div></div>
        <div class="lat-end"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#141210" stroke-width="2"><rect x="7" y="3" width="10" height="18" rx="1.5"/><line x1="10" y1="18" x2="14" y2="18"/></svg><span>IT HEARS</span></div>
      </div>
      <div id="cal-result" class="lat-result">${cal === null ? '&mdash;' : `${cal >= 0 ? '&#8722;' : '+'}${Math.abs(cal).toFixed(0)}<span> MS</span>`}</div>
      <div id="cal-detail" class="lat-detail">${cal === null ? 'phone near the drum, then tap along with the clicks' : 'subtracted from every score on this phone'}</div>
      <div class="lat-btn-row"><button id="cal-go" class="btn amber">${cal === null ? 'START THE TEST' : 'RUN TEST AGAIN'}</button></div>`;
  }

  latTestHtml() {
    const scored = CLICKS - IGNORE_FIRST;
    return `
      <div id="cal-phase" class="cal-phase">GET READY&hellip;</div>
      <div class="pulse-wrap"><div id="cal-pulse" class="cal-pulse"></div></div>
      <div class="tap-dots" id="tap-dots">${Array.from({ length: scored }, () => '<i></i>').join('')}</div>
      <div class="lat-btn-row"><button id="cal-stop" class="btn">STOP</button></div>`;
  }

  bindStatic() {
    this.root.querySelector('#trig-auto').addEventListener('click', () => this.autoTrigger());
    this.root.querySelector('#cal-clear').addEventListener('click', () => {
      if (this.running) this.abort();
      store.set('calibrationMs', null);
      store.set('trigger', null);
      this.mic.setTriggerFloor(0);
      this.render();
    });
    this.root.querySelector('#cal-done').addEventListener('click', () => {
      if (this.running) this.abort();
      window.__rhythmChecker.nav('home');
    });

    const track = this.root.querySelector('#level-track');
    const setTrig = (clientX) => {
      const r = track.getBoundingClientRect();
      const f = Math.max(0.02, Math.min(0.96, (clientX - r.left) / r.width));
      const level = 10 ** ((f * 54 - 60) / 20);
      store.set('trigger', level);
      this.mic.setTriggerFloor(level);
      this.root.querySelector('#trig-mark').style.left = `${(f * 100).toFixed(1)}%`;
      this.root.querySelector('#trig-label').style.left = `${(f * 100).toFixed(1)}%`;
    };
    this._setTrig = setTrig;
    track.addEventListener('pointerdown', (e) => { this._dragging = true; this._setTrig(e.clientX); });
    if (!this._dragBound) {
      this._dragBound = true;
      window.addEventListener('pointermove', (e) => { if (this._dragging) this._setTrig(e.clientX); });
      window.addEventListener('pointerup', () => { this._dragging = false; });
    }
  }

  bindLatIdle() {
    const go = this.root.querySelector('#cal-go');
    if (go) go.addEventListener('click', () => this.start());
  }

  // sample ~0.7s of room noise and park the trigger a hair above the peak
  autoTrigger() {
    const btn = this.root.querySelector('#trig-auto');
    btn.textContent = 'LISTENING…';
    let peak = 0;
    const t0 = this.mic.now();
    const sample = () => {
      peak = Math.max(peak, this.mic.level || 0);
      if (this.mic.now() - t0 < 0.7) { requestAnimationFrame(sample); return; }
      const level = Math.max(0.008, peak * 1.6); // headroom above the noise floor
      store.set('trigger', level);
      this.mic.setTriggerFloor(level);
      const f = this.frac(level);
      this.root.querySelector('#trig-mark').style.left = `${(f * 100).toFixed(1)}%`;
      this.root.querySelector('#trig-label').style.left = `${(f * 100).toFixed(1)}%`;
      btn.textContent = 'AUTO SET';
    };
    requestAnimationFrame(sample);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.phase = 'testing';
    this.taps = [];
    this.metro = new Metronome(this.mic.audioContext);
    this.metro.bpm = 60 / CLICK_S;
    this.metro.subdivision = 1;
    this.metro.meter = { pulses: 1, accents: [] };
    this.metro.start(LEAD_S);
    this.root.querySelector('#lat-body').innerHTML = this.latTestHtml();
    this.root.querySelector('#cal-stop').addEventListener('click', () => { this.abort(); this.render(); });
    this._pulse();
    this._endTimer = setTimeout(() => this.finish(), (LEAD_S + CLICKS * CLICK_S + 0.8) * 1000);
  }

  // rAF loop: flash the dot on each click, narrate the phase
  _pulse() {
    if (!this.running) return;
    const pulse = this.root.querySelector('#cal-pulse');
    const phaseEl = this.root.querySelector('#cal-phase');
    if (pulse) {
      const rel = this.mic.now() - this.metro.startTime;
      if (rel < 0) {
        // 3-2-1 countdown: the number ticks and pops once per second, so you
        // know exactly when the clicks (and your tapping) begin.
        const n = Math.max(1, Math.ceil(-rel));
        const into = -rel - Math.floor(-rel);      // seconds into this count
        const pop = Math.exp(-into / 0.16);         // pop on each tick
        pulse.textContent = String(n);
        pulse.classList.add('counting');
        pulse.classList.remove('lit');
        pulse.style.transform = `scale(${(0.86 + 0.32 * pop).toFixed(3)})`;
        pulse.style.opacity = (0.55 + 0.45 * pop).toFixed(3);
        if (phaseEl) phaseEl.textContent = 'GET READY';
      } else {
        if (pulse.textContent) { pulse.textContent = ''; pulse.classList.remove('counting'); }
        const idx = Math.floor(rel / CLICK_S);
        const since = rel - idx * CLICK_S;
        const flash = Math.exp(-since / 0.09); // quick attack-decay per click
        pulse.style.transform = `scale(${(0.8 + 0.45 * flash).toFixed(3)})`;
        pulse.style.opacity = (0.5 + 0.5 * flash).toFixed(3);
        pulse.classList.toggle('lit', flash > 0.5);
        if (phaseEl) {
          const toGo = Math.max(0, CLICKS - idx); // clicks left to tap on
          phaseEl.textContent = idx < IGNORE_FIRST ? 'FEEL THE BEAT…'
            : idx >= CLICKS ? 'DONE' : `HIT EACH CLICK · ${toGo} TO GO`;
        }
      }
    }
    this._pulseRaf = requestAnimationFrame(() => this._pulse());
  }

  onHit(onset) {
    if (!this.running || !this.root.classList.contains('active')) return;
    const grid = this.metro.nearestGrid(onset.time);
    if (!grid || grid.index >= CLICKS) return;
    const offsetMs = (onset.time - grid.time) * 1000;
    if (Math.abs(offsetMs) > 250) return;
    this.taps.push({ index: grid.index, offsetMs });
    // fill the scored dots as usable taps land
    const scoredTaps = this.taps.filter((t) => t.index >= IGNORE_FIRST).length;
    const dots = this.root.querySelectorAll('#tap-dots i');
    dots.forEach((d, i) => d.classList.toggle('on', i < scoredTaps));
  }

  abort() {
    this.running = false;
    this.phase = 'idle';
    clearTimeout(this._endTimer);
    cancelAnimationFrame(this._pulseRaf);
    if (this.metro) this.metro.stop();
  }

  finish() {
    this.running = false;
    this.phase = 'idle';
    cancelAnimationFrame(this._pulseRaf);
    this.metro.stop();
    const usable = this.taps.filter((t) => t.index >= IGNORE_FIRST).map((t) => t.offsetMs);
    const cal = store.get('calibrationMs');
    const body = this.root.querySelector('#lat-body');
    body.innerHTML = this.latIdleHtml(cal);
    this.bindLatIdle();
    const resultEl = this.root.querySelector('#cal-result');
    const detailEl = this.root.querySelector('#cal-detail');
    const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    if (usable.length < 4) {
      resultEl.innerHTML = '&mdash;';
      detailEl.textContent = 'the mic barely heard you — move the phone closer, check the TRIG line, and start the test again.';
      return;
    }
    // the median is the latency; drop the odd flubbed tap so it doesn't sink an
    // otherwise-good run, then judge the spread of what's left. The bar is set
    // to real human tapping (~30-45 ms), not metronome-tight — the median stays
    // reliable well past that.
    const m0 = median(usable);
    const kept = usable.filter((v) => Math.abs(v - m0) <= 90);
    if (kept.length < 4) {
      resultEl.innerHTML = '&mdash;';
      detailEl.textContent = 'your taps were all over the place — relax, lock onto the click, and run it again.';
      return;
    }
    const med = median(kept);
    const spread = Math.sqrt(kept.reduce((a, b) => a + (b - med) ** 2, 0) / kept.length);
    if (spread > 50) {
      resultEl.innerHTML = '&mdash;';
      detailEl.textContent = `your taps varied ±${spread.toFixed(0)} ms — that's your own timing, not the phone's. Relax, lock onto the click, and run it again.`;
      return;
    }
    store.set('calibrationMs', med);
    resultEl.innerHTML = `${med >= 0 ? '&#8722;' : '+'}${Math.abs(med).toFixed(0)}<span> MS</span>`;
    detailEl.textContent = `your phone hears itself ${Math.abs(med).toFixed(0)} ms ${med >= 0 ? 'late' : 'early'} (±${spread.toFixed(0)} ms). Now subtracted from every score on this phone.`;
    const chip = this.root.querySelector('.status-row .chip-stamp');
    chip.textContent = 'SET';
    chip.classList.remove('warn');
    chip.classList.add('set');
  }
}
