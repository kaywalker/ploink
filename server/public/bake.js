'use strict';

// Ploink Plätzchen-Duell client: the interactive baking stations on this phone. The
// phone reports what the player did at each station; scoring, the recipe and the
// comparison at the end live in shared/bake-hub.js.

(() => {
  const H = window.PloinkBakeHub;
  const RECONNECT_DELAY_MS = 1200;
  const STATIONS = H.STATIONS;

  const $ = (id) => document.getElementById(id);
  const stationEl = $('station');
  const bodyEl = $('station-body');
  const nextBtn = $('next');
  const lobbyEl = $('lobby');
  const recipeEl = $('recipe');
  const resultsEl = $('results');
  const waitingEl = $('waiting');
  const bannerEl = $('banner');
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

  const roomCode = PloinkNet.roomCodeFromHash(); // "#42"
  if (!/^\d{2}$/.test(roomCode)) {
    location.replace('./');
    return;
  }

  let token = storage.get(sessionStorage, 'ploink-bake-token');
  if (!token) {
    token = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
    storage.set(sessionStorage, 'ploink-bake-token', token);
  }

  const UTENSIL_KEY = 'ploink-bake-utensils';
  function ownedUtensils() {
    try {
      const list = JSON.parse(storage.get(localStorage, UTENSIL_KEY) || '[]');
      return Array.isArray(list) ? list.filter((id) => Object.hasOwn(H.UTENSILS, id)) : [];
    } catch {
      return [];
    }
  }

  let socket = null;
  let reconnectTimer = null;
  let me = { id: null, name: storage.get(localStorage, 'ploink-name') || '', color: '#ff8fab' };
  let state = null;
  let recipe = null;
  let localRound = 0;
  let stationIndex = -1;
  let steps = {};            // what this phone submitted per station (for the visuals)
  let rejoinSteps = null;    // steps the hub still had when this phone came back
  let current = null;        // the active station: { collect, check, cleanup, resize }
  let bannerTimer = null;
  let lastResults = null;
  let cookieList = [];       // shapes of the cut cookies in cutting order

  // ---------------------------------------------------------------------------
  // Networking
  // ---------------------------------------------------------------------------
  function connect() {
    clearTimeout(reconnectTimer);
    // WebSocket to the Ploink server, or WebRTC to/as the hosting phone (see shared/net.js).
    const ws = PloinkNet.open({ mode: 'bake', code: roomCode, wsPath: '/ws/bake', hub: H });
    socket = ws;
    ws.addEventListener('open', () => {
      if (ws.role === 'host') toast('📡 Du bist Gastgeber – lass diese Seite offen und das Display an.');
      send({ type: 'join', code: roomCode, name: me.name, token, owned: ownedUtensils() });
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
          storage.set(sessionStorage, 'ploink-bake-token', token);
        }
        rejoinSteps = msg.steps || null;
        offlineEl.hidden = true;
        break;
      case 'error':
        alert(msg.message);
        location.replace('./');
        break;
      case 'state':
        applyState(msg);
        break;
      case 'stepped':
        if (state && state.phase === 'baking' && msg.station !== stationIndex) enterStation(msg.station);
        break;
      case 'results':
        showResults(msg);
        break;
      case 'event':
        if (msg.kind === 'join' && msg.id !== me.id) toast(`${msg.name} steht jetzt in der Backstube`, msg.color);
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Room state
  // ---------------------------------------------------------------------------
  function applyState(msg) {
    const previous = state ? state.phase : null;
    state = msg;
    if (msg.recipe) recipe = msg.recipe;
    renderRivals(msg.players);
    renderCrew(msg.players);
    renderUtensils();

    lobbyEl.hidden = msg.phase !== 'lobby';
    $('recipe-button').hidden = !recipe || msg.phase === 'lobby';
    if (msg.phase !== 'results') resultsEl.hidden = true;

    // Round numbers start at 1 again in a new room (server restart, new P2P host).
    if (msg.phase === 'countdown' || msg.phase === 'lobby') localRound = 0;

    if (msg.phase === 'countdown') {
      stopStation();
      countdownBanner(msg.countdownMs);
    } else if (previous === 'countdown' || msg.phase !== previous) {
      hideBanner();
    }

    if (msg.phase === 'baking') {
      const mine = msg.players.find((p) => p.id === me.id);
      if (mine && mine.inRound && localRound !== msg.round) {
        localRound = msg.round;
        steps = rejoinSteps && mine.station > 0 ? rejoinSteps : {};
        rejoinSteps = null;
        cookieList = cookiesFrom(steps.cut);
        renderRecipe();
        enterStation(mine ? mine.station : 0);
        if (stationIndex === 0) openRecipe(true);
      } else if (mine && !mine.inRound) {
        stopStation();
        showWaiting('Die Runde läuft schon – bei der nächsten bist du dabei.');
      } else if (stationIndex >= STATIONS.length) {
        updateWaitingText();
      }
    } else if (msg.phase === 'lobby' || msg.phase === 'results') {
      stopStation();
    }
  }

  function stopStation() {
    if (current && current.cleanup) current.cleanup();
    current = null;
    stationEl.hidden = true;
    waitingEl.hidden = true;
  }

  function renderRivals(players) {
    $('rivals').replaceChildren(...players.filter((p) => p.inRound || state.phase === 'lobby').map((p) => {
      const li = document.createElement('li');
      li.style.setProperty('--seat-color', p.color);
      if (p.id === me.id) li.classList.add('me');
      if (!p.connected) li.classList.add('offline');
      const name = document.createElement('span');
      name.className = 'rival-name';
      name.textContent = p.id === me.id ? 'Du' : p.name;
      const prog = document.createElement('span');
      prog.className = 'rival-step';
      if (state.phase === 'baking' || state.phase === 'results') {
        prog.textContent = p.finished ? '🍽️ fertig' : `${H.STATION_INFO[STATIONS[p.station]].icon} ${p.station + 1}/${STATIONS.length}`;
      }
      li.append(name, prog);
      return li;
    }));
  }

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
    const others = players.filter((p) => p.id !== me.id && p.connected).length;
    $('lobby-hint').textContent = others > 0
      ? 'Ihr seid zu zweit – los geht’s!'
      : `Warte auf eine zweite Person mit Code ${roomCode} – oder übe alleine (ab 90 % gibt’s auch einen Preis).`;
  }

  function renderUtensils() {
    const owned = ownedUtensils();
    $('utensil-count').textContent = `${owned.length} / ${Object.keys(H.UTENSILS).length}`;
    const list = $('utensil-list');
    if (owned.length === 0) {
      list.textContent = 'Noch keine – gewinn dein erstes!';
      return;
    }
    list.replaceChildren(...owned.map((id) => {
      const span = document.createElement('span');
      span.className = 'utensil';
      span.textContent = H.UTENSILS[id].emoji;
      span.title = H.UTENSILS[id].name;
      return span;
    }));
  }

  // ---------------------------------------------------------------------------
  // Recipe card
  // ---------------------------------------------------------------------------
  function renderRecipe() {
    if (!recipe) return;
    $('recipe-title').textContent = recipe.title;
    const lines = H.recipeSteps(recipe);
    $('recipe-steps').replaceChildren(...STATIONS.map((id, i) => {
      const li = document.createElement('li');
      li.dataset.station = id;
      if (i < stationIndex) li.classList.add('done');
      if (i === stationIndex) li.classList.add('current');
      const head = document.createElement('strong');
      head.textContent = `${H.STATION_INFO[id].icon} ${H.STATION_INFO[id].title}`;
      const ul = document.createElement('ul');
      for (const line of lines[id]) {
        const item = document.createElement('li');
        item.textContent = line;
        ul.append(item);
      }
      li.append(head, ul);
      return li;
    }));
  }

  function openRecipe(first = false) {
    if (!recipe) return;
    renderRecipe();
    $('recipe-close').textContent = first ? 'Los geht’s!' : 'Alles klar';
    recipeEl.hidden = false;
    const currentStep = recipeEl.querySelector('li.current');
    if (currentStep) currentStep.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------------------
  // Stations
  // ---------------------------------------------------------------------------
  const HINTS = {
    dough: 'Zutat im Regal antippen, auf der Waage abwiegen, in die Schüssel kippen. Dann in der Schüssel Kreise ziehen.',
    roll: 'Mit dem Finger hoch und runter wischen. Die Dicke steht rechts.',
    cut: 'Förmchen wählen und auf den Teig tippen. Antippen eines Plätzchens nimmt es wieder weg.',
    bake: 'Temperatur einstellen, Blech rein – und rechtzeitig wieder raus!',
    icing: 'Jetzt den Zuckerguss anrühren – genau wie den Teig.',
    color: 'Spritzbeutel wählen und Tropfen in den Guss geben. Raus geht nichts mehr!',
    sprinkle: 'Streudose wählen und über die Plätzchen streuen.',
    plate: 'Tippe die Plätzchen an, um sie auf den Teller zu legen.',
  };

  let confirmArmed = null;

  function enterStation(index) {
    if (current && current.cleanup) current.cleanup();
    current = null;
    confirmArmed = null;
    stationIndex = index;
    if (index >= STATIONS.length) {
      stationEl.hidden = true;
      showWaiting();
      return;
    }
    const id = STATIONS[index];
    waitingEl.hidden = true;
    stationEl.hidden = false;
    stationEl.dataset.station = id;
    $('station-kicker').textContent = `Schritt ${index + 1} / ${STATIONS.length}`;
    $('station-title').textContent = `${H.STATION_INFO[id].icon} ${H.STATION_INFO[id].title}`;
    $('station-hint').textContent = HINTS[id];
    bodyEl.replaceChildren();
    bodyEl.scrollTop = 0;
    toastsEl.replaceChildren();
    nextBtn.classList.remove('armed');
    current = BUILDERS[id](bodyEl);
    nextBtn.textContent = current.nextLabel || 'Fertig ✓';
    nextBtn.disabled = false;
    renderRecipe();
  }

  nextBtn.addEventListener('click', () => {
    if (!current || stationIndex < 0 || stationIndex >= STATIONS.length) return;
    const problem = current.check ? current.check() : null;
    if (problem && confirmArmed !== stationIndex) {
      confirmArmed = stationIndex;
      toast(`${problem} Nochmal tippen, um trotzdem weiterzumachen.`);
      nextBtn.classList.add('armed');
      setTimeout(() => nextBtn.classList.remove('armed'), 2500);
      return;
    }
    const id = STATIONS[stationIndex];
    const data = H.sanitizeStep(id, current.collect());
    steps[id] = data;
    send({ type: 'step', station: id, data });
    sound('plop');
    vibrate(20);
    enterStation(stationIndex + 1);
  });

  const BUILDERS = {
    dough: (body) => buildMix(body, 'dough'),
    roll: buildRoll,
    cut: buildCut,
    bake: buildBake,
    icing: (body) => buildMix(body, 'icing'),
    color: buildColor,
    sprinkle: buildSprinkle,
    plate: buildPlate,
  };

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function fitCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: rect.width, h: rect.height };
  }

  function canvasPoint(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** Repeats `fn(dtSeconds, heldSeconds)` while a button is held down. */
  function holdRepeat(button, fn) {
    let timer = null;
    let started = 0;
    let last = 0;
    const stop = () => {
      clearInterval(timer);
      timer = null;
      button.classList.remove('holding');
    };
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (button.disabled) return;
      try { button.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      started = last = performance.now();
      button.classList.add('holding');
      fn(0, 0, true);
      clearInterval(timer);
      timer = setInterval(() => {
        const now = performance.now();
        fn((now - last) / 1000, (now - started) / 1000, false);
        last = now;
      }, 50);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, stop);
    button.addEventListener('contextmenu', (e) => e.preventDefault());
    return stop;
  }

  // ----------------------------------------------------------- mix (dough, icing)
  function buildMix(body, kind) {
    const added = {};
    let onScale = null; // { id, amount }
    let stir = 0;
    let stirAngle = 0;
    let spoon = null;

    const shelf = el('div', 'shelf');
    const ids = Object.keys(H.INGREDIENTS);
    const jars = new Map();
    for (let row = 0; row < 3; row++) {
      const shelfRow = el('div', 'shelf-row');
      for (const id of ids.slice(row * 5, row * 5 + 5)) {
        const ing = H.INGREDIENTS[id];
        const jar = el('button', 'jar');
        jar.type = 'button';
        jar.style.setProperty('--jar', ing.color);
        jar.dataset.id = id;
        jar.append(el('span', 'jar-icon', ing.emoji), el('span', 'jar-label', ing.label || ing.name));
        jar.addEventListener('click', () => pickJar(id));
        jars.set(id, jar);
        shelfRow.append(jar);
      }
      shelf.append(shelfRow);
    }

    const bench = el('div', 'bench');
    const scaleBox = el('div', 'scale');
    const pan = el('div', 'scale-pan');
    const pile = el('span', 'scale-pile');
    pan.append(pile);
    const display = el('div', 'scale-display', '0 g');
    const scaleName = el('div', 'scale-name', 'Waage leer');
    const rowA = el('div', 'scale-row');
    const minus = el('button', 'scale-btn', '−');
    minus.type = 'button';
    minus.setAttribute('aria-label', 'Etwas wegnehmen');
    const pour = el('button', 'scale-btn pour', 'Halten: schütten');
    pour.type = 'button';
    rowA.append(minus, pour);
    const rowB = el('div', 'scale-row');
    const back = el('button', 'scale-btn ghost', '↩ Regal');
    back.type = 'button';
    const tip = el('button', 'scale-btn ok', '✓ Schüssel');
    tip.type = 'button';
    rowB.append(back, tip);
    scaleBox.append(pan, display, scaleName, rowA, rowB);

    const bowlBox = el('div', 'bowl-box');
    const bowl = el('canvas', 'bowl-canvas');
    const meter = el('div', 'stir-meter');
    const meterBar = el('span');
    const meterText = el('small', '', 'Rühren: 0 %');
    meter.append(meterBar, meterText);
    bowlBox.append(bowl, meter);
    bench.append(scaleBox, bowlBox);

    const chips = el('div', 'bowl-chips');
    body.append(shelf, bench, chips);

    let view = fitCanvas(bowl);

    function unit() {
      return onScale ? H.INGREDIENTS[onScale.id].unit : 'g';
    }

    function amountText() {
      if (!onScale) return '0 g';
      const ing = H.INGREDIENTS[onScale.id];
      const v = Math.round(onScale.amount);
      if (ing.unit === 'Stk') return `${v} ${v === 1 ? ing.one : ing.many}`;
      return `${v} ${ing.unit}`;
    }

    function updateScale() {
      display.textContent = amountText();
      for (const [id, jar] of jars) jar.classList.toggle('picked', !!onScale && onScale.id === id);
      if (!onScale) {
        scaleName.textContent = 'Waage leer – Zutat antippen';
        pile.textContent = '';
        pour.textContent = 'Halten: schütten';
      } else {
        const ing = H.INGREDIENTS[onScale.id];
        scaleName.textContent = ing.name;
        const count = ing.unit === 'g' ? Math.min(1, onScale.amount / 300) : Math.min(1, onScale.amount / 5);
        pile.textContent = onScale.amount > 0 ? ing.emoji : '';
        pile.style.fontSize = `${20 + 30 * count}px`;
        pour.textContent = ing.unit === 'g' ? 'Halten: schütten' : `+1 ${ing.unit === 'Stk' ? ing.one : 'EL'}`;
      }
      const has = !!onScale && onScale.amount > 0;
      tip.disabled = !has;
      minus.disabled = !has;
      back.disabled = !onScale;
      pour.disabled = !onScale;
    }

    function updateBowl() {
      chips.replaceChildren(...Object.entries(added).map(([id, amount]) => el('span', 'chip', H.formatAmount(id, amount))));
      if (Object.keys(added).length === 0) chips.append(el('span', 'chip empty', 'Schüssel ist leer'));
      meterBar.style.width = `${Math.round(stir * 100)}%`;
      meterText.textContent = stir >= 1 ? 'Glatt gerührt ✓' : `Rühren: ${Math.floor(stir * 100)} %`;
      meter.classList.toggle('done', stir >= 1);
      drawBowl();
    }

    function pickJar(id) {
      if (onScale && onScale.id !== id && onScale.amount > 0) {
        toast('Erst die Waage leeren: ✓ in die Schüssel oder ↩ zurück ins Regal.');
        jars.get(onScale.id).classList.add('nudge');
        setTimeout(() => jars.get(onScale.id)?.classList.remove('nudge'), 400);
        return;
      }
      onScale = { id, amount: 0 };
      sound('tick');
      updateScale();
    }

    holdRepeat(pour, (dt, held, first) => {
      if (!onScale) return;
      const u = unit();
      if (u !== 'g') {
        if (first) {
          onScale.amount = Math.min(H.UNIT_MAX[u], onScale.amount + 1);
          sound('tick');
        }
      } else {
        // Slow at first (a short tap is a pinch), then faster and faster.
        const rate = 6 + 110 * Math.min(1, held / 2.2) ** 2;
        onScale.amount = Math.min(H.UNIT_MAX.g, onScale.amount + (first ? 1 : rate * dt));
        if (Math.random() < 0.3) sound('tick');
      }
      updateScale();
    });
    holdRepeat(minus, (dt, held, first) => {
      if (!onScale) return;
      const u = unit();
      if (u !== 'g') {
        if (first) onScale.amount = Math.max(0, onScale.amount - 1);
      } else {
        const rate = 4 + 60 * Math.min(1, held / 2) ** 2;
        onScale.amount = Math.max(0, onScale.amount - (first ? 1 : rate * dt));
      }
      updateScale();
    });
    back.addEventListener('click', () => {
      onScale = null;
      updateScale();
    });
    tip.addEventListener('click', () => {
      if (!onScale || onScale.amount <= 0) return;
      const amount = Math.round(onScale.amount);
      if (amount > 0) {
        added[onScale.id] = (added[onScale.id] || 0) + amount;
        stir *= 0.4; // fresh ingredients need stirring again
      }
      onScale = null;
      sound('plop');
      vibrate(15);
      updateScale();
      updateBowl();
    });

    // Stirring: circles around the bowl's centre.
    let lastAngle = null;
    bowl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { bowl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const p = canvasPoint(bowl, e);
      lastAngle = Math.atan2(p.y - view.h / 2, p.x - view.w / 2);
      spoon = p;
      drawBowl();
    });
    bowl.addEventListener('pointermove', (e) => {
      if (lastAngle === null) return;
      const p = canvasPoint(bowl, e);
      const a = Math.atan2(p.y - view.h / 2, p.x - view.w / 2);
      let d = a - lastAngle;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      lastAngle = a;
      spoon = p;
      if (Object.keys(added).length > 0 && Math.abs(d) < 1.2) {
        const before = stir;
        stir = Math.min(1, stir + Math.abs(d) / (2 * Math.PI * H.CONFIG.stirTurns));
        stirAngle += d;
        if (before < 1 && stir >= 1) {
          sound('ding');
          vibrate(30);
        }
        updateBowl();
      } else {
        drawBowl();
      }
    });
    const endStir = () => {
      lastAngle = null;
      spoon = null;
      drawBowl();
    };
    bowl.addEventListener('pointerup', endStir);
    bowl.addEventListener('pointercancel', endStir);

    function drawBowl() {
      const { ctx, w, h } = view;
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2;
      const cy = h / 2;
      const r = Math.min(w, h) * 0.46;
      // bowl rim and inside
      ctx.fillStyle = '#d7e3ea';
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#9fb3c0';
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.86, 0, Math.PI * 2);
      ctx.fill();
      const ids = Object.keys(added);
      if (ids.length > 0) {
        const total = Object.entries(added).reduce((s, [id, v]) => s + (H.INGREDIENTS[id].unit === 'g' ? v : v * 50), 0);
        const fill = r * (0.45 + 0.35 * Math.min(1, total / 600));
        const base = kind === 'dough' ? H.doughColor(added) : (added.puderzucker ? H.mix('#fbfaf6', '#fff27a', added.puderzucker ? 0.1 : 0.6) : '#fff27a');
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, fill, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = base;
        ctx.fillRect(cx - fill, cy - fill, fill * 2, fill * 2);
        // unmixed lumps of every ingredient
        ids.forEach((id, i) => {
          const ing = H.INGREDIENTS[id];
          ctx.globalAlpha = 0.9 * (1 - stir);
          ctx.fillStyle = ing.color;
          const a = i * 2.4 + stirAngle * 0.5;
          const d = fill * (0.25 + 0.35 * ((i * 37) % 10) / 10);
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, fill * 0.32, 0, Math.PI * 2);
          ctx.fill();
        });
        // swirl
        ctx.globalAlpha = 0.25 + 0.2 * stir;
        ctx.strokeStyle = H.mix(base, '#000000', 0.25);
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let t = 0; t < 14; t += 0.1) {
          const rr = (t / 14) * fill * 0.9;
          const x = cx + Math.cos(t + stirAngle) * rr;
          const y = cy + Math.sin(t + stirAngle) * rr;
          if (t === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = '600 13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('leer', cx, cy + 4);
      }
      // wooden spoon
      const sp = spoon || { x: cx + r * 0.35, y: cy - r * 0.2 };
      ctx.save();
      ctx.strokeStyle = '#b7834f';
      ctx.lineCap = 'round';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(sp.x, sp.y);
      ctx.lineTo(sp.x + r * 0.9, sp.y - r * 1.1);
      ctx.stroke();
      ctx.fillStyle = '#c99561';
      ctx.beginPath();
      ctx.ellipse(sp.x, sp.y, 11, 15, -0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    updateScale();
    updateBowl();

    return {
      collect: () => ({ added, stir }),
      check() {
        if (onScale && onScale.amount > 0) return 'Auf der Waage liegt noch etwas.';
        if (Object.keys(added).length === 0) return 'Die Schüssel ist noch leer.';
        if (stir < 1) return 'Noch nicht glatt gerührt.';
        return null;
      },
      resize() {
        view = fitCanvas(bowl);
        drawBowl();
      },
    };
  }

  // ------------------------------------------------------------------ rolling
  const START_MM = 20;

  /** Dough sheet size for a thickness: the same dough gets wider when it gets thinner. */
  function doughSheet(w, h, mm) {
    const s = Math.sqrt(START_MM / Math.max(1, mm));
    const rx = Math.min(w * 0.47, w * 0.2 * s);
    const ry = Math.min(h * 0.45, rx * 0.78);
    return { cx: w / 2, cy: h / 2, rx, ry };
  }

  function buildRoll(body) {
    let mm = START_MM;
    let pinY = null;
    let lastY = null;
    const wrap = el('div', 'roll-wrap');
    const canvas = el('canvas', 'roll-canvas');
    const gauge = el('div', 'gauge');
    const gaugeValue = el('strong', 'gauge-value');
    gauge.append(el('small', '', 'Dicke'), gaugeValue);
    wrap.append(canvas, gauge);
    const reset = el('button', 'btn btn-ghost small-btn', '↺ Neu zusammenkneten');
    reset.type = 'button';
    body.append(wrap, reset);
    let view = fitCanvas(canvas);
    const color = H.doughColor(steps.dough ? steps.dough.added : {});

    function draw() {
      const { ctx, w, h } = view;
      ctx.clearRect(0, 0, w, h);
      drawWorktop(ctx, w, h);
      const sheet = doughSheet(w, h, mm);
      const edge = Math.max(2, mm * 0.9);
      ctx.fillStyle = H.mix(color, '#000000', 0.25);
      ctx.beginPath();
      ctx.ellipse(sheet.cx, sheet.cy + edge, sheet.rx, sheet.ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(sheet.cx, sheet.cy, sheet.rx, sheet.ry, 0, 0, Math.PI * 2);
      ctx.fill();
      // flour dust
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      for (let i = 0; i < 40; i++) {
        const a = i * 2.39996;
        const d = Math.sqrt(i / 40);
        ctx.fillRect(sheet.cx + Math.cos(a) * d * sheet.rx * 0.9, sheet.cy + Math.sin(a) * d * sheet.ry * 0.9, 2, 2);
      }
      // rolling pin
      const y = pinY === null ? sheet.cy - sheet.ry - 26 : pinY;
      drawRollingPin(ctx, w, y);
      gaugeValue.textContent = `${H.num(mm)} mm`;
    }

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      lastY = canvasPoint(canvas, e).y;
      pinY = lastY;
      draw();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (lastY === null) return;
      const y = canvasPoint(canvas, e).y;
      const travel = Math.abs(y - lastY);
      lastY = y;
      pinY = y;
      const sheet = doughSheet(view.w, view.h, mm);
      // Only rolling over the dough makes it thinner.
      if (y > sheet.cy - sheet.ry - 10 && y < sheet.cy + sheet.ry + 10) {
        mm = 1 + (mm - 1) * Math.exp((-0.9 * travel) / view.h);
        if (Math.random() < 0.08) sound('tick');
      }
      draw();
    });
    const end = () => {
      lastY = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    reset.addEventListener('click', () => {
      mm = START_MM;
      pinY = null;
      draw();
    });
    draw();
    return {
      collect: () => ({ mm }),
      check: () => (mm >= START_MM - 0.5 ? 'Du hast noch gar nicht ausgerollt.' : null),
      resize() {
        view = fitCanvas(canvas);
        draw();
      },
    };
  }

  function drawWorktop(ctx, w, h) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#c9a27a');
    g.addColorStop(1, '#b48a62');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(90, 55, 30, 0.18)';
    ctx.lineWidth = 1;
    for (let y = 18; y < h; y += 36) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(w * 0.3, y + 6, w * 0.6, y - 6, w, y + 3);
      ctx.stroke();
    }
  }

  function drawRollingPin(ctx, w, y) {
    ctx.save();
    ctx.fillStyle = '#8a5a35';
    roundRect(ctx, w * 0.02, y - 6, w * 0.96, 12, 6);
    ctx.fill();
    const g = ctx.createLinearGradient(0, y - 15, 0, y + 15);
    g.addColorStop(0, '#f0c995');
    g.addColorStop(0.5, '#d9a66b');
    g.addColorStop(1, '#a8743f');
    ctx.fillStyle = g;
    roundRect(ctx, w * 0.14, y - 15, w * 0.72, 30, 12);
    ctx.fill();
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ------------------------------------------------------------------ cutting
  function cookiesFrom(cut) {
    if (!cut) return [];
    const list = [];
    for (const [shape, n] of Object.entries(cut.shapes)) for (let i = 0; i < n; i++) list.push(shape);
    return list;
  }

  function buildCut(body) {
    const placed = []; // { shape, x, y } in canvas px
    let selected = Object.keys(H.SHAPES)[0];
    const mm = steps.roll ? steps.roll.mm : START_MM;
    const color = H.doughColor(steps.dough ? steps.dough.added : {});

    const canvas = el('canvas', 'cut-canvas');
    const cutters = el('div', 'cutters');
    const buttons = new Map();
    for (const shape of Object.keys(H.SHAPES)) {
      const b = el('button', 'cutter');
      b.type = 'button';
      const icon = el('canvas', 'cutter-icon');
      icon.width = 72;
      icon.height = 72;
      drawCutterIcon(icon, shape);
      b.append(icon, el('span', 'cutter-name', H.SHAPES[shape].one));
      b.addEventListener('click', () => {
        selected = shape;
        update();
      });
      buttons.set(shape, b);
      cutters.append(b);
    }
    const counts = el('div', 'bowl-chips');
    body.append(cutters, canvas, counts);
    let view = fitCanvas(canvas);
    let radius = 0;

    function update() {
      for (const [shape, b] of buttons) b.classList.toggle('picked', shape === selected);
      const tally = {};
      for (const p of placed) tally[p.shape] = (tally[p.shape] || 0) + 1;
      counts.replaceChildren(...Object.entries(tally).map(([shape, n]) => el('span', 'chip', `${n} × ${n === 1 ? H.SHAPES[shape].one : H.SHAPES[shape].many}`)));
      if (placed.length === 0) counts.append(el('span', 'chip empty', 'Noch nichts ausgestochen'));
      draw();
    }

    function draw() {
      const { ctx, w, h } = view;
      radius = Math.min(w, h) * 0.075;
      ctx.clearRect(0, 0, w, h);
      drawWorktop(ctx, w, h);
      const sheet = doughSheet(w, h, mm);
      ctx.fillStyle = H.mix(color, '#000000', 0.25);
      ctx.beginPath();
      ctx.ellipse(sheet.cx, sheet.cy + Math.max(2, mm * 0.9), sheet.rx, sheet.ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(sheet.cx, sheet.cy, sheet.rx, sheet.ry, 0, 0, Math.PI * 2);
      ctx.fill();
      for (const p of placed) {
        // the hole in the dough, then the cookie lifted a little
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.scale(radius, radius);
        ctx.fillStyle = H.mix(color, '#000000', 0.35);
        ctx.fill(shapePath(p.shape));
        ctx.restore();
        drawCookie(ctx, { color, mm, glaze: null, sprinkles: [], doneness: 0 }, p.shape, p.x, p.y - 2, radius * 0.94, 0);
      }
    }

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const p = canvasPoint(canvas, e);
      const hit = placed.findIndex((c) => Math.hypot(c.x - p.x, c.y - p.y) < radius * 0.9);
      if (hit >= 0) {
        placed.splice(hit, 1);
        sound('tick');
        update();
        return;
      }
      const sheet = doughSheet(view.w, view.h, mm);
      const nx = (p.x - sheet.cx) / Math.max(1, sheet.rx - radius * 0.9);
      const ny = (p.y - sheet.cy) / Math.max(1, sheet.ry - radius * 0.9);
      const inside = sheet.rx > radius && sheet.ry > radius && nx * nx + ny * ny <= 1;
      const free = placed.every((c) => Math.hypot(c.x - p.x, c.y - p.y) > radius * 1.85);
      if (!inside || !free) {
        toast(inside ? 'Da ist kein Platz mehr – woanders ausstechen.' : 'Da ist kein Teig.');
        vibrate([20, 30, 20]);
        return;
      }
      placed.push({ shape: selected, x: p.x, y: p.y });
      sound('cut');
      vibrate(12);
      update();
    });

    update();
    return {
      collect() {
        const shapes = {};
        for (const p of placed) shapes[p.shape] = (shapes[p.shape] || 0) + 1;
        cookieList = placed.map((p) => p.shape);
        return { shapes };
      },
      check: () => (placed.length === 0 ? 'Noch keine Plätzchen ausgestochen.' : null),
      resize() {
        // Positions are in pixels: scale them along with the canvas.
        const oldW = view.w;
        const oldH = view.h;
        view = fitCanvas(canvas);
        for (const p of placed) {
          p.x *= view.w / oldW;
          p.y *= view.h / oldH;
        }
        draw();
      },
    };
  }

  function drawCutterIcon(canvas, shape) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(canvas.width * 0.38, canvas.width * 0.38);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 0.16;
    ctx.strokeStyle = '#8d99a6';
    ctx.stroke(shapePath(shape));
    ctx.lineWidth = 0.07;
    ctx.strokeStyle = '#eef3f7';
    ctx.stroke(shapePath(shape));
    ctx.restore();
  }

  // ------------------------------------------------------------- cookie looks
  const SHAPE_PATHS = new Map();

  /** Unit-size outline of a cutter shape, centred on 0/0, about radius 1. */
  function shapePath(shape) {
    if (SHAPE_PATHS.has(shape)) return SHAPE_PATHS.get(shape);
    const p = new Path2D();
    const poly = (pts) => {
      pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
      p.closePath();
    };
    switch (shape) {
      case 'stern': {
        const pts = [];
        for (let i = 0; i < 10; i++) {
          const r = i % 2 ? 0.45 : 1;
          const a = -Math.PI / 2 + (i * Math.PI) / 5;
          pts.push([Math.cos(a) * r, Math.sin(a) * r + 0.08]);
        }
        poly(pts);
        break;
      }
      case 'herz':
        p.moveTo(0, 0.92);
        p.bezierCurveTo(-0.15, 0.78, -1, 0.35, -1, -0.2);
        p.bezierCurveTo(-1, -0.72, -0.42, -0.95, 0, -0.5);
        p.bezierCurveTo(0.42, -0.95, 1, -0.72, 1, -0.2);
        p.bezierCurveTo(1, 0.35, 0.15, 0.78, 0, 0.92);
        p.closePath();
        break;
      case 'mond': {
        // Crescent: a circle minus a shifted one, turned a little.
        const R = 1;
        const d = 0.55;
        const R2 = 0.85;
        const x = (d * d + R * R - R2 * R2) / (2 * d);
        const y = Math.sqrt(R * R - x * x);
        const t1 = Math.atan2(y, x);
        const m = new Path2D();
        m.arc(0, 0, R, t1, 2 * Math.PI - t1, false);
        m.arc(d, 0, R2, Math.atan2(-y, x - d), Math.atan2(y, x - d), true);
        m.closePath();
        p.addPath(m, new DOMMatrix().translate(0.15, 0).rotate(-25));
        break;
      }
      case 'kreis':
        p.arc(0, 0, 0.92, 0, Math.PI * 2);
        break;
      case 'tanne': {
        const right = [[0, -1], [0.42, -0.4], [0.24, -0.4], [0.66, 0.22], [0.42, 0.22], [0.82, 0.7], [0.16, 0.7], [0.16, 0.98]];
        const left = right.slice(1).reverse().map(([x, y]) => [-x, y]);
        poly([...right, ...left]);
        break;
      }
      case 'glocke':
        p.moveTo(0, -0.95);
        p.bezierCurveTo(0.42, -0.95, 0.5, -0.45, 0.52, 0.1);
        p.quadraticCurveTo(0.56, 0.55, 0.85, 0.66);
        p.lineTo(0.85, 0.76);
        p.lineTo(0.2, 0.76);
        p.arc(0, 0.76, 0.2, 0, Math.PI, false);
        p.lineTo(-0.85, 0.76);
        p.lineTo(-0.85, 0.66);
        p.quadraticCurveTo(-0.56, 0.55, -0.52, 0.1);
        p.bezierCurveTo(-0.5, -0.45, -0.42, -0.95, 0, -0.95);
        p.closePath();
        break;
      case 'blume': {
        const pts = [];
        for (let i = 0; i < 80; i++) {
          const a = (i / 80) * Math.PI * 2;
          const r = 0.5 + 0.46 * Math.abs(Math.cos(2.5 * a)) ** 0.45;
          pts.push([Math.cos(a - Math.PI / 2) * r, Math.sin(a - Math.PI / 2) * r]);
        }
        poly(pts);
        break;
      }
      default:
        p.arc(0, 0, 1, 0, Math.PI * 2);
    }
    SHAPE_PATHS.set(shape, p);
    return p;
  }

  const hitCtx = document.createElement('canvas').getContext('2d');
  const SPRINKLE_SPOTS = new Map();

  function seeded(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  /** Positions inside the shape (unit coordinates) for one kind of sprinkles. */
  function sprinkleSpots(shape, kind, n) {
    const key = `${shape}:${kind}`;
    if (SPRINKLE_SPOTS.has(key)) return SPRINKLE_SPOTS.get(key);
    const rng = seeded([...key].reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
    const path = shapePath(shape);
    const spots = [];
    for (let tries = 0; spots.length < n && tries < 400; tries++) {
      const x = (rng() * 2 - 1) * 0.8;
      const y = (rng() * 2 - 1) * 0.8;
      if (hitCtx.isPointInPath(path, x, y) && hitCtx.isPointInPath(path, x * 1.25, y * 1.25)) {
        spots.push({ x, y, a: rng() * Math.PI, c: rng() });
      }
    }
    SPRINKLE_SPOTS.set(key, spots);
    return spots;
  }

  const BUNT = ['#ff5d73', '#ffd23d', '#4dd6ff', '#7ee081', '#c77dff', '#ff9f68'];

  function drawSprinkle(ctx, kind, x, y, s, a, c) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    switch (kind) {
      case 'schoko':
      case 'bunt':
        ctx.fillStyle = kind === 'schoko' ? (c < 0.5 ? '#4a2a17' : '#5e3820') : BUNT[Math.floor(c * BUNT.length)];
        roundRect(ctx, -s * 0.55, -s * 0.16, s * 1.1, s * 0.32, s * 0.16);
        ctx.fill();
        break;
      case 'perlen':
        ctx.fillStyle = c < 0.5 ? '#fff7fb' : '#ffc6dd';
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.28, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'silber': {
        const g = ctx.createRadialGradient(-s * 0.1, -s * 0.1, 0, 0, 0, s * 0.3);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(1, '#8f99a3');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.3, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'kokos':
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = Math.max(1, s * 0.12);
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.4, 0, Math.PI * 0.9);
        ctx.stroke();
        break;
      case 'mandel':
        ctx.fillStyle = c < 0.5 ? '#f1d7ae' : '#e6c08a';
        ctx.strokeStyle = '#b98a52';
        ctx.lineWidth = Math.max(0.6, s * 0.06);
        ctx.beginPath();
        ctx.ellipse(0, 0, s * 0.6, s * 0.32, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        break;
      case 'sterne':
        ctx.fillStyle = '#ffd23d';
        ctx.scale(s * 0.45, s * 0.45);
        ctx.fill(shapePath('stern'));
        break;
      case 'herzen':
        ctx.fillStyle = '#e63946';
        ctx.scale(s * 0.4, s * 0.4);
        ctx.fill(shapePath('herz'));
        break;
      default:
        break;
    }
    ctx.restore();
  }

  /**
   * One cookie. look: { color, mm, doneness, glaze: {color, opacity, texture} | null,
   * sprinkles: [] } (see PloinkBakeHub.lookOf).
   */
  function drawCookie(ctx, look, shape, x, y, r, seed = 0) {
    const path = shapePath(shape);
    const edge = Math.max(1.5, Math.min(10, (look.mm || 5) * 0.6)) * (r / 30);
    ctx.save();
    ctx.translate(x, y);
    // shadow and side
    ctx.save();
    ctx.translate(0, edge + r * 0.05);
    ctx.scale(r, r);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fill(path);
    ctx.restore();
    ctx.save();
    ctx.translate(0, edge);
    ctx.scale(r, r);
    ctx.fillStyle = H.mix(look.color, '#000000', 0.3);
    ctx.fill(path);
    ctx.restore();
    // top
    ctx.save();
    ctx.scale(r, r);
    ctx.fillStyle = look.color;
    ctx.fill(path);
    const shine = ctx.createRadialGradient(-0.3, -0.35, 0, 0, 0, 1.1);
    shine.addColorStop(0, 'rgba(255,255,255,0.28)');
    shine.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = shine;
    ctx.fill(path);
    if (look.doneness > 1.75) {
      // burnt spots
      const rng = seeded(seed * 97 + 5);
      ctx.save();
      ctx.clip(path);
      ctx.fillStyle = 'rgba(15,8,4,0.55)';
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.arc((rng() - 0.5) * 1.1, (rng() - 0.5) * 1.1, 0.12 + rng() * 0.12, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    if (look.glaze) {
      // The glaze stays inside the cookie; a stroke in the cookie colour leaves a rim
      // of the same width around any shape.
      const g = look.glaze;
      ctx.save();
      ctx.clip(path);
      ctx.globalAlpha = g.opacity;
      ctx.fillStyle = g.color;
      ctx.fill(path);
      if (g.texture === 'lumpy') {
        const rng = seeded(seed * 13 + 3);
        ctx.fillStyle = H.mix(g.color, '#000000', 0.08);
        for (let i = 0; i < 6; i++) {
          ctx.beginPath();
          ctx.arc((rng() - 0.5) * 0.9, (rng() - 0.5) * 0.9, 0.1 + rng() * 0.12, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = Math.min(1, g.opacity + 0.1) * 0.35;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(-0.25, -0.3, 0.25, 0.1, -0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineJoin = 'round';
      ctx.lineWidth = g.texture === 'runny' ? 0.1 : 0.3;
      ctx.strokeStyle = look.color;
      ctx.stroke(path);
      ctx.restore();
    }
    ctx.restore();
    for (const kind of look.sprinkles || []) {
      for (const spot of sprinkleSpots(shape, kind, 9)) {
        drawSprinkle(ctx, kind, spot.x * r, spot.y * r, r * 0.2, spot.a, spot.c);
      }
    }
    ctx.restore();
  }

  function myLook(overrides = {}) {
    const look = H.lookOf({ ...steps, ...overrides }, recipe);
    return look;
  }

  /** Grid positions for n cookies on a baking tray. */
  function trayLayout(n, w, h) {
    const cols = Math.max(3, Math.ceil(Math.sqrt(n * (w / h))));
    const rows = Math.max(1, Math.ceil(n / cols));
    const cw = w / cols;
    const ch = h / rows;
    const r = Math.min(cw, ch) * 0.36;
    return Array.from({ length: n }, (_, i) => ({
      x: cw * ((i % cols) + 0.5),
      y: ch * (Math.floor(i / cols) + 0.5),
      r,
    }));
  }

  function drawTray(ctx, x, y, w, h) {
    ctx.save();
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, '#5d646c');
    g.addColorStop(1, '#3f454c');
    ctx.fillStyle = g;
    roundRect(ctx, x, y, w, h, 10);
    ctx.fill();
    ctx.fillStyle = '#f6efe0'; // baking paper
    roundRect(ctx, x + 8, y + 8, w - 16, h - 16, 6);
    ctx.fill();
    ctx.restore();
  }

  // ------------------------------------------------------------------- baking
  function buildBake(body) {
    let temp = 150;
    let phase = 'idle'; // idle | baking | done
    let startedAt = 0;
    let minutes = 0;
    let raf = 0;

    const oven = el('div', 'oven');
    const panel = el('div', 'oven-panel');
    const down = el('button', 'knob', '−');
    down.type = 'button';
    const tempEl = el('strong', 'oven-temp');
    const up = el('button', 'knob', '+');
    up.type = 'button';
    const clock = el('strong', 'oven-clock', '0,0 min');
    const tempBox = el('div', 'oven-group');
    tempBox.append(down, tempEl, up);
    panel.append(tempBox, clock);
    const windowEl = el('div', 'oven-window');
    const canvas = el('canvas', 'oven-canvas');
    windowEl.append(canvas);
    oven.append(panel, windowEl);
    const action = el('button', 'btn oven-action', 'Blech rein 🔥');
    action.type = 'button';
    body.append(oven, action);
    let view = fitCanvas(canvas);
    const baseLook = myLook({ bake: undefined, icing: undefined, color: undefined, sprinkle: undefined });

    function doneness() {
      if (!recipe) return 0;
      return (minutes / recipe.bake.minutes) * (temp / recipe.bake.temp) ** 2;
    }

    function draw() {
      const { ctx, w, h } = view;
      ctx.clearRect(0, 0, w, h);
      const glow = phase === 'baking' ? 0.55 : 0.15;
      const bg = ctx.createRadialGradient(w / 2, h * 0.2, 0, w / 2, h / 2, w * 0.8);
      bg.addColorStop(0, `rgba(255, 170, 60, ${glow})`);
      bg.addColorStop(1, 'rgba(30, 14, 6, 0.95)');
      ctx.fillStyle = '#1a0f09';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
      // heating rods
      ctx.strokeStyle = phase === 'baking' ? '#ff6a2a' : '#5a3020';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(w * 0.08, 10);
      ctx.lineTo(w * 0.92, 10);
      ctx.stroke();
      const tx = w * 0.06;
      const ty = h * 0.18;
      const tw = w * 0.88;
      const th = h * 0.74;
      drawTray(ctx, tx, ty, tw, th);
      const look = { ...baseLook, doneness: doneness(), color: H.bakedColor(baseLook.dough, doneness()) };
      const spots = trayLayout(cookieList.length, tw - 20, th - 20);
      cookieList.forEach((shape, i) => drawCookie(ctx, look, shape, tx + 10 + spots[i].x, ty + 10 + spots[i].y, spots[i].r, i));
      if (look.doneness > 1.45) {
        // smoke
        const t = performance.now() / 1000;
        ctx.fillStyle = `rgba(80, 80, 80, ${Math.min(0.5, (look.doneness - 1.45) * 0.8)})`;
        for (let i = 0; i < 6; i++) {
          const y = h - ((t * 40 + i * 50) % h);
          ctx.beginPath();
          ctx.arc(w * (0.2 + 0.12 * i) + Math.sin(t + i) * 10, y, 18 + (i % 3) * 6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      tempEl.textContent = `${temp} °C`;
      clock.textContent = `${(Math.round(minutes * 10) / 10).toFixed(1).replace('.', ',')} min`;
    }

    function loop() {
      if (phase !== 'baking') return;
      minutes = (performance.now() - startedAt) / H.CONFIG.bakeMsPerMinute;
      draw();
      raf = requestAnimationFrame(loop);
    }

    const setTemp = (delta) => {
      if (phase !== 'idle') return;
      temp = Math.max(50, Math.min(250, temp + delta));
      sound('tick');
      draw();
    };
    holdRepeat(down, (dt, held, first) => {
      if (first || held > 0.4) setTemp(-10);
    });
    holdRepeat(up, (dt, held, first) => {
      if (first || held > 0.4) setTemp(10);
    });

    action.addEventListener('click', () => {
      if (phase === 'idle') {
        phase = 'baking';
        startedAt = performance.now();
        action.textContent = 'Rausholen 🧤';
        action.classList.add('hot');
        down.disabled = true;
        up.disabled = true;
        oven.classList.add('on');
        sound('whoosh');
        loop();
      } else if (phase === 'baking') {
        phase = 'done';
        cancelAnimationFrame(raf);
        minutes = (performance.now() - startedAt) / H.CONFIG.bakeMsPerMinute;
        action.textContent = `Draußen nach ${H.num(Math.round(minutes * 10) / 10)} min ✓`;
        action.classList.remove('hot');
        action.disabled = true;
        oven.classList.remove('on');
        sound('ding');
        vibrate(30);
        draw();
      }
    });

    draw();
    return {
      collect: () => ({ temp, minutes: phase === 'idle' ? 0 : minutes }),
      check() {
        if (phase === 'idle') return 'Die Plätzchen sind noch nicht im Ofen!';
        if (phase === 'baking') return 'Die Plätzchen sind noch im Ofen!';
        return null;
      },
      cleanup() {
        cancelAnimationFrame(raf);
        phase = phase === 'baking' ? 'done' : phase;
      },
      resize() {
        view = fitCanvas(canvas);
        draw();
      },
    };
  }

  // ------------------------------------------------------------------ colours
  function buildColor(body) {
    const drops = {};
    let selected = null;

    const bowlWrap = el('div', 'icing-bowl-wrap');
    const bowl = el('div', 'icing-bowl');
    const surface = el('div', 'icing-surface');
    bowl.append(surface);
    bowlWrap.append(bowl);
    const bags = el('div', 'bags');
    const bagButtons = new Map();
    for (const [id, p] of Object.entries(H.PIPING)) {
      const b = el('button', 'bag');
      b.type = 'button';
      b.style.setProperty('--bag', p.color);
      b.append(el('span', 'bag-cone'), el('span', 'bag-name', p.name));
      b.addEventListener('click', () => {
        selected = id;
        sound('tick');
        update();
      });
      bagButtons.set(id, b);
      bags.append(b);
    }
    const dropBtn = el('button', 'btn drop-btn', '💧 Tropfen hinein');
    dropBtn.type = 'button';
    const tally = el('div', 'bowl-chips');
    body.append(bowlWrap, bags, dropBtn, tally);

    const sugar = steps.icing && steps.icing.added.puderzucker;

    function update() {
      for (const [id, b] of bagButtons) b.classList.toggle('picked', id === selected);
      dropBtn.disabled = !selected;
      dropBtn.textContent = selected ? `💧 Tropfen ${H.PIPING[selected].name} hinein` : 'Erst einen Spritzbeutel wählen';
      surface.style.backgroundColor = sugar ? H.glazeColor(drops) : '#fff27a';
      tally.replaceChildren(...Object.entries(drops).map(([id, n]) => {
        const chip = el('span', 'chip', `${n} × ${H.PIPING[id].name}`);
        chip.style.borderColor = H.PIPING[id].color;
        return chip;
      }));
      if (Object.keys(drops).length === 0) tally.append(el('span', 'chip empty', 'Noch keine Farbe im Guss'));
    }

    dropBtn.addEventListener('click', () => {
      if (!selected) return;
      drops[selected] = (drops[selected] || 0) + 1;
      const drop = el('span', 'falling-drop');
      drop.style.setProperty('--bag', H.PIPING[selected].color);
      drop.style.left = `${40 + Math.random() * 20}%`;
      bowlWrap.append(drop);
      setTimeout(() => drop.remove(), 600);
      setTimeout(update, 350);
      sound('drop');
      vibrate(10);
    });

    update();
    return {
      collect: () => ({ drops }),
      check: () => (Object.keys(drops).length === 0 ? 'Der Guss ist noch ungefärbt.' : null),
    };
  }

  // ---------------------------------------------------------------- sprinkles
  function buildSprinkle(body) {
    const chosen = [];
    let selected = null;
    const canvas = el('canvas', 'tray-canvas');
    const jarsEl = el('div', 'sprinkle-jars');
    const buttons = new Map();
    for (const [id, s] of Object.entries(H.SPRINKLES)) {
      const b = el('button', 'sprinkle-jar');
      b.type = 'button';
      const icon = el('canvas', 'sprinkle-icon');
      icon.width = 80;
      icon.height = 80;
      const ictx = icon.getContext('2d');
      ictx.fillStyle = '#e8d2b0';
      ictx.beginPath();
      ictx.arc(40, 40, 36, 0, Math.PI * 2);
      ictx.fill();
      for (const spot of sprinkleSpots('kreis', id, 12)) drawSprinkle(ictx, id, 40 + spot.x * 38, 40 + spot.y * 38, 14, spot.a, spot.c);
      b.append(icon, el('span', 'sprinkle-name', s.label || s.name));
      b.addEventListener('click', () => {
        if (chosen.includes(id)) return;
        selected = id;
        sound('tick');
        update();
      });
      buttons.set(id, b);
      jarsEl.append(b);
    }
    const shake = el('button', 'btn drop-btn', 'Erst eine Streudose wählen');
    shake.type = 'button';
    body.append(canvas, jarsEl, shake);
    let view = fitCanvas(canvas);

    function draw() {
      const { ctx, w, h } = view;
      ctx.clearRect(0, 0, w, h);
      drawTray(ctx, 0, 0, w, h);
      const look = myLook({ sprinkle: { sprinkles: chosen } });
      const spots = trayLayout(cookieList.length, w - 20, h - 20);
      cookieList.forEach((shape, i) => drawCookie(ctx, look, shape, 10 + spots[i].x, 10 + spots[i].y, spots[i].r, i));
    }

    function update() {
      for (const [id, b] of buttons) {
        b.classList.toggle('picked', id === selected);
        b.classList.toggle('used', chosen.includes(id));
      }
      shake.disabled = !selected;
      shake.textContent = selected ? `✨ ${H.SPRINKLES[selected].name} drüberstreuen` : 'Erst eine Streudose wählen';
      draw();
    }

    shake.addEventListener('click', () => {
      if (!selected || chosen.includes(selected)) return;
      chosen.push(selected);
      selected = null;
      sound('shake');
      vibrate([10, 20, 10, 20, 10]);
      update();
    });

    update();
    return {
      collect: () => ({ sprinkles: chosen }),
      check: () => (chosen.length === 0 ? 'Noch keine Streusel drauf.' : null),
      resize() {
        view = fitCanvas(canvas);
        draw();
      },
    };
  }

  // -------------------------------------------------------------------- plate
  function plateSpots(n, cx, cy, r) {
    if (n === 0) return [];
    const spots = [];
    const cookieR = Math.min(r * 0.24, (r * 2.2) / Math.max(4, n));
    if (n === 1) return [{ x: cx, y: cy, r: cookieR }];
    const inner = Math.min(n, n > 7 ? Math.max(3, Math.round(n / 3)) : 0);
    const outer = n - inner;
    for (let i = 0; i < outer; i++) {
      const a = -Math.PI / 2 + (i / outer) * Math.PI * 2;
      spots.push({ x: cx + Math.cos(a) * r * 0.62, y: cy + Math.sin(a) * r * 0.62, r: cookieR });
    }
    for (let i = 0; i < inner; i++) {
      const a = -Math.PI / 2 + (i / inner) * Math.PI * 2 + 0.4;
      spots.push({ x: cx + Math.cos(a) * r * 0.25, y: cy + Math.sin(a) * r * 0.25, r: cookieR });
    }
    return spots;
  }

  function drawPlateBase(ctx, cx, cy, r) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.06, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f4f1ec';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#7fa7d6';
    ctx.lineWidth = Math.max(1.5, r * 0.025);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.92, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** A full plate for the comparison (any player's look and cookies). */
  function drawPlate(canvas, look) {
    const { ctx, w, h } = fitCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    const r = Math.min(w, h) * 0.47;
    drawPlateBase(ctx, w / 2, h / 2, r);
    const shapes = [];
    for (const [shape, n] of Object.entries(look.shapes || {})) for (let i = 0; i < n; i++) shapes.push(shape);
    const spots = plateSpots(shapes.length, w / 2, h / 2, r * 0.85);
    shapes.forEach((shape, i) => drawCookie(ctx, look, shape, spots[i].x, spots[i].y, spots[i].r, i));
    if (shapes.length === 0) {
      ctx.fillStyle = '#9aa0a6';
      ctx.font = '600 14px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('leer', w / 2, h / 2 + 5);
    }
  }

  function buildPlate(body) {
    const onPlate = new Set();
    const canvas = el('canvas', 'plate-station-canvas');
    const all = el('button', 'btn btn-ghost small-btn', 'Alle auf einmal rüberlegen');
    all.type = 'button';
    body.append(canvas, all);
    let view = fitCanvas(canvas);
    const look = myLook();
    const anims = new Map(); // index -> start time

    function layout() {
      const { w, h } = view;
      const trayH = h * 0.38;
      const tray = trayLayout(cookieList.length, w - 36, trayH - 36).map((s) => ({ ...s, x: s.x + 18, y: s.y + 18 }));
      const pr = Math.min(w * 0.46, (h - trayH) * 0.46);
      const plate = { cx: w / 2, cy: trayH + (h - trayH) / 2, r: pr };
      return { trayH, tray, plate, spots: plateSpots(cookieList.length, plate.cx, plate.cy, pr * 0.85) };
    }

    let raf = 0;
    function draw() {
      const { ctx, w, h } = view;
      const L = layout();
      ctx.clearRect(0, 0, w, h);
      drawWorktop(ctx, w, h);
      drawTray(ctx, 8, 8, w - 16, L.trayH - 16);
      drawPlateBase(ctx, L.plate.cx, L.plate.cy, L.plate.r);
      const now = performance.now();
      let moving = false;
      cookieList.forEach((shape, i) => {
        if (onPlate.has(i)) return;
        drawCookie(ctx, look, shape, L.tray[i].x, L.tray[i].y, L.tray[i].r, i);
      });
      [...onPlate].forEach((i, order) => {
        const to = L.spots[order];
        const from = L.tray[i];
        const t = Math.min(1, (now - (anims.get(i) || 0)) / 350);
        if (t < 1) moving = true;
        const e = 1 - (1 - t) ** 3;
        const x = from.x + (to.x - from.x) * e;
        const y = from.y + (to.y - from.y) * e - Math.sin(e * Math.PI) * 30;
        const r = from.r + (to.r - from.r) * e;
        drawCookie(ctx, look, cookieList[i], x, y, r, i);
      });
      if (moving) raf = requestAnimationFrame(draw);
    }

    function move(i) {
      if (onPlate.has(i)) return;
      onPlate.add(i);
      anims.set(i, performance.now());
      sound('plop');
      vibrate(10);
      cancelAnimationFrame(raf);
      draw();
    }

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const p = canvasPoint(canvas, e);
      const L = layout();
      const hit = cookieList.findIndex((_, i) => !onPlate.has(i) && Math.hypot(L.tray[i].x - p.x, L.tray[i].y - p.y) < L.tray[i].r * 1.1);
      if (hit >= 0) move(hit);
    });
    all.addEventListener('click', () => {
      cookieList.forEach((_, i) => setTimeout(() => move(i), i * 90));
    });

    draw();
    return {
      nextLabel: 'Teller abgeben 🍽️',
      collect: () => ({}),
      check: () => (onPlate.size < cookieList.length ? 'Es liegen noch Plätzchen auf dem Blech.' : null),
      cleanup: () => cancelAnimationFrame(raf),
      resize() {
        view = fitCanvas(canvas);
        draw();
      },
    };
  }

  // ------------------------------------------------------------------ waiting
  function showWaiting(text) {
    waitingEl.hidden = false;
    stationEl.hidden = true;
    const look = myLook();
    if (cookieList.length) look.shapes = countShapes(cookieList);
    drawPlate($('waiting-plate'), look);
    if (text) $('waiting-text').textContent = text;
    else updateWaitingText();
  }

  function countShapes(list) {
    const out = {};
    for (const s of list) out[s] = (out[s] || 0) + 1;
    return out;
  }

  function updateWaitingText() {
    if (!state) return;
    const others = state.players.filter((p) => p.inRound && p.id !== me.id && !p.finished);
    $('waiting-text').textContent = others.length
      ? `Dein Teller ist fertig! Warte auf ${others.map((p) => `${p.name} (${H.STATION_INFO[STATIONS[p.station]].icon} ${H.STATION_INFO[STATIONS[p.station]].title})`).join(', ')} …`
      : 'Dein Teller ist fertig! Gleich wird verglichen …';
  }

  // ------------------------------------------------------------------ results
  function showResults(msg) {
    const firstShow = !lastResults || lastResults.round !== msg.round;
    lastResults = msg;
    stopStation();
    recipeEl.hidden = true;
    resultsEl.hidden = false;
    const players = msg.players;
    const winner = players.find((p) => p.id === msg.winner);
    const mine = players.find((p) => p.id === me.id);
    let title;
    if (players.length === 1) title = `${players[0].total} % Rezepttreue${winner ? ' – Preis verdient!' : ''}`;
    else if (!winner) title = 'Keiner hat gewonnen …';
    else if (winner.id === me.id) title = '🏆 Du hast gewonnen!';
    else title = `🏆 ${winner.name} gewinnt!`;
    $('results-title').textContent = title;

    const prizeEl = $('prize');
    prizeEl.hidden = !msg.prize;
    if (msg.prize) {
      $('prize-emoji').textContent = msg.prize.emoji;
      $('prize-name').textContent = msg.prize.name;
      $('prize-label').textContent = winner && winner.id === me.id ? 'Dein neues Backutensil' : `Neues Backutensil für ${winner ? winner.name : ''}`;
      if (winner && winner.id === me.id && storage.get(sessionStorage, `ploink-bake-prize-${msg.round}-${roomCode}`) !== '1') {
        // Remember the prize once per round, even if the results arrive again after a reconnect.
        const owned = ownedUtensils();
        if (!owned.includes(msg.prize.id)) owned.push(msg.prize.id);
        storage.set(localStorage, UTENSIL_KEY, JSON.stringify(owned));
        storage.set(sessionStorage, `ploink-bake-prize-${msg.round}-${roomCode}`, '1');
        sound('fanfare');
        vibrate([60, 40, 60, 40, 200]);
      }
    }
    if (firstShow && mine && winner && winner.id !== me.id) sound('aww');
    renderUtensils();

    $('plates').replaceChildren(...players.map((p) => {
      const card = el('div', 'plate-card');
      if (p.id === msg.winner) card.classList.add('winner');
      card.style.setProperty('--seat-color', p.color);
      const canvas = el('canvas', 'plate-canvas');
      const name = el('strong', 'plate-name', p.id === me.id ? `${p.name} (du)` : p.name);
      const total = el('span', 'plate-total', `${p.total} %`);
      card.append(canvas, name, total);
      requestAnimationFrame(() => drawPlate(canvas, p.look));
      return card;
    }));

    $('score-head').replaceChildren(row('th', ['', ...players.map((p) => (p.id === me.id ? 'Du' : p.name))]));
    const bodyRows = [];
    for (const station of H.SCORED) {
      const tr = row('td', [`${H.STATION_INFO[station].icon} ${H.STATION_INFO[station].title}`, ...players.map((p) => `${p.scores[station].score} %`)]);
      tr.classList.add('score-row');
      players.forEach((p, i) => {
        const best = Math.max(...players.map((q) => q.scores[station].score));
        if (players.length > 1 && p.scores[station].score === best) tr.children[i + 1].classList.add('best');
      });
      const notes = el('tr', 'notes-row');
      notes.hidden = true;
      const cell = el('td', '');
      cell.colSpan = players.length + 1;
      for (const p of players) {
        const line = el('p', 'note-line');
        const who = el('strong', '', `${p.id === me.id ? 'Du' : p.name}: `);
        who.style.color = p.color;
        const list = p.scores[station].notes;
        line.append(who, list.length ? list.join(' · ') : 'genau nach Rezept 👌');
        cell.append(line);
      }
      notes.append(cell);
      tr.addEventListener('click', () => {
        notes.hidden = !notes.hidden;
      });
      bodyRows.push(tr, notes);
    }
    $('score-body').replaceChildren(...bodyRows);
    $('score-foot').replaceChildren(
      row('th', ['Rezepttreue', ...players.map((p) => `${p.total} %`)]),
      row('td', ['⏱️ Zeit', ...players.map((p) => (p.finished ? formatTime(p.timeMs) : 'nicht fertig'))]),
    );
  }

  function row(cellTag, cells) {
    const tr = document.createElement('tr');
    for (const text of cells) tr.append(el(cellTag, '', text));
    return tr;
  }

  function formatTime(ms) {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} min`;
  }

  // ------------------------------------------------------------- banner, toast
  function renderBanner(title, subtitle) {
    bannerEl.hidden = false;
    bannerEl.replaceChildren();
    bannerEl.append(el('div', '', title));
    if (subtitle) bannerEl.append(el('small', '', subtitle));
  }

  function countdownBanner(ms) {
    const end = performance.now() + ms;
    const tick = () => {
      const left = Math.max(1, Math.ceil((end - performance.now()) / 1000));
      renderBanner(String(left), 'Schürze an, Hände waschen!');
    };
    clearInterval(bannerTimer);
    tick();
    bannerTimer = setInterval(tick, 200);
  }

  function hideBanner() {
    clearInterval(bannerTimer);
    bannerEl.hidden = true;
  }

  function toast(text, color) {
    const t = el('div', 'toast', text);
    if (color) t.style.borderColor = color;
    toastsEl.append(t);
    setTimeout(() => t.remove(), 2700);
    while (toastsEl.children.length > 2) toastsEl.firstChild.remove();
  }

  function vibrate(pattern) {
    // Browsers refuse vibration before the first tap and log an error for every attempt.
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch { /* ignore */ }
    }
  }

  // -------------------------------------------------------------------- sound
  let audio = null;
  function unlockAudio() {
    if (audio) {
      if (audio.state === 'suspended') audio.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audio = new Ctx();
  }
  window.addEventListener('pointerup', unlockAudio, { passive: true });

  function tone(freq, { at = 0, dur = 0.15, type = 'sine', gain = 0.15, to = freq } = {}) {
    const t = audio.currentTime + at;
    const osc = audio.createOscillator();
    const amp = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(amp).connect(audio.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function sound(kind) {
    if (!audio || audio.state !== 'running') return;
    switch (kind) {
      case 'tick': tone(1800, { dur: 0.03, type: 'square', gain: 0.03 }); break;
      case 'plop': tone(420, { dur: 0.12, to: 160, gain: 0.2 }); break;
      case 'drop': tone(900, { dur: 0.18, to: 300, gain: 0.15 }); break;
      case 'cut': tone(240, { dur: 0.08, type: 'triangle', to: 120, gain: 0.25 }); break;
      case 'shake': for (let i = 0; i < 5; i++) tone(3000 + i * 300, { at: i * 0.05, dur: 0.03, type: 'square', gain: 0.02 }); break;
      case 'whoosh': tone(120, { dur: 0.5, type: 'sawtooth', to: 60, gain: 0.05 }); break;
      case 'ding': tone(1568, { dur: 0.9, gain: 0.12 }); tone(2349, { dur: 0.6, gain: 0.05 }); break;
      case 'fanfare': [523, 659, 784, 1047].forEach((f, i) => tone(f, { at: i * 0.12, dur: i === 3 ? 0.6 : 0.14, type: 'triangle', gain: 0.15 })); break;
      case 'aww': tone(392, { dur: 0.5, to: 330, type: 'triangle', gain: 0.1 }); break;
      default: break;
    }
  }

  // --------------------------------------------------------------------- wiring
  $('hud-code').textContent = roomCode;
  $('lobby-code').textContent = roomCode;
  $('start').addEventListener('click', () => send({ type: 'start' }));
  $('again').addEventListener('click', () => send({ type: 'start' }));
  $('recipe-button').addEventListener('click', () => {
    if (recipeEl.hidden) openRecipe();
    else recipeEl.hidden = true;
  });
  $('recipe-close').addEventListener('click', () => {
    recipeEl.hidden = true;
  });
  recipeEl.addEventListener('click', (e) => {
    if (e.target === recipeEl) recipeEl.hidden = true;
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (current && current.resize) current.resize();
      if (!waitingEl.hidden) showWaiting($('waiting-text').textContent);
      if (!resultsEl.hidden && lastResults) showResults(lastResults);
    }, 150);
  });
  renderUtensils();

  connect();

  // A tiny hook for automated tests.
  window.__bake = {
    get state() { return state; },
    get recipe() { return recipe; },
    get station() { return STATIONS[stationIndex]; },
    get steps() { return steps; },
    get results() { return lastResults; },
  };
})();
