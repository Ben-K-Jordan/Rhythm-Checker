// GrooveBar: the one control surface for tempo and meter, shared by the
// rudiment trainer and the timing check. Big ± buttons (tap ±5, hold to
// repeat), tap-tempo, meter chips, grouping chips for odd meters. Persists
// per mode and emits 'change'.

import { METERS, meterById, defaultGrouping, unitGlyph, TapTempo } from './meter.js';
import { store } from './store.js';

export class GrooveBar extends EventTarget {
  constructor(container, { storeKey, now }) {
    super();
    this.container = container;
    this.storeKey = storeKey;
    this.now = now; // () => seconds, for tap tempo (audio clock when running)
    const saved = store.get(storeKey) || {};
    this.bpm = saved.bpm || 120;
    this.meterId = saved.meterId || '4/4';
    this.grouping = saved.grouping || defaultGrouping(meterById(this.meterId));
    this._tap = new TapTempo();
    this._holdTimer = null;
    this.render();
  }

  get meter() {
    return meterById(this.meterId);
  }

  value() {
    return { bpm: this.bpm, meter: this.meter, grouping: this.grouping };
  }

  _persist() {
    store.set(this.storeKey, { bpm: this.bpm, meterId: this.meterId, grouping: this.grouping });
    this.dispatchEvent(new Event('change'));
  }

  setBpm(bpm) {
    this.bpm = Math.max(20, Math.min(400, Math.round(bpm)));
    this._updateBpm();
    this._persist();
  }

  render() {
    const meter = this.meter;
    const groupings = Object.keys(meter.groupings);
    this.container.innerHTML = `
      <div class="groove">
        <div class="groove-tempo">
          <button class="tempo-btn" data-d="-5">−</button>
          <div class="tempo-read">
            <span class="tempo-glyph">${unitGlyph(meter)}=</span><span class="tempo-bpm">${this.bpm}</span>
          </div>
          <button class="tempo-btn" data-d="5">+</button>
          <button class="tempo-tap">TAP</button>
        </div>
        <div class="groove-meters">
          ${METERS.map((m) => `<button class="chip ${m.id === this.meterId ? 'on' : ''}" data-meter="${m.id}">${m.label}</button>`).join('')}
        </div>
        <div class="groove-groupings ${groupings.length > 1 ? '' : 'hidden'}">
          ${groupings.map((g) => `<button class="chip small ${g === this.grouping ? 'on' : ''}" data-grouping="${g}">${g}</button>`).join('')}
        </div>
      </div>`;

    this.container.querySelectorAll('.tempo-btn').forEach((b) => {
      const step = +b.dataset.d;
      b.addEventListener('click', () => this.setBpm(this.bpm + step));
      // hold to repeat in ±1s for fine dialing
      const startHold = (ev) => {
        ev.preventDefault();
        this._holdTimer = setTimeout(() => {
          this._holdTimer = setInterval(() => this.setBpm(this.bpm + Math.sign(step)), 90);
        }, 450);
      };
      const endHold = () => {
        clearTimeout(this._holdTimer);
        clearInterval(this._holdTimer);
        this._holdTimer = null;
      };
      b.addEventListener('pointerdown', startHold);
      b.addEventListener('pointerup', endHold);
      b.addEventListener('pointercancel', endHold);
      b.addEventListener('pointerleave', endHold);
    });
    this.container.querySelector('.tempo-tap').addEventListener('click', () => {
      const bpm = this._tap.tap(this.now());
      if (bpm !== null) this.setBpm(bpm);
      else this.container.querySelector('.tempo-bpm').classList.add('tapping');
    });
    this.container.querySelectorAll('[data-meter]').forEach((b) => {
      b.addEventListener('click', () => {
        this.meterId = b.dataset.meter;
        this.grouping = defaultGrouping(this.meter);
        this.render();
        this._persist();
      });
    });
    this.container.querySelectorAll('[data-grouping]').forEach((b) => {
      b.addEventListener('click', () => {
        this.grouping = b.dataset.grouping;
        this.render();
        this._persist();
      });
    });
  }

  _updateBpm() {
    const el = this.container.querySelector('.tempo-bpm');
    if (el) {
      el.textContent = String(this.bpm);
      el.classList.remove('tapping');
    }
  }
}
