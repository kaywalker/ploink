'use strict';

// Ploink Kontrollzentrum client: shows this phone's panel, its current order and the
// team's progress. All rules live in shared/control-hub.js.

(() => {
  // This tab only relays a scanned QR answer to the host tab (see shared/qr.js).
  if (window.PloinkNet && PloinkNet.relayOnly) return;

  const RECONNECT_DELAY_MS = 1200;

  const $ = (id) => document.getElementById(id);
  const panelEl = $('panel');
  const orderEl = $('order');
  const orderText = $('order-text');
  const orderLabel = $('order-label');
  const LABEL_SHOUT = '📣 Ruf das laut in die Runde!';
  const LABEL_OWN = '🔧 Das Gerät ist auf deinem Pult – mach es selbst!';
  const orderBar = $('order-bar');
  const lobby = $('lobby');
  const banner = $('banner');
  const offlineEl = $('offline');
  const toastsEl = $('toasts');

  const storage = {
    get(store, key) {
      try { return store.getItem(key); } catch { return null; }
    },
    set(store, key, value) {
      try { store.setItem(key, value); } catch { /* private mode */ }
    },
  };

  // Internal room code: from the host's QR join link, or picked by the host itself.
  const roomCode = PloinkNet.roomCode();

  let token = storage.get(sessionStorage, 'ploink-control-token');
  if (!token) {
    token = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    storage.set(sessionStorage, 'ploink-control-token', token);
  }

  let socket = null;
  let reconnectTimer = null;
  let me = { id: null, name: storage.get(localStorage, 'ploink-name') || '', color: '#4dd6ff' };
  let state = null;
  let controls = [];
  let bannerTimer = null;

  // ---------------------------------------------------------------------------
  // Networking
  // ---------------------------------------------------------------------------
  function connect() {
    clearTimeout(reconnectTimer);
    // WebSocket to the Ploink server, or WebRTC to/as the hosting phone (see shared/net.js).
    const ws = PloinkNet.open({ mode: 'control', code: roomCode, wsPath: '/ws/control', hub: window.PloinkControlHub });
    socket = ws;
    ws.addEventListener('open', () => {
      if (ws.role === 'host') toast('📡 Du bist Gastgeber – lass diese Seite offen und das Display an.');
      send({ type: 'join', code: roomCode, name: me.name, token });
    });
    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleMessage(msg);
    });
    ws.addEventListener('close', () => {
      if (socket !== ws) return;
      socket = null;
      offlineEl.hidden = false;
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });
  }

  function send(msg) {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg));
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'joined':
        me = { id: msg.you, name: msg.name, color: msg.color };
        if (msg.token) {
          token = msg.token;
          storage.set(sessionStorage, 'ploink-control-token', token);
        }
        offlineEl.hidden = true;
        break;
      case 'error':
        alert(msg.message);
        location.replace('./');
        break;
      case 'state':
        applyState(msg);
        break;
      case 'panel':
        controls = msg.controls;
        renderPanel();
        break;
      case 'order':
        showOrder(msg);
        break;
      case 'acted':
        showActionFeedback(msg);
        break;
      case 'event':
        handleEvent(msg);
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // State and events
  // ---------------------------------------------------------------------------
  function applyState(msg) {
    const previous = state ? state.phase : null;
    state = msg;
    $('hud-level').textContent = msg.level || 1;
    $('hud-count').textContent = msg.players.filter((p) => p.connected).length;
    $('stability').replaceChildren(...Array.from({ length: msg.maxStability }, (_, i) => {
      const seg = document.createElement('span');
      seg.className = i < msg.stability ? 'seg on' : 'seg';
      return seg;
    }));
    document.body.classList.toggle('alarm', msg.phase === 'playing' && msg.stability <= 2);
    const pct = msg.target ? Math.min(100, (msg.progress / msg.target) * 100) : 0;
    $('progress-bar').style.width = `${pct}%`;
    $('progress-text').textContent = msg.target ? `${msg.progress} / ${msg.target}` : '';

    const inLobby = msg.phase === 'lobby' || msg.phase === 'over';
    lobby.hidden = !inLobby;
    renderCrew(msg.players);
    if (inLobby) {
      showOrder({ text: null, ms: 0 });
      $('start').textContent = msg.phase === 'over' ? 'Nochmal!' : 'Schicht starten';
      $('results').hidden = msg.phase !== 'over';
      $('lobby-title').textContent = msg.phase === 'over' ? '💥 Die Station ist ausgefallen!' : 'Haltet die Station am Laufen!';
      if (msg.phase === 'over') renderResults(msg);
    }

    if (msg.phase === 'countdown') {
      countdownBanner(msg.phaseInMs);
    } else if (msg.phase === 'break') {
      showBanner(`Level ${msg.level} geschafft!`, 'Gleich wird’s schneller …');
    } else if (msg.phase !== previous) {
      hideBanner();
    }
  }

  function handleEvent(msg) {
    if (msg.kind === 'join' && msg.id !== me.id) {
      toast(`${msg.name} ist an Bord`, msg.color);
    } else if (msg.kind === 'done') {
      if (msg.issuer === me.id) flashOrder('ok', msg.by.id === me.id ? '✓ Erledigt!' : `✓ Erledigt von ${msg.by.name}!`);
      if (msg.by.id === me.id) vibrate(25);
    } else if (msg.kind === 'fail') {
      if (msg.id === me.id) {
        flashOrder('fail', '✕ Zu spät!');
        vibrate([80, 40, 80]);
      } else {
        toast(`💥 Verpasst: ${msg.text}`);
      }
      document.body.classList.remove('shake');
      void document.body.offsetWidth; // restart the animation
      document.body.classList.add('shake');
    } else if (msg.kind === 'over') {
      vibrate([200, 100, 200]);
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function renderCrew(players) {
    $('crew').replaceChildren(...players.map((p, i) => {
      const li = document.createElement('li');
      li.style.setProperty('--seat-color', p.color);
      if (p.id === me.id) li.classList.add('me');
      if (!p.connected) li.classList.add('offline');
      const num = document.createElement('b');
      num.textContent = i + 1;
      const name = document.createElement('span');
      name.textContent = p.id === me.id ? `${p.name} (du)` : p.name;
      li.append(num, name);
      return li;
    }));
  }

  function renderResults(msg) {
    $('results-text').textContent = `Level ${msg.level} erreicht · ${msg.completed} Befehle erledigt`;
    const sorted = [...msg.players].sort((a, b) => b.done - a.done);
    $('results-list').replaceChildren(...sorted.map((p, i) => {
      const li = document.createElement('li');
      if (p.id === me.id) li.classList.add('me');
      const medal = document.createElement('span');
      medal.textContent = ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
      const name = document.createElement('span');
      name.textContent = p.name;
      name.style.color = p.color;
      const score = document.createElement('strong');
      score.textContent = `${p.done} ✓`;
      li.append(medal, name, score);
      return li;
    }));
  }

  function renderPanel() {
    panelEl.replaceChildren(...controls.map((c) => {
      const card = document.createElement('div');
      card.className = `ctl ctl-${c.type}`;
      card.dataset.control = c.id;
      const label = document.createElement('p');
      label.className = 'ctl-name';
      label.textContent = c.name;
      card.append(label, widgetFor(c));
      return card;
    }));
  }

  function widgetFor(c) {
    if (c.type === 'button') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctl-press';
      b.textContent = 'DRÜCKEN';
      b.dataset.control = c.id;
      b.addEventListener('click', () => {
        send({ type: 'act', id: c.id, value: 1 });
        vibrate(10);
      });
      return b;
    }
    if (c.type === 'toggle') {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctl-switch';
      b.dataset.control = c.id;
      const update = () => {
        b.setAttribute('aria-pressed', String(!!c.value));
        b.textContent = c.value ? 'AN' : 'AUS';
      };
      b.addEventListener('click', () => {
        c.value = c.value ? 0 : 1;
        update();
        send({ type: 'act', id: c.id, value: c.value });
        vibrate(10);
      });
      update();
      return b;
    }
    const wrap = document.createElement('div');
    wrap.className = 'ctl-steps';
    wrap.dataset.control = c.id;
    const buttons = Array.from({ length: c.max + 1 }, (_, v) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = v;
      b.dataset.value = v;
      b.addEventListener('click', () => {
        c.value = v;
        buttons.forEach((x, i) => x.classList.toggle('active', i <= v));
        send({ type: 'act', id: c.id, value: v });
        vibrate(10);
      });
      return b;
    });
    buttons.forEach((x, i) => x.classList.toggle('active', i <= c.value));
    wrap.append(...buttons);
    return wrap;
  }

  let orderId = null;
  let flashTimer = null;
  function showOrder(msg) {
    orderId = msg.id || null;
    orderEl.classList.remove('ok', 'fail');
    orderEl.classList.toggle('own', !!(msg.text && msg.own));
    orderLabel.textContent = msg.text && msg.own ? LABEL_OWN : LABEL_SHOUT;
    clearTimeout(flashTimer);
    if (!msg.text) {
      if (!orderEl.classList.contains('flashing')) orderText.textContent = '…';
      setBar(0, 0);
      return;
    }
    orderEl.classList.remove('flashing');
    orderText.textContent = msg.text;
    setBar(100, 0);
    // Next frame: shrink the bar over the order's lifetime.
    requestAnimationFrame(() => requestAnimationFrame(() => setBar(0, msg.ms)));
    vibrate(15);
  }

  function setBar(percent, ms) {
    orderBar.style.transition = ms ? `width ${ms}ms linear, background-color ${ms}ms linear` : 'none';
    orderBar.style.width = `${percent}%`;
    orderBar.classList.toggle('running', !!ms);
  }

  function flashOrder(kind, text) {
    orderEl.classList.remove('ok', 'fail');
    orderEl.classList.add(kind, 'flashing');
    orderText.textContent = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      orderEl.classList.remove(kind, 'flashing');
      if (!orderId) orderText.textContent = '…';
    }, 900);
  }

  /** Feedback on the control that was just used: was it asked for, and by whom? */
  function showActionFeedback(msg) {
    const card = panelEl.querySelector(`.ctl[data-control="${msg.id}"]`);
    if (!card) return;
    let text;
    if (!msg.ok) {
      text = 'Hat gerade keiner verlangt';
    } else if (msg.for.length === 1 && msg.for[0].id === me.id) {
      text = '✓ Richtig – dein eigener Befehl';
    } else {
      text = `✓ Richtig – Befehl von ${msg.for.map((p) => p.name).join(' & ')}`;
    }
    card.querySelector('.ctl-feedback')?.remove();
    const pill = document.createElement('span');
    pill.className = 'ctl-feedback';
    pill.textContent = text;
    card.append(pill);
    card.classList.remove('hit', 'miss');
    void card.offsetWidth; // restart the animation
    card.classList.add(msg.ok ? 'hit' : 'miss');
    clearTimeout(card.feedbackTimer);
    card.feedbackTimer = setTimeout(() => {
      card.classList.remove('hit', 'miss');
      pill.remove();
    }, 1400);
  }

  function showBanner(title, subtitle = '') {
    clearInterval(bannerTimer);
    renderBanner(title, subtitle);
  }

  function renderBanner(title, subtitle) {
    banner.hidden = false;
    banner.replaceChildren();
    const t = document.createElement('div');
    t.textContent = title;
    banner.append(t);
    if (subtitle) {
      const s = document.createElement('small');
      s.textContent = subtitle;
      banner.append(s);
    }
  }

  function countdownBanner(ms) {
    const end = performance.now() + ms;
    const tick = () => {
      const left = Math.max(1, Math.ceil((end - performance.now()) / 1000));
      renderBanner(String(left), 'Alle bereit?');
    };
    clearInterval(bannerTimer);
    tick();
    bannerTimer = setInterval(tick, 200);
  }

  function hideBanner() {
    clearInterval(bannerTimer);
    banner.hidden = true;
  }

  function toast(text, color) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    if (color) el.style.borderColor = color;
    toastsEl.append(el);
    setTimeout(() => el.remove(), 2700);
    while (toastsEl.children.length > 3) toastsEl.firstChild.remove();
  }

  function vibrate(pattern) {
    // Browsers refuse vibration before the first tap and log an error for every attempt.
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch { /* ignore */ }
    }
  }

  $('start').addEventListener('click', () => send({ type: 'start' }));

  connect();

  // Expose a tiny hook for automated tests.
  window.__control = {
    get state() { return state; },
    get controls() { return controls; },
    get order() { return { id: orderId, text: orderText.textContent }; },
  };
})();
