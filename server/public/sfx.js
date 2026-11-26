'use strict';

// Ploink sound effects, synthesized with the Web Audio API (no audio files).
// Browsers only allow sound after a user gesture, so the context is created on the
// first touch/key and every call before that is silently ignored. The mute setting is
// remembered per device.

window.PloinkSfx = (() => {
  const STORAGE_KEY = 'ploink-sound';
  let ctx = null;
  let master = null;
  let noise = null;
  let muted = false;
  try { muted = localStorage.getItem(STORAGE_KEY) === 'off'; } catch { /* private mode */ }

  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.55;
      master.connect(ctx.destination);
      // One second of white noise, reused for every whoosh, splat and click.
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
  }
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });

  const ready = () => ctx && !muted && ctx.state === 'running';

  /** Gain envelope: quick attack, exponential decay. */
  function envelope(start, peak, attack, decay) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);
    g.connect(master);
    return g;
  }

  function tone({ type = 'sine', from, to = from, at = 0, attack = 0.005, decay = 0.15, peak = 0.3 }) {
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
    osc.connect(envelope(t, peak, attack, decay));
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }

  function hiss({ filter = 'bandpass', from, to = from, q = 1, at = 0, attack = 0.01, decay = 0.15, peak = 0.3 }) {
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    if (to !== from) f.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
    src.connect(f);
    f.connect(envelope(t, peak, attack, decay));
    src.start(t, Math.random() * 0.5);
    src.stop(t + attack + decay + 0.05);
  }

  const sfx = {
    /** Swipe jump; air jumps sound a little higher. */
    jump(inAir) {
      if (!ready()) return;
      hiss({ from: 700, to: 2200, q: 1.5, attack: 0.03, decay: 0.14, peak: 0.25 });
      tone({ type: 'sine', from: inAir ? 320 : 220, to: inAir ? 640 : 440, decay: 0.08, peak: 0.08 });
    },
    /** Katana spin on the ground. */
    slash() {
      if (!ready()) return;
      hiss({ from: 900, to: 3000, q: 2, attack: 0.05, decay: 0.25, peak: 0.3 });
    },
    /** Blade through fruit: a chop and a squish. `volume` < 1 for other players' cuts. */
    cut(volume = 1) {
      if (!ready()) return;
      hiss({ filter: 'lowpass', from: 1400, attack: 0.002, decay: 0.05, peak: 0.35 * volume });
      tone({ type: 'sine', from: 190, to: 80, attack: 0.002, decay: 0.09, peak: 0.35 * volume });
      hiss({ filter: 'highpass', from: 2500, to: 900, at: 0.02, attack: 0.01, decay: 0.12, peak: 0.12 * volume });
    },
    /** Confirmed own cut: a bright ding that climbs with the combo. */
    combo(chain) {
      if (!ready()) return;
      const f = 880 * 2 ** (Math.min(chain - 1, 12) / 12);
      tone({ type: 'triangle', from: f, decay: 0.18, peak: 0.12 });
      if (chain > 1) tone({ type: 'triangle', from: f * 1.5, at: 0.06, decay: 0.15, peak: 0.08 });
    },
    /** Uncut fruit hits the floor. */
    splat() {
      if (!ready()) return;
      hiss({ filter: 'lowpass', from: 500, to: 200, attack: 0.005, decay: 0.1, peak: 0.12 });
    },
    kick() {
      if (!ready()) return;
      tone({ type: 'sine', from: 140, to: 50, attack: 0.003, decay: 0.16, peak: 0.5 });
      hiss({ filter: 'bandpass', from: 1800, q: 0.8, attack: 0.002, decay: 0.04, peak: 0.3 });
    },
    /** Being kicked: a thump and a falling "whoop". */
    kicked() {
      if (!ready()) return;
      tone({ type: 'sine', from: 110, to: 45, attack: 0.003, decay: 0.18, peak: 0.45 });
      tone({ type: 'square', from: 620, to: 180, at: 0.03, attack: 0.01, decay: 0.25, peak: 0.05 });
    },
    /** Two blades meet: metallic partials ringing out. */
    clash() {
      if (!ready()) return;
      for (const [f, p] of [[1250, 0.12], [1870, 0.09], [2650, 0.07], [3480, 0.05]]) {
        tone({ type: 'sine', from: f, attack: 0.002, decay: 0.45, peak: p });
      }
      hiss({ filter: 'highpass', from: 4000, attack: 0.002, decay: 0.05, peak: 0.25 });
    },
    /** Shield takes a hit. */
    block() {
      if (!ready()) return;
      tone({ type: 'sine', from: 320, to: 640, attack: 0.005, decay: 0.2, peak: 0.25 });
      tone({ type: 'sine', from: 1600, attack: 0.002, decay: 0.25, peak: 0.06 });
    },
    /** Power-up bubble popped: a quick rising arpeggio. */
    collect() {
      if (!ready()) return;
      [660, 880, 1320].forEach((f, i) => tone({ type: 'triangle', from: f, at: i * 0.05, decay: 0.12, peak: 0.12 }));
    },
    /** Wasps. */
    buzz() {
      if (!ready()) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(210, t);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 32;
      const depth = ctx.createGain();
      depth.gain.value = 25;
      lfo.connect(depth);
      depth.connect(osc.frequency);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1200;
      osc.connect(f);
      f.connect(envelope(t, 0.12, 0.02, 0.5));
      osc.start(t);
      lfo.start(t);
      osc.stop(t + 0.6);
      lfo.stop(t + 0.6);
    },
    /** Shuriken leaves the hand: a whirring hiss. */
    throw() {
      if (!ready()) return;
      hiss({ from: 2600, to: 4200, q: 3, attack: 0.01, decay: 0.22, peak: 0.25 });
      tone({ type: 'triangle', from: 1500, to: 900, attack: 0.002, decay: 0.08, peak: 0.06 });
    },
    beep() {
      if (!ready()) return;
      tone({ type: 'square', from: 660, decay: 0.1, peak: 0.07 });
    },
    go() {
      if (!ready()) return;
      tone({ type: 'square', from: 990, decay: 0.3, peak: 0.08 });
    },
    fanfare() {
      if (!ready()) return;
      [523, 659, 784, 1046].forEach((f, i) => tone({ type: 'triangle', from: f, at: i * 0.11, decay: i === 3 ? 0.5 : 0.15, peak: 0.13 }));
    },

    get muted() { return muted; },
    setMuted(value) {
      muted = !!value;
      try { localStorage.setItem(STORAGE_KEY, muted ? 'off' : 'on'); } catch { /* private mode */ }
      if (master) master.gain.value = muted ? 0 : 0.55;
    },
  };
  return sfx;
})();
