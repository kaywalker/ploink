'use strict';

// Ploink sound effects, synthesized with the Web Audio API (no audio files), in a dojo
// flavour: taiko drums, koto-like plucks on a Japanese scale (Karplus-Strong), metallic
// katana "shing", a gong, all through a little room reverb and a compressor.
// Browsers only allow sound after a user gesture, so the context is created on the
// first touch/key and every call before that is silently ignored. The mute setting is
// remembered per device.

window.PloinkSfx = (() => {
  const STORAGE_KEY = 'ploink-sound';
  const VOLUME = 0.8;
  // Miyako-bushi (in) scale on D: D Eb G A Bb, over three octaves.
  const SCALE = [0, 1, 5, 7, 8].flatMap((step, _, steps) => [0, 12, 24].map((oct) => step + oct))
    .sort((a, b) => a - b)
    .map((semi) => 293.66 * 2 ** (semi / 12));

  let ctx = null;
  let master = null;
  let reverb = null;
  let noise = null;
  const plucks = new Map(); // rounded frequency -> rendered pluck buffer
  let muted = false;
  try { muted = localStorage.getItem(STORAGE_KEY) === 'off'; } catch { /* private mode */ }
  let route = null; // while the music schedules notes, they go into the music bus
  const afterUnlock = [];

  // iPhone: Safari treats web audio as "ambient" by default, which the ring/silent
  // switch mutes. As a game we ask for "playback" (Audio Session API, Safari only).
  function claimAudioSession() {
    try {
      if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback';
    } catch { /* not supported */ }
  }

  function unlock() {
    claimAudioSession();
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      comp.connect(ctx.destination);
      master = ctx.createGain();
      master.gain.value = muted ? 0 : VOLUME;
      master.connect(comp);

      // Small wooden room: a convolver with a generated, decaying stereo impulse.
      const len = Math.floor(ctx.sampleRate * 1.6);
      const impulse = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = impulse.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
      }
      const conv = ctx.createConvolver();
      conv.buffer = impulse;
      reverb = ctx.createGain();
      reverb.gain.value = 0.28;
      reverb.connect(conv);
      conv.connect(master);

      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      // Render the koto strings ahead, so the first pluck in a game does not stutter.
      setTimeout(() => SCALE.forEach(pluckBuffer), 50);
    }
    // Suspended at the start, "interrupted" after a phone call on iOS: resume on a gesture.
    if (ctx.state !== 'running') {
      const resumed = ctx.resume();
      if (resumed && resumed.catch) resumed.catch(() => {});
      // The classic iOS unlock: start a silent one-sample buffer inside the gesture.
      const silent = ctx.createBufferSource();
      silent.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      silent.connect(ctx.destination);
      silent.start(0);
    }
    afterUnlock.forEach((fn) => fn());
  }
  // Only some events count as a user gesture for audio: on touch screens lifting the
  // finger does (pointerup, touchend, click), putting it down does not. So listen to all
  // of them; every later gesture also resumes audio that the system suspended.
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) {
    window.addEventListener(type, unlock, { capture: true, passive: true });
  }

  const ready = () => ctx && !muted && ctx.state === 'running';
  const vary = (amount = 0.08) => 1 + (Math.random() * 2 - 1) * amount; // no two hits alike

  /** Gain envelope into the mix (and some of it into the reverb). */
  function envelope(start, peak, attack, decay, wet = 0.3) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);
    g.connect(route || master);
    if (wet > 0) {
      const send = ctx.createGain();
      send.gain.value = wet;
      g.connect(send);
      send.connect(reverb);
    }
    return g;
  }

  function tone({ type = 'sine', from, to = from, at = 0, attack = 0.004, decay = 0.15, peak = 0.3, wet }) {
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
    osc.connect(envelope(t, peak, attack, decay, wet));
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }

  function hiss({ filter = 'bandpass', from, to = from, q = 1, at = 0, attack = 0.008, decay = 0.15, peak = 0.3, wet }) {
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    if (to !== from) f.frequency.exponentialRampToValueAtTime(to, t + attack + decay);
    src.connect(f);
    f.connect(envelope(t, peak, attack, decay, wet));
    src.start(t, Math.random() * 0.5);
    src.stop(t + attack + decay + 0.05);
  }

  /** Plucked string (Karplus-Strong), rendered once per pitch and cached. */
  function pluckBuffer(freq) {
    const key = Math.round(freq);
    if (plucks.has(key)) return plucks.get(key);
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 1.4);
    const buf = ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);
    const period = Math.max(2, Math.round(sr / freq));
    const line = new Float32Array(period);
    for (let i = 0; i < period; i++) line[i] = Math.random() * 2 - 1;
    let idx = 0;
    for (let i = 0; i < len; i++) {
      const next = (idx + 1) % period;
      const v = line[idx];
      line[idx] = 0.4985 * (v + line[next]); // averaging = string damping
      out[i] = v;
      idx = next;
    }
    plucks.set(key, buf);
    return buf;
  }

  function pluck(freq, { at = 0, peak = 0.35, wet = 0.4 } = {}) {
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = pluckBuffer(freq);
    const tone2 = ctx.createBiquadFilter();
    tone2.type = 'lowpass';
    tone2.frequency.value = Math.min(9000, freq * 7);
    const g = envelope(t, peak, 0.002, 1.2, wet);
    src.connect(tone2);
    tone2.connect(g);
    src.start(t);
    src.stop(t + 1.3);
  }

  /** Taiko drum: a deep pitched body, a skin slap and a little stick click. */
  function taiko({ at = 0, pitch = 1, peak = 0.7 } = {}) {
    tone({ from: 95 * pitch, to: 48 * pitch, at, attack: 0.003, decay: 0.55, peak, wet: 0.45 });
    tone({ from: 190 * pitch, to: 90 * pitch, at, attack: 0.002, decay: 0.12, peak: peak * 0.35, wet: 0.2 });
    hiss({ filter: 'lowpass', from: 600, at, attack: 0.002, decay: 0.08, peak: peak * 0.5, wet: 0.2 });
    hiss({ filter: 'highpass', from: 3000, at, attack: 0.001, decay: 0.02, peak: peak * 0.15, wet: 0 });
  }

  /** Katana "shing": a fast resonant sweep with a ringing metal edge. */
  function shing({ at = 0, peak = 0.22, ring = true } = {}) {
    const p = vary(0.1);
    hiss({ from: 1800 * p, to: 7000 * p, q: 7, at, attack: 0.015, decay: 0.16, peak, wet: 0.3 });
    if (ring) {
      tone({ from: 3150 * p, at: at + 0.02, attack: 0.002, decay: 0.3, peak: peak * 0.18, wet: 0.5 });
      tone({ from: 4730 * p, at: at + 0.02, attack: 0.002, decay: 0.22, peak: peak * 0.12, wet: 0.5 });
    }
  }

  const note = (step) => SCALE[Math.max(0, Math.min(SCALE.length - 1, step))];

  // How the inside of each fruit sounds when it is cut.
  const FRUIT_TEXTURE = {
    apple: 'crunchy', golden: 'crunchy', carrot: 'crunchy',
    orange: 'juicy', tomato: 'juicy', watermelon: 'juicy', pineapple: 'juicy',
    banana: 'soft', eggplant: 'soft',
  };

  /** Struck glass bell: hard attack, bright inharmonic partials, a click, little room. */
  function pling(freq, at = 0, level = 1) {
    tone({ from: freq, at, attack: 0.001, decay: 0.28, peak: 0.24 * level, wet: 0.12 });
    tone({ from: freq * 2.756, at, attack: 0.001, decay: 0.12, peak: 0.1 * level, wet: 0.1 });
    tone({ from: freq * 5.404, at, attack: 0.001, decay: 0.05, peak: 0.05 * level, wet: 0 });
    hiss({ filter: 'highpass', from: 6500, at, attack: 0.001, decay: 0.01, peak: 0.18 * level, wet: 0 });
  }

  /** Shakuhachi-like flute: a breathy sine with a slow vibrato that swells in. */
  function flute(freq, { at = 0, length = 2, peak = 0.08 } = {}) {
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(freq, t);
    const vib = ctx.createOscillator();
    vib.frequency.value = 5;
    const vibDepth = ctx.createGain();
    vibDepth.gain.setValueAtTime(0, t);
    vibDepth.gain.linearRampToValueAtTime(freq * 0.012, t + length * 0.6);
    vib.connect(vibDepth);
    vibDepth.connect(osc.frequency);
    const g = envelope(t, peak, length * 0.3, length * 0.7, 0.7);
    osc.connect(g);
    osc.start(t);
    vib.start(t);
    osc.stop(t + length + 0.1);
    vib.stop(t + length + 0.1);
    hiss({ from: freq * 2, q: 4, at, attack: length * 0.3, decay: length * 0.7, peak: peak * 0.35, wet: 0.7 });
  }

  /**
   * Background music: a looping dojo groove in the style of the round-end phrase.
   * Taiko "don" and rim "ka" in a 16-step bar, a koto bass, a koto melody built from
   * short motifs (repeated and varied, a new one every 8 bars) and long flute notes.
   * Notes are scheduled slightly ahead on the audio clock, so timing stays tight.
   * `setIntensity(1)` speeds it up and adds drums for the final seconds.
   */
  const music = (() => {
    const MUSIC_KEY = 'ploink-music';
    const MUSIC_VOLUME = 0.42;
    const BASE_BPM = 96;
    const FAST_BPM = 124;
    let musicOff = false;
    try { musicOff = localStorage.getItem(MUSIC_KEY) === 'off'; } catch { /* private mode */ }
    let wanted = false;
    let bus = null;
    let timer = null;
    let step = 0;
    let bar = 0;
    let nextTime = 0;
    let bpm = BASE_BPM;
    let intensity = 0;
    let motifs = null;

    // Rhythms for one bar of melody: the 16th-note steps that get a note.
    const RHYTHMS = [
      [0, 3, 6, 8, 11, 14], [0, 2, 4, 8, 10, 12], [0, 6, 8, 10, 14], [0, 3, 4, 8, 12, 15], [2, 4, 6, 10, 12],
    ];

    /** One bar of melody: a random walk on the scale that ends on D or A. */
    function makeBar(start) {
      const rhythm = RHYTHMS[Math.floor(Math.random() * RHYTHMS.length)];
      let degree = start;
      const notes = new Array(16).fill(null);
      rhythm.forEach((pos, i) => {
        if (i > 0) degree = Math.max(0, Math.min(9, degree + [-2, -1, -1, 1, 1, 2, 0][Math.floor(Math.random() * 7)]));
        if (i === rhythm.length - 1) degree = [0, 3, 5][Math.floor(Math.random() * 3)];
        notes[pos] = degree;
      });
      return notes;
    }

    /** Two motifs, played A A B A' over four bars; A' ends one step higher. */
    function newMotifs() {
      const a = makeBar(5);
      const b = makeBar(3);
      const a2 = a.map((d, i) => (d === null ? null : i >= 12 ? Math.min(10, d + 1) : d));
      return [a, a, b, a2];
    }

    function scheduleStep(at) {
      if (!motifs || (step === 0 && bar % 8 === 0)) motifs = newMotifs();
      const fast = intensity > 0;
      // Taiko groove
      if (step === 0) taiko({ at, pitch: 0.95, peak: bar % 4 === 0 ? 0.55 : 0.42 });
      if (step === 10 || (fast && (step === 6 || step === 8))) taiko({ at, pitch: 1.1, peak: 0.3 });
      if (step === 4 || step === 12 || step === 14 || (fast && step % 2 === 0 && step !== 0)) {
        hiss({ filter: 'highpass', from: 2600, at, attack: 0.001, decay: 0.03, peak: 0.12, wet: 0.2 });
        tone({ from: 1250, at, attack: 0.001, decay: 0.04, peak: 0.035, wet: 0.2 });
      }
      // Koto bass
      if (step === 0) pluck(SCALE[0] / 2, { at, peak: 0.28, wet: 0.3 });
      if (step === 8 && bar % 2 === 1) pluck(SCALE[3] / 2, { at, peak: 0.2, wet: 0.3 });
      // Koto melody
      const degree = motifs[bar % 4][step];
      if (degree !== null) pluck(note(degree), { at, peak: 0.2, wet: 0.45 });
      // Flute, every four bars
      if (step === 0 && bar % 4 === 2) flute(note([5, 3, 2, 4][Math.floor(bar / 4) % 4]), { at, length: (60 / bpm) * 7, peak: 0.07 });
    }

    function tick() {
      if (!ctx) return;
      route = bus;
      while (nextTime < ctx.currentTime + 0.25) {
        scheduleStep(Math.max(0, nextTime - ctx.currentTime));
        nextTime += 60 / bpm / 4;
        step = (step + 1) % 16;
        if (step === 0) {
          bar++;
          bpm += ((intensity > 0 ? FAST_BPM : BASE_BPM) - bpm) * 0.6;
        }
      }
      route = null;
    }

    function begin() {
      if (!wanted || musicOff || timer || !ctx) return;
      if (!bus) {
        bus = ctx.createGain();
        bus.connect(master);
      }
      bus.gain.cancelScheduledValues(ctx.currentTime);
      bus.gain.setValueAtTime(0.0001, ctx.currentTime);
      bus.gain.exponentialRampToValueAtTime(MUSIC_VOLUME, ctx.currentTime + 1.2);
      step = 0;
      bar = 0;
      motifs = null;
      bpm = intensity > 0 ? FAST_BPM : BASE_BPM;
      nextTime = ctx.currentTime + 0.1;
      timer = setInterval(tick, 50);
      tick();
    }

    function end() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      if (bus && ctx) {
        bus.gain.cancelScheduledValues(ctx.currentTime);
        bus.gain.setValueAtTime(bus.gain.value, ctx.currentTime);
        bus.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.8);
      }
    }

    afterUnlock.push(begin);

    return {
      start() {
        wanted = true;
        begin();
      },
      stop() {
        wanted = false;
        end();
      },
      setIntensity(level) {
        intensity = level > 0 ? 1 : 0;
      },
      get playing() { return !!timer; },
      get off() { return musicOff; },
      setOff(value) {
        musicOff = !!value;
        try { localStorage.setItem(MUSIC_KEY, musicOff ? 'off' : 'on'); } catch { /* private mode */ }
        if (musicOff) end();
        else begin();
      },
    };
  })();

  const sfx = {
    music,
    /** Swipe jump: a breathy whoosh, a little brighter for air jumps. */
    jump(inAir) {
      if (!ready()) return;
      const p = vary(0.1);
      hiss({ from: (inAir ? 600 : 400) * p, to: (inAir ? 1600 : 1100) * p, q: 1.2, attack: 0.04, decay: 0.16, peak: 0.28, wet: 0.15 });
    },
    /** Katana spin on the ground. */
    slash() {
      if (!ready()) return;
      shing({ peak: 0.3 });
    },
    /**
     * Blade through fruit: "tschak!" and a wet smack. A short air swish, a crisp bright
     * transient where the blade bites, then the inside of the fruit: crunchy fibres
     * (apple, carrot), a juicy squelch (melon, orange, tomato, pineapple) or a soft, dull
     * squish (banana, eggplant). `volume` < 1 for other players' cuts.
     */
    cut(volume = 1, fruit = 'apple') {
      if (!ready()) return;
      const v = volume;
      const p = vary(0.1);
      const texture = FRUIT_TEXTURE[fruit] || 'juicy';
      // Swish of the blade, then the bite: "tschak!"
      hiss({ from: 1500 * p, to: 5000 * p, q: 2, attack: 0.008, decay: 0.05, peak: 0.12 * v, wet: 0.1 });
      hiss({ filter: 'highpass', from: 3200 * p, at: 0.012, attack: 0.001, decay: 0.035, peak: 0.55 * v, wet: 0.15 });
      hiss({ from: 2300 * p, q: 2.5, at: 0.012, attack: 0.001, decay: 0.06, peak: 0.4 * v, wet: 0.15 });
      if (texture === 'crunchy') {
        // Fibres tearing: a quick run of tiny cracks.
        for (let i = 0; i < 9; i++) {
          hiss({ from: (1800 + Math.random() * 1800) * p, q: 1.5, at: 0.02 + Math.random() * 0.06, attack: 0.001, decay: 0.006 + Math.random() * 0.008, peak: (0.35 - i * 0.025) * v, wet: 0.05 });
        }
      }
      // The smack: two or three wet blips whose resonance slides down.
      const smack = texture === 'juicy' ? [[0.03, 0.42], [0.058, 0.3], [0.09, 0.18]]
        : texture === 'soft' ? [[0.03, 0.34], [0.065, 0.2]]
          : [[0.05, 0.22], [0.08, 0.12]];
      const top = texture === 'soft' ? 1000 : 1700;
      for (const [at, pk] of smack) {
        hiss({ from: top * p, to: (texture === 'soft' ? 380 : 550) * p, q: 6, at, attack: 0.003, decay: 0.06, peak: pk * v, wet: 0.2 });
      }
      // Juice body: a short, low wet splash.
      if (texture !== 'crunchy') {
        hiss({ filter: 'lowpass', from: 900 * p, to: 250 * p, q: 2, at: 0.035, attack: 0.006, decay: texture === 'juicy' ? 0.14 : 0.09, peak: 0.3 * v, wet: 0.2 });
      }
    },
    /**
     * Points: a hard, bright "pling" like a struck glass bell, one scale step higher
     * per combo hit; from a 3-combo on a second, higher pling follows.
     */
    combo(chain) {
      if (!ready()) return;
      const step = 8 + Math.min(chain - 1, 6);
      pling(note(step) * 2);
      if (chain > 2) pling(note(step + 2) * 2, 0.07, 0.7);
    },
    /** Uncut fruit lands on the floor. */
    splat() {
      if (!ready()) return;
      const p = vary(0.15);
      hiss({ filter: 'lowpass', from: 700 * p, to: 180 * p, q: 2, attack: 0.004, decay: 0.12, peak: 0.2, wet: 0.15 });
    },
    /** Landing a kick: a taiko hit with a whoosh. */
    kick() {
      if (!ready()) return;
      taiko({ peak: 0.75 });
      hiss({ from: 900, to: 2500, q: 1.5, attack: 0.01, decay: 0.12, peak: 0.2, wet: 0.1 });
    },
    /** Getting kicked: a deep drum and a falling, bending pluck. */
    kicked() {
      if (!ready()) return;
      taiko({ pitch: 0.8, peak: 0.7 });
      tone({ type: 'triangle', from: note(8), to: note(1), at: 0.04, attack: 0.005, decay: 0.35, peak: 0.12, wet: 0.4 });
    },
    /** Two blades meet: inharmonic metal ringing out in the room. */
    clash() {
      if (!ready()) return;
      const p = vary(0.05);
      for (const [f, pk, d] of [[1180, 0.14, 0.9], [1735, 0.1, 0.7], [2510, 0.08, 0.6], [3390, 0.06, 0.45], [4420, 0.04, 0.35]]) {
        tone({ from: f * p, attack: 0.001, decay: d, peak: pk, wet: 0.6 });
      }
      hiss({ filter: 'highpass', from: 3500, attack: 0.001, decay: 0.06, peak: 0.35, wet: 0.3 });
    },
    /** Shield takes the hit: a gong. */
    block() {
      if (!ready()) return;
      for (const [f, pk, d] of [[196, 0.25, 1.4], [196 * 1.48, 0.12, 1.1], [196 * 2.16, 0.08, 0.8], [196 * 2.98, 0.05, 0.6]]) {
        tone({ from: f, to: f * 0.985, attack: 0.004, decay: d, peak: pk, wet: 0.6 });
      }
    },
    /** Power-up bubble: a quick koto run up the scale. */
    collect() {
      if (!ready()) return;
      [5, 7, 9, 10].forEach((step, i) => pluck(note(step), { at: i * 0.055, peak: 0.24 }));
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
      f.frequency.value = 1300;
      osc.connect(f);
      f.connect(envelope(t, 0.14, 0.02, 0.5, 0.15));
      osc.start(t);
      lfo.start(t);
      osc.stop(t + 0.6);
      lfo.stop(t + 0.6);
    },
    /** Shuriken leaves the hand: a whirring metal spin. */
    throw() {
      if (!ready()) return;
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 6;
      f.frequency.setValueAtTime(3800, t);
      f.frequency.exponentialRampToValueAtTime(2200, t + 0.35);
      const trem = ctx.createGain();
      trem.gain.value = 0.5;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 28;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.5;
      lfo.connect(lfoDepth);
      lfoDepth.connect(trem.gain);
      src.connect(f);
      f.connect(trem);
      trem.connect(envelope(t, 0.45, 0.01, 0.35, 0.25));
      src.start(t, Math.random() * 0.5);
      lfo.start(t);
      src.stop(t + 0.42);
      lfo.stop(t + 0.42);
      shing({ peak: 0.12 });
    },
    /** Countdown: a taiko beat per second, the last one bigger with a chord. */
    beep() {
      if (!ready()) return;
      taiko({ pitch: 1.15, peak: 0.55 });
    },
    go() {
      if (!ready()) return;
      taiko({ pitch: 0.9, peak: 0.85 });
      taiko({ at: 0.12, pitch: 1.2, peak: 0.45 });
      [5, 7, 10].forEach((step) => pluck(note(step), { at: 0.02, peak: 0.2 }));
    },
    /** End of the round: a koto phrase over a drum roll. */
    fanfare() {
      if (!ready()) return;
      [0, 0.14, 0.28].forEach((at, i) => taiko({ at, pitch: 1 + i * 0.1, peak: 0.5 }));
      [5, 7, 8, 10, 12, 14].forEach((step, i) => pluck(note(step), { at: 0.42 + i * 0.12, peak: 0.28 }));
      taiko({ at: 1.15, pitch: 0.85, peak: 0.8 });
    },

    get muted() { return muted; },
    setMuted(value) {
      muted = !!value;
      try { localStorage.setItem(STORAGE_KEY, muted ? 'off' : 'on'); } catch { /* private mode */ }
      if (master) master.gain.value = muted ? 0 : VOLUME;
    },
  };
  return sfx;
})();
