'use strict';

// Full-screen mode for phones and tablets.
// Every game is its own page, and the browser leaves full screen on every page change.
// So the player's choice is remembered and the next touch on the new page goes full
// screen again (browsers only allow it from a user gesture). iPhone Safari offers no
// full screen for web pages; there Ploink runs without browser bars when it is started
// from the home screen (manifest + apple-mobile-web-app-capable), which is what the
// hint explains.

window.PloinkFullscreen = (() => {
  const KEY = 'ploink-fullscreen';
  const root = document.documentElement;
  const requestFs = root.requestFullscreen || root.webkitRequestFullscreen;
  const exitFs = document.exitFullscreen || document.webkitExitFullscreen;
  const supported = !!requestFs && !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const standalone = window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches
    || window.navigator.standalone === true;
  const isIPhone = /iPhone|iPod/.test(navigator.userAgent);
  const listeners = [];

  const storage = {
    get() { try { return localStorage.getItem(KEY); } catch { return null; } },
    set(value) { try { localStorage.setItem(KEY, value); } catch { /* private mode */ } },
  };

  let wanted = storage.get() === 'on';
  let leaving = false; // a page change also ends full screen; that must not count as "off"

  const current = () => document.fullscreenElement || document.webkitFullscreenElement || null;

  function enter() {
    if (!supported || current()) return;
    try {
      const result = requestFs.call(root, { navigationUI: 'hide' });
      if (result && result.catch) result.catch(() => {});
    } catch { /* not allowed right now */ }
  }

  function onChange() {
    if (!current() && !leaving) {
      // The player left full screen (back gesture, Esc, button): respect that.
      wanted = false;
      storage.set('off');
    }
    listeners.forEach((fn) => fn());
  }

  document.addEventListener('fullscreenchange', onChange);
  document.addEventListener('webkitfullscreenchange', onChange);
  window.addEventListener('pagehide', () => { leaving = true; });
  window.addEventListener('beforeunload', () => { leaving = true; });
  window.addEventListener('pageshow', () => { leaving = false; });

  // Back to full screen on the first touch of a page, if the player chose it.
  const resume = () => { if (wanted && !current()) enter(); };
  window.addEventListener('pointerup', resume, { capture: true });
  window.addEventListener('keydown', resume, { capture: true });

  return {
    supported,
    standalone,
    isIPhone,
    get active() { return !!current() || standalone; },
    /** Toggle from a button press (a user gesture). */
    toggle() {
      if (current()) {
        wanted = false;
        storage.set('off');
        try {
          const result = exitFs.call(document);
          if (result && result.catch) result.catch(() => {});
        } catch { /* already left */ }
        return;
      }
      wanted = true;
      storage.set('on');
      enter();
    },
    onChange(fn) { listeners.push(fn); },
  };
})();
