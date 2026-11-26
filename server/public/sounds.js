'use strict';

// Sound board: plays every effect of sfx.js on its own, for listening and tuning.
// The first tap unlocks the audio context (sfx.js listens for it), so a button press
// plays the sound right after that unlock.

(() => {
  const SFX = window.PloinkSfx;
  const note = document.getElementById('muted-note');

  const sequences = {
    'combo-run': () => [1, 2, 3, 4, 5, 6].forEach((chain, i) => setTimeout(() => SFX.combo(chain), i * 260)),
    countdown: () => {
      [0, 1, 2].forEach((i) => setTimeout(() => SFX.beep(), i * 1000));
      setTimeout(() => SFX.go(), 3000);
    },
  };

  function render() {
    note.hidden = !SFX.muted;
  }

  document.getElementById('unmute').addEventListener('click', () => {
    SFX.setMuted(false);
    render();
  });

  document.querySelectorAll('[data-sfx]').forEach((button) => {
    button.addEventListener('click', () => {
      const name = button.dataset.sfx;
      // Give the unlock from this very tap a moment to resume the audio context.
      setTimeout(() => {
        if (sequences[name]) {
          sequences[name]();
          return;
        }
        const raw = button.dataset.arg;
        const arg = raw === undefined ? undefined : raw === 'true' ? true : Number(raw);
        SFX[name](arg);
      }, 30);
    });
  });

  // Background music: start/stop and the faster final-seconds mode.
  const musicToggle = document.getElementById('music-toggle');
  const musicFast = document.getElementById('music-fast');
  let fast = false;
  musicToggle.addEventListener('click', () => {
    setTimeout(() => {
      if (SFX.music.off) SFX.music.setOff(false);
      if (SFX.music.playing) SFX.music.stop();
      else SFX.music.start();
      musicToggle.textContent = SFX.music.playing ? '⏹ Musik stoppen' : '🎵 Musik starten';
    }, 30);
  });
  musicFast.addEventListener('click', () => {
    fast = !fast;
    SFX.music.setIntensity(fast ? 1 : 0);
    musicFast.textContent = fast ? '▶️ Normales Tempo' : '⏩ Schlussphase (schneller)';
  });

  render();
})();
