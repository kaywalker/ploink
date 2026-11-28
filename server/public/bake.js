'use strict';

// Ploink Plätzchen-Duell client: the interactive baking stations on this phone. The
// phone reports what the player did at each station; scoring, the recipe and the
// comparison at the end live in shared/bake-hub.js.

(() => {
  const H = window.PloinkBakeHub;
  const RECONNECT_DELAY_MS = 1200;
  let stationList = H.STATIONS; // the stations of the current recipe

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
    if (msg.recipe) {
      recipe = msg.recipe;
      stationList = recipe.stations || H.STATIONS;
    }
    renderRivals(msg.players);
    renderCrew(msg.players);
    renderUtensils();

    lobbyEl.hidden = msg.phase !== 'lobby';
    renderMode(msg.mode || 'recipe');
    $('recipe-button').hidden = !recipe || msg.phase === 'lobby';
    if (msg.phase !== 'results') {
      resultsEl.hidden = true;
      $('gift').hidden = true;
    }

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
      } else if (stationIndex >= stationList.length) {
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
        prog.textContent = p.finished ? '🍽️ fertig' : `${H.STATION_INFO[stationList[p.station]].icon} ${p.station + 1}/${stationList.length}`;
      }
      li.append(name, prog);
      return li;
    }));
  }

  function renderMode(mode) {
    const free = mode === 'free';
    $('mode-recipe').setAttribute('aria-pressed', String(!free));
    $('mode-free').setAttribute('aria-pressed', String(free));
    $('free-options').hidden = !free;
    const kind = (state && state.freeKind) || 'cookie';
    for (const b of document.querySelectorAll('#free-options [data-kind]')) b.setAttribute('aria-pressed', String(b.dataset.kind === kind));
    $('free-jam').checked = !!(state && state.freeJam);
    $('rules-recipe').hidden = free;
    $('rules-free').hidden = !free;
    $('lobby-title').textContent = free ? 'Backt, was ihr wollt!' : 'Wer backt genauer nach Rezept?';
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
      : `Warte auf eine zweite Person mit Code ${roomCode} – oder back alleine (${state && state.mode === 'free' ? 'ab 8 von 10 Punkten' : 'ab 90 %'} gibt’s auch einen Preis).`;
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
    const level = recipe.level || 0;
    $('recipe-kicker').textContent = recipe.free ? 'Tipps · ohne Rezept' : `Rezept · Schwierigkeit ${'●'.repeat(level + 1)}${'○'.repeat(H.LEVELS - level - 1)}`;
    $('recipe-label').textContent = recipe.label || '';
    $('recipe-button').textContent = recipe.free ? '💡 Tipps' : '📜 Rezept';
    const lines = H.recipeSteps(recipe);
    $('recipe-steps').replaceChildren(...stationList.map((id, i) => {
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
    dough: 'Packung im Regal antippen, gedrückt halten zum Schütten – loslassen hört auf. ✓ kippt alles in die Schüssel, dort Kreise ziehen.',
    roll: 'Mit dem Finger hoch und runter wischen. Die Dicke steht rechts.',
    cut: 'Ausstecher wählen, auf den Teig drücken (schieben geht auch) und loslassen. Antippen eines Plätzchens nimmt es wieder weg.',
    bake: 'Temperatur einstellen, Blech rein – und rechtzeitig wieder raus!',
    icing: 'Jetzt den Zuckerguss anrühren – genau wie den Teig.',
    color: 'Spritzbeutel wählen und Tropfen in den Guss geben. Raus geht nichts mehr!',
    jam: 'Früchte und Gelierzucker in den Topf tippen, Herd hochdrehen, sprudelnd kochen lassen – und im Topf rühren!',
    choc: 'Schokolade in die Schüssel brechen und im Wasserbad schmelzen. Nicht zu heiß werden lassen, rühren hilft.',
    sprinkle: 'Streich die Glasur auf ein Plätzchen – die anderen macht der Küchengehilfe. Dann die Streusel draufstreuen.',
    plate: 'Tippe die Plätzchen an, um sie auf den Teller zu legen.',
    form: 'Backform wählen und mit dem Finger einfetten – sonst klebt der Kuchen fest.',
    layers: 'Mit dem Messer quer über den Biskuit wischen. Antippen eines Schnitts nimmt ihn zurück.',
    cream: 'Sahne und Vanillezucker antippen, dann den Mixer gedrückt halten – loslassen, sobald sie steif ist!',
    crunch: 'Nüsse, Zucker und Butter in die Pfanne tippen, Herd an, rühren und goldbraun rösten.',
    assemble: 'Tippe die Schichten in der richtigen Reihenfolge – von unten nach oben.',
    top: 'Verzierung wählen und auf die Torte tippen. Antippen nimmt sie wieder weg.',
  };

  function hintFor(id) {
    if (id === 'plate' && recipe && recipe.kind && recipe.kind !== 'cookie') return `Tippe ${recipe.kind === 'torte' ? 'die Torte' : 'den Kuchen'} an, um sie auf die Tortenplatte zu heben.`;
    if (id === 'sprinkle' && recipe && recipe.kind === 'cake') return recipe.icing || recipe.choc ? 'Streich die Glasur auf den Kuchen, dann die Streusel drauf.' : 'Bestäube den Kuchen mit Puderzucker.';
    if (id === 'dough' && recipe && recipe.kind !== 'cookie') return `Rühr den ${recipe.kind === 'torte' ? 'Biskuitteig' : 'Rührteig'} an: ${HINTS.dough}`;
    return HINTS[id];
  }

  let confirmArmed = null;

  // Canvases are sized by the layout (flex), which can still change after a station is
  // built (hidden rows, chips): measure them again whenever their box changes.
  const canvasSizes = new WeakMap();
  const stationResize = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      const old = canvasSizes.get(entry.target);
      if (old && (Math.abs(old.w - width) > 0.5 || Math.abs(old.h - height) > 0.5)) changed = true;
      canvasSizes.set(entry.target, { w: width, h: height });
    }
    if (changed && current && current.resize) current.resize();
  }) : null;

  function enterStation(index) {
    if (current && current.cleanup) current.cleanup();
    current = null;
    confirmArmed = null;
    stationIndex = index;
    if (index >= stationList.length) {
      stationEl.hidden = true;
      showWaiting();
      return;
    }
    const id = stationList[index];
    waitingEl.hidden = true;
    stationEl.hidden = false;
    stationEl.dataset.station = id;
    $('station-kicker').textContent = `Schritt ${index + 1} / ${stationList.length}`;
    $('station-title').textContent = `${H.STATION_INFO[id].icon} ${H.STATION_INFO[id].title}`;
    $('station-hint').textContent = hintFor(id);
    if (recipe && recipe.kind && recipe.kind !== 'cookie') cookieList = [formShape()]; // one cake instead of many cookies
    bodyEl.replaceChildren();
    bodyEl.scrollTop = 0;
    toastsEl.replaceChildren();
    nextBtn.classList.remove('armed');
    current = BUILDERS[id](bodyEl);
    if (stationResize) {
      stationResize.disconnect();
      for (const c of bodyEl.querySelectorAll('canvas')) stationResize.observe(c);
    }
    nextBtn.textContent = current.nextLabel || 'Fertig ✓';
    nextBtn.disabled = false;
    renderRecipe();
  }

  nextBtn.addEventListener('click', () => {
    if (!current || stationIndex < 0 || stationIndex >= stationList.length) return;
    const problem = current.check ? current.check() : null;
    if (problem && confirmArmed !== stationIndex) {
      confirmArmed = stationIndex;
      toast(`${problem} Nochmal tippen, um trotzdem weiterzumachen.`);
      nextBtn.classList.add('armed');
      setTimeout(() => nextBtn.classList.remove('armed'), 2500);
      return;
    }
    const id = stationList[stationIndex];
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
    jam: (body) => buildStove(body, 'jam'),
    choc: (body) => buildStove(body, 'choc'),
    sprinkle: buildSprinkle,
    plate: buildPlate,
    form: buildForm,
    layers: buildLayers,
    cream: buildCream,
    crunch: (body) => buildStove(body, 'crunch'),
    assemble: buildAssemble,
    top: buildTop,
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
  // How each ingredient leaves its package: powder dusts, grains trickle, honey runs,
  // butter drops in pieces, eggs one by one, lemon juice and milk by the spoonful.
  const POUR = {
    mehl: { type: 'powder', color: '#f6f1e6' },
    zucker: { type: 'grain', color: '#ffffff' },
    puderzucker: { type: 'powder', color: '#ffffff' },
    butter: { type: 'chunk', color: '#f6dd7c' },
    eier: { type: 'egg', color: '#f3e3cc' },
    kakao: { type: 'powder', color: '#5b3420' },
    zimt: { type: 'powder', color: '#9a5230' },
    vanille: { type: 'grain', color: '#f3e6b0' },
    honig: { type: 'stream', color: '#e2a52e' },
    mandeln: { type: 'grain', color: '#d9b88f' },
    salz: { type: 'grain', color: '#ffffff' },
    backpulver: { type: 'powder', color: '#f4f6ff' },
    staerke: { type: 'powder', color: '#fffbe6' },
    zitrone: { type: 'spoon', color: '#f7e24a' },
    milch: { type: 'spoon', color: '#fbfbfb' },
  };
  const EGGS_IN_CARTON = 6;
  const FONT = 'system-ui, -apple-system, sans-serif';

  function rrect(ctx, x, y, w, h, r) {
    roundRect(ctx, x, y, w, h, Math.min(r, w / 2, h / 2));
  }

  /** Centred text lines, shrunk until they fit maxW. */
  function tag(ctx, lines, cy, maxW, color, size, weight = 800) {
    const list = Array.isArray(lines) ? lines : [lines];
    let s = size;
    const widest = () => Math.max(...list.map((l) => ctx.measureText(l).width));
    ctx.font = `${weight} ${s}px ${FONT}`;
    while (s > 5 && widest() > maxW) {
      s -= 0.5;
      ctx.font = `${weight} ${s}px ${FONT}`;
    }
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    list.forEach((l, i) => ctx.fillText(l, 0, cy + (i - (list.length - 1) / 2) * s * 1.05));
  }

  function shade(ctx, x, y, w, h) {
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.28)');
    g.addColorStop(0.35, 'rgba(255,255,255,0)');
    g.addColorStop(0.8, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  }

  function glassJar(ctx, w, h, o) {
    const B = h / 2;
    const bw = w * o.width;
    const top = B - h * o.height;
    const lidH = h * 0.13;
    ctx.save();
    rrect(ctx, -bw / 2, top + lidH * 0.6, bw, B - top - lidH * 0.6, 6);
    ctx.fillStyle = 'rgba(230,240,245,0.35)';
    ctx.fill();
    ctx.clip();
    const level = top + lidH + (B - top - lidH) * (1 - o.fill);
    ctx.fillStyle = o.content;
    ctx.fillRect(-bw / 2, level, bw, B - level);
    if (o.grains) {
      ctx.fillStyle = 'rgba(180,190,200,0.6)';
      for (let i = 0; i < 26; i++) ctx.fillRect(-bw / 2 + ((i * 37) % 100) / 100 * bw, level + ((i * 53) % 100) / 100 * (B - level), 1.2, 1.2);
    }
    shade(ctx, -bw / 2, top, bw, B - top);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    rrect(ctx, -bw / 2, top + lidH * 0.6, bw, B - top - lidH * 0.6, 6);
    ctx.stroke();
    ctx.fillStyle = o.lid;
    rrect(ctx, -bw / 2 - 1, top, bw + 2, lidH, 3);
    ctx.fill();
    shade(ctx, -bw / 2 - 1, top, bw + 2, lidH);
    if (o.text) {
      const ly = top + lidH + (B - top - lidH) * 0.42;
      ctx.fillStyle = o.labelColor || '#fffdf6';
      rrect(ctx, -bw * 0.4, ly - h * 0.12, bw * 0.8, h * 0.24, 2);
      ctx.fill();
      tag(ctx, o.text, ly, bw * 0.72, o.textColor || '#3b2416', 10);
    }
  }

  function cardBox(ctx, w, h, o) {
    const B = h / 2;
    const bw = w * (o.width || 0.74);
    const top = B - h * (o.height || 0.92);
    ctx.fillStyle = o.body;
    ctx.fillRect(-bw / 2, top, bw, B - top);
    ctx.fillStyle = o.band;
    ctx.fillRect(-bw / 2, top + (B - top) * 0.3, bw, (B - top) * 0.4);
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(-bw / 2, top, bw, 3);
    tag(ctx, o.text, top + (B - top) * 0.5, bw * 0.86, o.textColor || '#ffffff', 11);
    if (o.small) tag(ctx, o.small, top + (B - top) * 0.15, bw * 0.8, o.band, 6, 700);
    shade(ctx, -bw / 2, top, bw, B - top);
  }

  function drawPackage(ctx, id, w, h, eggs = EGGS_IN_CARTON) {
    const B = h / 2;
    ctx.save();
    switch (id) {
      case 'mehl': {
        // paper bag with a folded top
        const bw = w * 0.78;
        const top = B - h * 0.86;
        ctx.fillStyle = '#e1d8c3';
        ctx.beginPath();
        ctx.moveTo(-bw / 2, top + h * 0.1);
        ctx.lineTo(-bw / 2 + 4, top);
        ctx.lineTo(bw / 2 - 4, top);
        ctx.lineTo(bw / 2, top + h * 0.1);
        ctx.fill();
        ctx.fillStyle = '#f5f0e4';
        rrect(ctx, -bw / 2, top + h * 0.1, bw, B - top - h * 0.1, 3);
        ctx.fill();
        ctx.fillStyle = '#2f6db5';
        ctx.fillRect(-bw / 2, top + h * 0.34, bw, h * 0.26);
        tag(ctx, 'MEHL', top + h * 0.47, bw * 0.84, '#ffffff', 12, 900);
        tag(ctx, 'Type 405', top + h * 0.72, bw * 0.8, '#2f6db5', 7, 700);
        ctx.fillStyle = '#d9a441';
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          ctx.ellipse(-3 + i * 3, top + h * 0.22, 1.4, 3.2, 0.4 - i * 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
        shade(ctx, -bw / 2, top, bw, B - top);
        break;
      }
      case 'zucker':
        glassJar(ctx, w, h, { width: 0.72, height: 0.9, lid: '#c0392b', content: '#fbfbfb', fill: 0.8, grains: true, text: 'Zucker' });
        break;
      case 'puderzucker':
        cardBox(ctx, w, h, { body: '#fdf3f8', band: '#e86aa6', text: ['Puder', 'zucker'], small: '✻ fein ✻' });
        break;
      case 'butter': {
        ctx.fillStyle = '#f4f1ec';
        ctx.beginPath();
        ctx.ellipse(0, B - 3, w * 0.46, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        const bw = w * 0.8;
        const bh = h * 0.34;
        const g = ctx.createLinearGradient(0, B - 4 - bh, 0, B - 4);
        g.addColorStop(0, '#f6dc6a');
        g.addColorStop(1, '#c9a23a');
        ctx.fillStyle = g;
        rrect(ctx, -bw / 2, B - 4 - bh, bw, bh, 3);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          ctx.beginPath();
          ctx.moveTo(-bw / 2 + (bw * i) / 4, B - 4 - bh);
          ctx.lineTo(-bw / 2 + (bw * i) / 4 - 4, B - 4);
          ctx.stroke();
        }
        tag(ctx, 'Butter', B - 4 - bh / 2, bw * 0.8, '#5a3d0c', 10, 900);
        break;
      }
      case 'eier': {
        const bw = w * 0.92;
        // open lid behind the eggs
        ctx.fillStyle = '#a99f8a';
        ctx.beginPath();
        ctx.moveTo(-bw / 2, B - h * 0.3);
        ctx.lineTo(-bw / 2 + 3, B - h * 0.98);
        ctx.lineTo(bw / 2 - 3, B - h * 0.98);
        ctx.lineTo(bw / 2, B - h * 0.3);
        ctx.fill();
        tag(ctx, 'Eier', B - h * 0.82, bw * 0.7, '#5e5546', 9, 900);
        // eggs: back row first, then the front row
        const spots = [[-0.28, 0.42], [0, 0.42], [0.28, 0.42], [-0.3, 0.3], [0, 0.3], [0.3, 0.3]];
        spots.forEach(([fx, fy], i) => {
          if (i >= eggs) return;
          const ex = fx * bw;
          const ey = B - h * fy;
          const eg = ctx.createRadialGradient(ex - 2, ey - 3, 1, ex, ey, 9);
          eg.addColorStop(0, '#fffaf2');
          eg.addColorStop(1, '#e5c9a3');
          ctx.fillStyle = eg;
          ctx.beginPath();
          ctx.ellipse(ex, ey, w * 0.1, h * 0.11, 0, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.fillStyle = '#c2b8a2';
        ctx.beginPath();
        ctx.moveTo(-bw / 2, B - h * 0.26);
        for (let i = 0; i <= 3; i++) {
          const x = -bw / 2 + (bw * i) / 3;
          ctx.quadraticCurveTo(x - bw / 12, B - h * 0.18, x, B - h * 0.26);
        }
        ctx.lineTo(bw / 2, B);
        ctx.lineTo(-bw / 2, B);
        ctx.fill();
        shade(ctx, -bw / 2, B - h * 0.26, bw, h * 0.26);
        break;
      }
      case 'kakao': {
        const bw = w * 0.66;
        const top = B - h * 0.74;
        ctx.fillStyle = '#6b3a22';
        ctx.fillRect(-bw / 2, top, bw, B - top);
        ctx.fillStyle = '#f0d9b5';
        ctx.fillRect(-bw / 2, top + (B - top) * 0.28, bw, (B - top) * 0.44);
        tag(ctx, 'Kakao', top + (B - top) * 0.5, bw * 0.84, '#5b3420', 11, 900);
        ctx.fillStyle = '#b7bec4';
        ctx.beginPath();
        ctx.ellipse(0, top, bw / 2, 3.5, 0, 0, Math.PI * 2);
        ctx.fill();
        shade(ctx, -bw / 2, top, bw, B - top);
        break;
      }
      case 'zimt':
        glassJar(ctx, w, h, { width: 0.5, height: 0.66, lid: '#c0392b', content: '#8a4a24', fill: 0.85, text: 'Zimt' });
        break;
      case 'vanille':
        ctx.save();
        ctx.translate(w * 0.12, B - h * 0.34);
        ctx.rotate(0.18);
        ctx.fillStyle = '#e8c85a';
        rrect(ctx, -w * 0.3, -h * 0.32, w * 0.6, h * 0.64, 2);
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = '#f5df86';
        rrect(ctx, -w * 0.34, B - h * 0.66, w * 0.6, h * 0.66, 2);
        ctx.fill();
        ctx.fillStyle = '#6b4128';
        ctx.beginPath();
        ctx.arc(-w * 0.04, B - h * 0.52, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.translate(-w * 0.04, 0);
        tag(ctx, ['Vanille', 'zucker'], B - h * 0.25, w * 0.52, '#6b4128', 8, 900);
        ctx.restore();
        shade(ctx, -w * 0.34, B - h * 0.66, w * 0.6, h * 0.66);
        break;
      case 'honig':
        glassJar(ctx, w, h, { width: 0.7, height: 0.78, lid: '#a86b1f', content: '#e2a52e', fill: 0.9, text: 'Honig', labelColor: '#fff4d6', textColor: '#8a5a12' });
        break;
      case 'mandeln': {
        const bw = w * 0.7;
        const top = B - h * 0.84;
        ctx.fillStyle = 'rgba(240,245,248,0.45)';
        rrect(ctx, -bw / 2, top + 4, bw, B - top - 4, 7);
        ctx.fill();
        ctx.fillStyle = '#d9b88f';
        rrect(ctx, -bw / 2 + 2, top + (B - top) * 0.3, bw - 4, (B - top) * 0.7 - 2, 6);
        ctx.fill();
        ctx.fillStyle = '#c49a68';
        for (let i = 0; i < 14; i++) ctx.fillRect(-bw / 2 + 4 + ((i * 41) % 100) / 100 * (bw - 8), top + (B - top) * (0.35 + ((i * 29) % 60) / 100), 2, 1.5);
        ctx.fillStyle = '#d63a3a';
        ctx.fillRect(-bw / 2 - 1, top, bw + 2, 5);
        ctx.fillStyle = '#fffdf6';
        rrect(ctx, -bw * 0.38, top + (B - top) * 0.46, bw * 0.76, h * 0.22, 2);
        ctx.fill();
        tag(ctx, ['Mandeln', 'gemahlen'], top + (B - top) * 0.46 + h * 0.11, bw * 0.7, '#7a4e22', 8, 800);
        break;
      }
      case 'salz': {
        const bw = w * 0.42;
        const top = B - h * 0.66;
        ctx.fillStyle = '#f4f6f8';
        rrect(ctx, -bw / 2, top + 8, bw, B - top - 8, 6);
        ctx.fill();
        ctx.fillStyle = '#2f6db5';
        ctx.beginPath();
        ctx.ellipse(0, top + 9, bw / 2, 9, 0, Math.PI, 0);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        for (let i = -1; i <= 1; i++) ctx.fillRect(i * 4 - 0.8, top + 3, 1.6, 1.6);
        tag(ctx, 'Salz', top + (B - top) * 0.62, bw * 0.84, '#2f6db5', 10, 900);
        shade(ctx, -bw / 2, top, bw, B - top);
        break;
      }
      case 'backpulver': {
        const bw = w * 0.62;
        const top = B - h * 0.5;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-bw / 2, top, bw, B - top);
        ctx.fillStyle = '#d63a3a';
        ctx.fillRect(-bw / 2, top + (B - top) * 0.45, bw, (B - top) * 0.55);
        tag(ctx, 'Back-', top + (B - top) * 0.24, bw * 0.86, '#d63a3a', 9, 900);
        tag(ctx, 'pulver', top + (B - top) * 0.72, bw * 0.86, '#ffffff', 9, 900);
        shade(ctx, -bw / 2, top, bw, B - top);
        break;
      }
      case 'staerke':
        cardBox(ctx, w, h, { body: '#f5d142', band: '#2f6db5', text: ['Speise', 'stärke'], small: 'MAIS', width: 0.7, height: 0.86 });
        break;
      case 'zitrone': {
        const bw = w * 0.46;
        const top = B - h * 0.62;
        ctx.fillStyle = '#3f9a5b';
        ctx.fillRect(-w * 0.07, B - h * 0.94, w * 0.14, h * 0.1);
        ctx.fillStyle = 'rgba(247,226,74,0.85)';
        ctx.beginPath();
        ctx.moveTo(-w * 0.08, B - h * 0.84);
        ctx.lineTo(w * 0.08, B - h * 0.84);
        ctx.lineTo(bw / 2, top);
        ctx.lineTo(bw / 2, B - 3);
        ctx.quadraticCurveTo(bw / 2, B, bw / 2 - 3, B);
        ctx.lineTo(-bw / 2 + 3, B);
        ctx.quadraticCurveTo(-bw / 2, B, -bw / 2, B - 3);
        ctx.lineTo(-bw / 2, top);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#fffdf6';
        rrect(ctx, -bw * 0.45, top + h * 0.12, bw * 0.9, h * 0.26, 2);
        ctx.fill();
        ctx.fillStyle = '#f2d21f';
        ctx.beginPath();
        ctx.ellipse(0, top + h * 0.19, 5, 3.4, 0, 0, Math.PI * 2);
        ctx.fill();
        tag(ctx, 'Zitrone', top + h * 0.31, bw * 0.84, '#3f7a2b', 8, 900);
        shade(ctx, -bw / 2, top, bw, B - top);
        break;
      }
      case 'milch': {
        const bw = w * 0.56;
        const top = B - h * 0.7;
        ctx.fillStyle = '#e8eef5';
        ctx.beginPath();
        ctx.moveTo(-bw / 2, top);
        ctx.lineTo(0, top - h * 0.18);
        ctx.lineTo(bw / 2, top);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-bw / 2, top, bw, B - top);
        ctx.fillStyle = '#3a7bd5';
        ctx.fillRect(-bw / 2, top + (B - top) * 0.55, bw, (B - top) * 0.45);
        tag(ctx, 'Milch', top + (B - top) * 0.3, bw * 0.86, '#3a7bd5', 10, 900);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.ellipse(0, top + (B - top) * 0.78, bw * 0.28, (B - top) * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();
        shade(ctx, -bw / 2, top, bw, B - top);
        break;
      }
      default:
        break;
    }
    ctx.restore();
  }

  function buildMix(body, kind) {
    const added = {};
    let onScale = null; // { id, amount }
    let stir = 0;
    let stirAngle = 0;
    let spoonAt = null;
    let pouring = false;
    let pourStart = 0;
    let tilt = 0;
    let pulseUntil = 0;   // a short tip of the bottle for one spoonful
    let dropsLeft = 0;
    let emitAcc = 0;
    let raf = 0;
    let lastT = performance.now();
    const particles = [];

    const canvas = el('canvas', 'kitchen-canvas');
    const controls = el('div', 'mix-controls');
    const minus = el('button', 'scale-btn', '−');
    minus.type = 'button';
    minus.setAttribute('aria-label', 'Etwas wegnehmen');
    const pour = el('button', 'scale-btn pour', 'Halten: schütten');
    pour.type = 'button';
    const back = el('button', 'scale-btn ghost', '↩ Regal');
    back.type = 'button';
    const tip = el('button', 'scale-btn ok', '✓ In die Schüssel');
    tip.type = 'button';
    controls.append(minus, pour, back, tip);
    const meter = el('div', 'stir-meter');
    const meterBar = el('span');
    const meterText = el('small', '', 'Rühren: 0 %');
    meter.append(meterBar, meterText);
    const chips = el('div', 'bowl-chips');
    body.append(canvas, controls, meter, chips);

    let view = fitCanvas(canvas);
    let L = layout();
    let backdrop = null;

    function layout() {
      const { w, h } = view;
      const shelfH = Math.round(Math.min(h * 0.5, 280));
      const rowH = (shelfH - 14) / 3;
      const side = 7;
      const slotW = (w - 2 * side) / 5;
      const slots = {};
      Object.keys(H.INGREDIENTS).forEach((id, i) => {
        const row = Math.floor(i / 5);
        const col = i % 5;
        const boardY = 6 + rowH * (row + 1) - 4;
        slots[id] = { cx: side + slotW * (col + 0.5), bottom: boardY, w: Math.min(slotW * 0.86, (rowH - 12) * 0.95), h: rowH - 12, cell: { x: side + slotW * col, y: boardY - rowH + 4, w: slotW, h: rowH } };
      });
      const counterY = shelfH + (h - shelfH) * 0.4;
      const sw = Math.min(w * 0.42, 170);
      const sh = Math.min(58, (h - counterY) * 0.42);
      const scale = { cx: w * 0.26, baseY: h - 10, w: sw, h: sh };
      scale.platY = scale.baseY - sh;
      scale.rimRx = sw * 0.42;
      scale.rimRy = scale.rimRx * 0.3;
      scale.rimY = scale.platY - scale.rimRx * 0.5;
      const mrx = Math.min(w * 0.23, (h - 8 - (counterY + (h - counterY) * 0.42)) / 0.62, 100);
      const bowl = { cx: w * 0.74, rimY: counterY + (h - counterY) * 0.42, rx: mrx, ry: mrx * 0.5, depth: mrx * 0.6 };
      const pkg = { w: slots.mehl.w, h: slots.mehl.h };
      const hover = { x: scale.cx + pkg.h * 0.42, y: (shelfH + scale.rimY) / 2 + 2 };
      return { shelfH, rowH, side, slots, counterY, scale, bowl, pkg, hover };
    }

    function eggsLeft() {
      return Math.max(0, EGGS_IN_CARTON - (added.eier || 0) - (onScale && onScale.id === 'eier' ? onScale.amount : 0));
    }

    // Shelf, wall and counter change rarely: drawn once into an offscreen layer.
    function renderBackdrop() {
      const { w, h } = view;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      backdrop = document.createElement('canvas');
      backdrop.width = Math.round(w * dpr);
      backdrop.height = Math.round(h * dpr);
      const ctx = backdrop.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // tiled wall
      ctx.fillStyle = '#efe6d8';
      ctx.fillRect(0, 0, w, L.counterY);
      ctx.strokeStyle = 'rgba(150,120,90,0.25)';
      ctx.lineWidth = 1;
      for (let y = L.shelfH; y < L.counterY; y += 18) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      for (let x = 0; x < w; x += 18) {
        ctx.beginPath();
        ctx.moveTo(x, L.shelfH);
        ctx.lineTo(x, L.counterY);
        ctx.stroke();
      }
      // shelf cabinet
      const wood = ctx.createLinearGradient(0, 0, 0, L.shelfH);
      wood.addColorStop(0, '#5c3a22');
      wood.addColorStop(1, '#4a2e1a');
      ctx.fillStyle = wood;
      ctx.fillRect(0, 0, w, L.shelfH);
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      for (let x = 12; x < w; x += 23) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.bezierCurveTo(x + 6, L.shelfH * 0.3, x - 6, L.shelfH * 0.7, x + 3, L.shelfH);
        ctx.stroke();
      }
      ctx.fillStyle = '#7a4d2c';
      ctx.fillRect(0, 0, L.side, L.shelfH);
      ctx.fillRect(w - L.side, 0, L.side, L.shelfH);
      for (let r = 0; r < 3; r++) {
        const y = 6 + L.rowH * (r + 1) - 4;
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(L.side, y - 6, w - 2 * L.side, 6);
        ctx.fillStyle = '#a5703f';
        ctx.fillRect(0, y, w, 7);
        ctx.fillStyle = '#7f5230';
        ctx.fillRect(0, y + 7, w, 3);
      }
      for (const [id, s] of Object.entries(L.slots)) {
        if (onScale && onScale.id === id) continue;
        ctx.save();
        ctx.translate(s.cx, s.bottom - s.h / 2);
        drawPackage(ctx, id, s.w, s.h, eggsLeft());
        ctx.restore();
      }
      // counter top
      const top = ctx.createLinearGradient(0, L.counterY, 0, h);
      top.addColorStop(0, '#c99c6b');
      top.addColorStop(1, '#a87a4c');
      ctx.fillStyle = top;
      ctx.fillRect(0, L.counterY, w, h - L.counterY);
      ctx.fillStyle = '#8a5a35';
      ctx.fillRect(0, L.counterY, w, 4);
      ctx.strokeStyle = 'rgba(90,55,30,0.18)';
      for (let y = L.counterY + 16; y < h; y += 22) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(w * 0.3, y + 5, w * 0.6, y - 5, w, y + 2);
        ctx.stroke();
      }
    }

    // ------------------------------------------------------------- the scale
    function pileHeight() {
      if (!onScale || onScale.amount <= 0) return 0;
      const unit = H.INGREDIENTS[onScale.id].unit;
      const norm = unit === 'g' ? 350 : unit === 'Stk' ? 4 : 8;
      return L.scale.rimRy * 2.4 * Math.min(1, Math.sqrt(onScale.amount / norm));
    }

    function drawScale(ctx) {
      const S = L.scale;
      // body
      const g = ctx.createLinearGradient(0, S.platY, 0, S.baseY);
      g.addColorStop(0, '#f4f6f8');
      g.addColorStop(1, '#c4ccd3');
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath();
      ctx.ellipse(S.cx, S.baseY + 2, S.w * 0.52, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(S.cx - S.w * 0.44, S.platY + 6);
      ctx.lineTo(S.cx + S.w * 0.44, S.platY + 6);
      ctx.lineTo(S.cx + S.w * 0.5, S.baseY - 4);
      ctx.quadraticCurveTo(S.cx + S.w * 0.5, S.baseY, S.cx + S.w * 0.46, S.baseY);
      ctx.lineTo(S.cx - S.w * 0.46, S.baseY);
      ctx.quadraticCurveTo(S.cx - S.w * 0.5, S.baseY, S.cx - S.w * 0.5, S.baseY - 4);
      ctx.closePath();
      ctx.fill();
      // display
      const dw = S.w * 0.56;
      const dh = Math.min(22, S.h * 0.42);
      const dy = S.platY + 10 + (S.h - 14 - dh) / 2;
      ctx.fillStyle = '#1c2a1f';
      rrect(ctx, S.cx - dw / 2, dy, dw, dh, 4);
      ctx.fill();
      ctx.fillStyle = '#b8ff9d';
      ctx.font = `800 ${Math.round(dh * 0.7)}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(amountText(), S.cx + dw / 2 - 5, dy + dh / 2 + 1);
      ctx.fillStyle = '#7d8a93';
      ctx.beginPath();
      ctx.arc(S.cx + S.w * 0.37, dy + dh / 2, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `700 7px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('TARA', S.cx + S.w * 0.37, dy + dh / 2 + 10);
      // platform
      ctx.fillStyle = '#9aa6af';
      ctx.beginPath();
      ctx.ellipse(S.cx, S.platY + 5, S.w * 0.4, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#dfe5ea';
      ctx.beginPath();
      ctx.ellipse(S.cx, S.platY + 3, S.w * 0.4, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      // weighing bowl (stainless steel)
      const bx = S.cx;
      const by = S.rimY;
      const steel = ctx.createLinearGradient(bx - S.rimRx, 0, bx + S.rimRx, 0);
      steel.addColorStop(0, '#9ba6ae');
      steel.addColorStop(0.35, '#f2f5f7');
      steel.addColorStop(1, '#7d8890');
      ctx.fillStyle = steel;
      ctx.beginPath();
      ctx.moveTo(bx - S.rimRx, by);
      ctx.quadraticCurveTo(bx - S.rimRx * 0.9, S.platY + 2, bx, S.platY + 2);
      ctx.quadraticCurveTo(bx + S.rimRx * 0.9, S.platY + 2, bx + S.rimRx, by);
      ctx.ellipse(bx, by, S.rimRx, S.rimRy, 0, 0, Math.PI, false);
      ctx.fill();
      ctx.fillStyle = '#aab4bb';
      ctx.beginPath();
      ctx.ellipse(bx, by, S.rimRx * 0.94, S.rimRy * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
      drawPile(ctx);
      ctx.strokeStyle = '#eef2f5';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(bx, by, S.rimRx, S.rimRy, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    function drawPile(ctx) {
      if (!onScale || onScale.amount <= 0) return;
      const S = L.scale;
      const p = POUR[onScale.id];
      const bx = S.cx;
      const by = S.rimY;
      const ph = pileHeight();
      ctx.save();
      if (p.type === 'egg') {
        const n = Math.round(onScale.amount);
        for (let i = 0; i < n; i++) {
          const ex = bx + (i - (n - 1) / 2) * S.rimRx * 0.42;
          const ey = by - 3 - (i % 2) * 3;
          const eg = ctx.createRadialGradient(ex - 2, ey - 4, 1, ex, ey, 10);
          eg.addColorStop(0, '#fffaf2');
          eg.addColorStop(1, '#e0c39b');
          ctx.fillStyle = eg;
          ctx.beginPath();
          ctx.ellipse(ex, ey, 7, 9, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (p.type === 'stream' || p.type === 'spoon') {
        // a puddle that rises
        const f = Math.min(1, ph / (S.rimRy * 2.4));
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.type === 'spoon' && onScale.id === 'milch' ? 0.95 : 0.9;
        ctx.beginPath();
        ctx.ellipse(bx, by + S.rimRy * 0.35 * (1 - f), S.rimRx * (0.55 + 0.37 * f), S.rimRy * (0.5 + 0.38 * f), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.5;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.ellipse(bx - S.rimRx * 0.25, by - S.rimRy * 0.1, S.rimRx * 0.18, 2, -0.2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // a heap with a little shine
        const rx = S.rimRx * (0.45 + 0.45 * Math.min(1, ph / (S.rimRy * 2)));
        const g = ctx.createRadialGradient(bx - rx * 0.3, by - ph * 0.8, 1, bx, by, rx * 1.2);
        g.addColorStop(0, H.mix(p.color, '#ffffff', 0.4));
        g.addColorStop(1, H.mix(p.color, '#000000', p.type === 'chunk' ? 0.2 : 0.12));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(bx, by + 1, rx, S.rimRy * 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(bx - rx, by + 1);
        ctx.quadraticCurveTo(bx - rx * 0.35, by - ph, bx, by - ph);
        ctx.quadraticCurveTo(bx + rx * 0.35, by - ph, bx + rx, by + 1);
        ctx.fill();
        if (p.type === 'chunk') {
          ctx.strokeStyle = 'rgba(160,120,30,0.5)';
          ctx.lineWidth = 1;
          for (let i = 0; i < 4; i++) ctx.strokeRect(bx - rx * 0.5 + i * rx * 0.25, by - ph * 0.5, 5, 5);
        }
      }
      ctx.restore();
    }

    // --------------------------------------------------------- mixing bowl
    function drawMixBowl(ctx) {
      const M = L.bowl;
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath();
      ctx.ellipse(M.cx, M.rimY + M.depth + 2, M.rx * 0.62, M.ry * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      const g = ctx.createLinearGradient(M.cx - M.rx, 0, M.cx + M.rx, 0);
      g.addColorStop(0, '#8fb3c9');
      g.addColorStop(0.35, '#e4f0f7');
      g.addColorStop(1, '#6f95ad');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(M.cx - M.rx, M.rimY);
      ctx.quadraticCurveTo(M.cx - M.rx * 0.92, M.rimY + M.depth, M.cx, M.rimY + M.depth);
      ctx.quadraticCurveTo(M.cx + M.rx * 0.92, M.rimY + M.depth, M.cx + M.rx, M.rimY);
      ctx.ellipse(M.cx, M.rimY, M.rx, M.ry, 0, 0, Math.PI, false);
      ctx.fill();
      ctx.fillStyle = '#7d9fb4';
      ctx.beginPath();
      ctx.ellipse(M.cx, M.rimY, M.rx * 0.95, M.ry * 0.92, 0, 0, Math.PI * 2);
      ctx.fill();

      const ids = Object.keys(added);
      if (ids.length > 0) {
        const total = Object.entries(added).reduce((s, [id, v]) => s + (H.INGREDIENTS[id].unit === 'g' ? v : v * 50), 0);
        const f = Math.min(1, total / 650);
        const base = kind === 'dough' ? H.doughColor(added) : (added.puderzucker ? '#f7f5ef' : '#fff27a');
        const crx = M.rx * (0.62 + 0.3 * f);
        const cry = M.ry * (0.58 + 0.3 * f);
        const ccy = M.rimY + M.ry * 0.3 * (1 - f);
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(M.cx, ccy, crx, cry, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = base;
        ctx.fillRect(M.cx - crx, ccy - cry, crx * 2, cry * 2);
        ids.forEach((id, i) => {
          ctx.globalAlpha = 0.9 * (1 - stir);
          ctx.fillStyle = (POUR[id] || {}).color || H.INGREDIENTS[id].color;
          const a = i * 2.4 + stirAngle * 0.5;
          const d = 0.25 + 0.4 * (((i * 37) % 10) / 10);
          ctx.beginPath();
          ctx.ellipse(M.cx + Math.cos(a) * crx * d, ccy + Math.sin(a) * cry * d, crx * 0.3, cry * 0.3, 0, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.globalAlpha = 0.25 + 0.2 * stir;
        ctx.strokeStyle = H.mix(base, '#000000', 0.25);
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let t = 0; t < 14; t += 0.1) {
          const rr = t / 14;
          const x = M.cx + Math.cos(t + stirAngle) * crx * 0.9 * rr;
          const y = ccy + Math.sin(t + stirAngle) * cry * 0.9 * rr;
          if (t === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      }
      ctx.strokeStyle = '#f3f9fc';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(M.cx, M.rimY, M.rx, M.ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      // wooden spoon in the bowl
      const sp = spoonAt || { x: M.cx + M.rx * 0.25, y: M.rimY + M.ry * 0.1 };
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#b7834f';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(sp.x, sp.y);
      ctx.lineTo(sp.x + M.rx * 0.55, sp.y - M.rx * 1.05);
      ctx.stroke();
      ctx.fillStyle = '#c99561';
      ctx.beginPath();
      ctx.ellipse(sp.x, sp.y, 8, 11, -0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // ----------------------------------------------------- pouring physics
    function mouth() {
      // top centre of the hovering package, turned with it
      const hh = L.pkg.h / 2;
      return { x: L.hover.x + hh * Math.sin(tilt), y: L.hover.y - hh * Math.cos(tilt) };
    }

    function tiltTarget(now) {
      if (!onScale) return 0;
      const type = POUR[onScale.id].type;
      if (type === 'egg') return 0;
      if (type === 'spoon') return now < pulseUntil ? -1.9 : -0.15;
      return pouring ? -1.95 : -0.15;
    }

    function spawn(type, color, from, opts = {}) {
      const p = {
        x: from.x + (Math.random() - 0.5) * (opts.spread || 4),
        y: from.y,
        vx: (Math.random() - 0.5) * (type === 'powder' ? 30 : 14) + (opts.vx || 0),
        vy: 10 + Math.random() * 30 + (opts.vy || 0),
        g: type === 'powder' ? 520 : 900,
        size: type === 'powder' ? 1.2 + Math.random() * 1.6 : type === 'grain' ? 1 + Math.random() * 0.9 : type === 'chunk' ? 3.5 + Math.random() * 2.5 : type === 'egg' ? 8 : 2.2 + Math.random(),
        color,
        type,
        floor: opts.floor !== undefined ? opts.floor : L.scale.rimY + L.scale.rimRy * 0.2 - pileHeight() * 0.7,
        life: 0,
        rot: Math.random() * Math.PI,
      };
      particles.push(p);
      return p;
    }

    function updateParticles(dt) {
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += dt;
        if (p.type === 'dust') {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.size += dt * 10;
          if (p.life > 0.6) particles.splice(i, 1);
          continue;
        }
        p.vy += p.g * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += dt * 6;
        if (p.vy > 0 && p.y >= p.floor) {
          particles.splice(i, 1);
          if (p.type === 'powder' && Math.random() < 0.35) {
            particles.push({ type: 'dust', x: p.x, y: p.y - 2, vx: (Math.random() - 0.5) * 30, vy: -10 - Math.random() * 15, size: 2, color: p.color, life: 0 });
          }
        }
      }
    }

    function drawParticles(ctx) {
      for (const p of particles) {
        ctx.fillStyle = p.color;
        if (p.type === 'dust') {
          ctx.globalAlpha = Math.max(0, 0.45 * (1 - p.life / 0.6));
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        } else if (p.type === 'egg') {
          const eg = ctx.createRadialGradient(p.x - 2, p.y - 3, 1, p.x, p.y, 9);
          eg.addColorStop(0, '#fffaf2');
          eg.addColorStop(1, '#e0c39b');
          ctx.fillStyle = eg;
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, 7, 9, p.rot * 0.2, 0, Math.PI * 2);
          ctx.fill();
        } else if (p.type === 'chunk') {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
          if (p.type === 'grain' && p.color === '#ffffff') {
            ctx.strokeStyle = 'rgba(120,130,140,0.45)';
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      }
    }

    function drawStream(ctx, now) {
      if (!onScale || POUR[onScale.id].type !== 'stream' || !pouring || tilt > -1.4) return;
      const m = mouth();
      const end = L.scale.rimY - pileHeight() * 0.5;
      const held = (now - pourStart) / 1000;
      ctx.strokeStyle = POUR[onScale.id].color;
      ctx.lineCap = 'round';
      ctx.lineWidth = 2 + Math.min(5, held * 2.5);
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      for (let y = m.y; y <= end; y += 4) {
        ctx.lineTo(m.x + Math.sin(y * 0.15 + now / 90) * 1.2, y);
      }
      ctx.stroke();
    }

    function pourTick(dt, now) {
      if (!onScale || !pouring) return;
      const ing = H.INGREDIENTS[onScale.id];
      if (ing.unit !== 'g' || tilt > -1.2) return;
      const held = (now - pourStart) / 1000;
      // Slow at first (a short press is a pinch), then faster and faster.
      const rate = 3 + 45 * Math.min(1, held / 3) ** 2;
      onScale.amount = Math.min(H.UNIT_MAX.g, onScale.amount + rate * dt);
      const p = POUR[onScale.id];
      if (p.type === 'stream') return;
      const perGram = p.type === 'powder' ? 2 : p.type === 'grain' ? 2.4 : 0.12;
      emitAcc += rate * dt * perGram + (p.type === 'chunk' ? 0 : dt * 18);
      const m = mouth();
      while (emitAcc >= 1) {
        emitAcc -= 1;
        spawn(p.type, p.color, m);
      }
      if (Math.random() < dt * 8) sound('tick');
    }

    function frame(now) {
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;
      tilt += (tiltTarget(now) - tilt) * Math.min(1, dt * 14);
      pourTick(dt, now);
      if (onScale && POUR[onScale.id].type === 'spoon' && dropsLeft > 0 && tilt < -1.3) {
        const m = mouth();
        for (let i = 0; i < 2 && dropsLeft > 0; i++, dropsLeft--) spawn('drop', POUR[onScale.id].color, m, { spread: 3 });
      }
      updateParticles(dt);
      render(now);
      raf = requestAnimationFrame(frame);
    }

    function render(now) {
      const { ctx, w, h } = view;
      ctx.clearRect(0, 0, w, h);
      if (!backdrop) renderBackdrop();
      ctx.drawImage(backdrop, 0, 0, w, h);
      drawScale(ctx);
      drawMixBowl(ctx);
      drawParticles(ctx);
      drawStream(ctx, now);
      if (onScale) {
        ctx.save();
        ctx.translate(L.hover.x, L.hover.y);
        ctx.rotate(tilt);
        drawPackage(ctx, onScale.id, L.pkg.w, L.pkg.h, eggsLeft());
        ctx.restore();
      }
    }

    // ------------------------------------------------------------ actions
    function amountText() {
      if (!onScale) return '0 g';
      const ing = H.INGREDIENTS[onScale.id];
      const v = Math.round(onScale.amount);
      if (ing.unit === 'Stk') return `${v} Stk`;
      return `${v} ${ing.unit}`;
    }

    function updateControls() {
      const ing = onScale ? H.INGREDIENTS[onScale.id] : null;
      pour.textContent = !ing ? 'Zutat im Regal antippen' : ing.unit === 'g' ? 'Halten: schütten' : ing.unit === 'Stk' ? '+1 Ei' : '+1 EL';
      const has = !!onScale && onScale.amount > 0;
      tip.disabled = !has;
      minus.disabled = !has;
      back.disabled = !onScale;
      pour.disabled = !onScale || (onScale.id === 'eier' && eggsLeft() === 0);
    }

    function updateBowlInfo() {
      chips.replaceChildren(...Object.entries(added).map(([id, amount]) => el('span', 'chip', H.formatAmount(id, amount))));
      if (Object.keys(added).length === 0) chips.append(el('span', 'chip empty', 'Schüssel ist leer'));
      meterBar.style.width = `${Math.round(stir * 100)}%`;
      meterText.textContent = stir >= 1 ? 'Glatt gerührt ✓' : `Rühren (Kreise in der Schüssel): ${Math.floor(stir * 100)} %`;
      meter.classList.toggle('done', stir >= 1);
    }

    function pickPackage(id) {
      if (onScale && onScale.id === id) return;
      if (onScale && onScale.amount > 0) {
        toast('Erst die Waage leeren: ✓ in die Schüssel oder ↩ zurück ins Regal.');
        return;
      }
      if (id === 'eier' && eggsLeft() === 0) {
        toast('Keine Eier mehr im Karton.');
        return;
      }
      onScale = { id, amount: 0 };
      tilt = 0;
      backdrop = null;
      sound('tick');
      updateControls();
    }

    function startPour() {
      if (!onScale) return;
      const ing = H.INGREDIENTS[onScale.id];
      const type = POUR[onScale.id].type;
      if (ing.unit === 'g') {
        pouring = true;
        pourStart = performance.now();
        onScale.amount = Math.min(H.UNIT_MAX.g, onScale.amount + 1);
        spawn(type === 'stream' ? 'drop' : type, POUR[onScale.id].color, mouth());
        pour.classList.add('holding');
      } else if (type === 'egg') {
        if (eggsLeft() === 0) return;
        onScale.amount += 1;
        spawn('egg', POUR.eier.color, { x: L.hover.x, y: L.hover.y + 6 }, { spread: 10, floor: L.scale.rimY - 4 });
        backdrop = null;
        sound('plop');
      } else {
        onScale.amount = Math.min(H.UNIT_MAX[ing.unit], onScale.amount + 1);
        pulseUntil = performance.now() + 520;
        dropsLeft += 10;
        sound('drop');
      }
      updateControls();
    }

    function stopPour() {
      pouring = false;
      pour.classList.remove('holding');
    }

    holdRepeat(minus, (dt, held, first) => {
      if (!onScale) return;
      const unit = H.INGREDIENTS[onScale.id].unit;
      if (unit !== 'g') {
        if (first) onScale.amount = Math.max(0, onScale.amount - 1);
        if (onScale.id === 'eier') backdrop = null;
      } else {
        const rate = 4 + 60 * Math.min(1, held / 2) ** 2;
        onScale.amount = Math.max(0, onScale.amount - (first ? 1 : rate * dt));
      }
      updateControls();
    });

    pour.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { pour.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      startPour();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) pour.addEventListener(type, stopPour);
    pour.addEventListener('contextmenu', (e) => e.preventDefault());

    back.addEventListener('click', () => {
      onScale = null;
      stopPour();
      backdrop = null;
      updateControls();
    });

    tip.addEventListener('click', () => {
      if (!onScale || onScale.amount <= 0) return;
      const amount = Math.round(onScale.amount);
      const id = onScale.id;
      // everything on the scale flies over into the bowl
      const S = L.scale;
      const M = L.bowl;
      const T = 0.5;
      const p = POUR[id];
      const n = p.type === 'egg' ? amount : 26;
      for (let i = 0; i < n; i++) {
        const from = { x: S.cx + (Math.random() - 0.5) * S.rimRx, y: S.rimY - pileHeight() * 0.5 };
        const tx = M.cx + (Math.random() - 0.5) * M.rx * 0.6;
        const ty = M.rimY;
        const g = 900;
        const part = spawn(p.type === 'stream' || p.type === 'spoon' ? 'drop' : p.type === 'powder' ? 'grain' : p.type, p.color, from, { spread: 0, floor: ty });
        part.g = g;
        part.vx = (tx - from.x) / T;
        part.vy = (ty - from.y) / T - 0.5 * g * T + (Math.random() - 0.5) * 40;
      }
      if (amount > 0) {
        added[id] = (added[id] || 0) + amount;
        stir *= 0.4; // fresh ingredients need stirring again
      }
      onScale = null;
      stopPour();
      backdrop = null;
      sound('plop');
      vibrate(15);
      updateControls();
      updateBowlInfo();
    });

    // canvas: tap the shelf, hold over the scale, stir in the bowl
    let stirLast = null;
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const p = canvasPoint(canvas, e);
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (p.y < L.shelfH) {
        const hit = Object.entries(L.slots).find(([, s]) => p.x >= s.cell.x && p.x < s.cell.x + s.cell.w && p.y >= s.cell.y && p.y < s.cell.y + s.cell.h + 8);
        if (hit) pickPackage(hit[0]);
        return;
      }
      const M = L.bowl;
      const nx = (p.x - M.cx) / (M.rx * 1.15);
      const ny = (p.y - M.rimY) / (M.ry * 1.6);
      if (nx * nx + ny * ny <= 1) {
        stirLast = Math.atan2((p.y - M.rimY) / (M.ry / M.rx), p.x - M.cx);
        spoonAt = p;
        return;
      }
      if (onScale && p.x < view.w * 0.55) startPour();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (stirLast === null) return;
      const p = canvasPoint(canvas, e);
      const M = L.bowl;
      const a = Math.atan2((p.y - M.rimY) / (M.ry / M.rx), p.x - M.cx);
      let d = a - stirLast;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      stirLast = a;
      spoonAt = { x: Math.max(M.cx - M.rx * 0.8, Math.min(M.cx + M.rx * 0.8, p.x)), y: Math.max(M.rimY - M.ry * 0.7, Math.min(M.rimY + M.ry * 0.7, p.y)) };
      if (Object.keys(added).length > 0 && Math.abs(d) < 1.2) {
        const before = stir;
        stir = Math.min(1, stir + Math.abs(d) / (2 * Math.PI * H.CONFIG.stirTurns));
        stirAngle += d;
        if (before < 1 && stir >= 1) {
          sound('ding');
          vibrate(30);
        }
        updateBowlInfo();
      }
    });
    const endCanvas = () => {
      stirLast = null;
      spoonAt = null;
      stopPour();
    };
    canvas.addEventListener('pointerup', endCanvas);
    canvas.addEventListener('pointercancel', endCanvas);

    updateControls();
    updateBowlInfo();
    raf = requestAnimationFrame(frame);

    return {
      collect: () => ({ added, stir }),
      check() {
        if (onScale && onScale.amount > 0) return 'Auf der Waage liegt noch etwas.';
        if (Object.keys(added).length === 0) return 'Die Schüssel ist noch leer.';
        if (stir < 1) return 'Noch nicht glatt gerührt.';
        return null;
      },
      cleanup() {
        cancelAnimationFrame(raf);
        stopPour();
      },
      resize() {
        view = fitCanvas(canvas);
        L = layout();
        backdrop = null;
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
    let cutter = null; // the metal cutter: { shape, x, y, phase: 'aim' | 'press' | 'lift', t0, ok }
    let raf = 0;

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
      if (cutter) drawCutter(ctx);
    }

    /** The cutter hovers raised over the dough, presses in and lifts off again. */
    function drawCutter(ctx) {
      const now = performance.now();
      let lift = 1; // 1 = raised, 0 = pressed into the dough
      let alpha = 1;
      if (cutter.phase === 'press') lift = Math.max(0, 1 - (now - cutter.t0) / 160);
      if (cutter.phase === 'lift') {
        const t = Math.min(1, (now - cutter.t0) / 260);
        lift = t;
        alpha = 1 - t;
      }
      const s = radius * (1.0 + 0.12 * lift);
      ctx.save();
      ctx.globalAlpha = alpha;
      // shadow on the dough
      ctx.save();
      ctx.translate(cutter.x + 6 * lift, cutter.y + 9 * lift);
      ctx.scale(radius, radius);
      ctx.lineJoin = 'round';
      ctx.lineWidth = 0.22;
      ctx.strokeStyle = `rgba(40,20,10,${0.12 + 0.2 * lift})`;
      ctx.stroke(shapePath(cutter.shape));
      ctx.restore();
      // metal band: dark outer edge, bright rolled top
      ctx.translate(cutter.x, cutter.y - 5 * lift);
      ctx.scale(s, s);
      ctx.lineJoin = 'round';
      const path = shapePath(cutter.shape);
      ctx.lineWidth = 0.2;
      ctx.strokeStyle = cutter.ok === false ? '#b23a48' : '#76828c';
      ctx.stroke(path);
      ctx.lineWidth = 0.1;
      ctx.strokeStyle = cutter.ok === false ? '#ff9aa8' : '#f1f5f8';
      ctx.stroke(path);
      ctx.lineWidth = 0.03;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.translate(-0.04, -0.05);
      ctx.stroke(path);
      ctx.restore();
    }

    function animate() {
      draw();
      if (!cutter) return;
      const now = performance.now();
      if (cutter.phase === 'press' && now - cutter.t0 >= 160) {
        cutter = { ...cutter, phase: 'lift', t0: now };
      } else if (cutter.phase === 'lift' && now - cutter.t0 >= 260) {
        cutter = null;
        draw();
        return;
      }
      raf = requestAnimationFrame(animate);
    }

    function fits(p) {
      const sheet = doughSheet(view.w, view.h, mm);
      const nx = (p.x - sheet.cx) / Math.max(1, sheet.rx - radius * 0.9);
      const ny = (p.y - sheet.cy) / Math.max(1, sheet.ry - radius * 0.9);
      const inside = sheet.rx > radius && sheet.ry > radius && nx * nx + ny * ny <= 1;
      const free = placed.every((c) => Math.hypot(c.x - p.x, c.y - p.y) > radius * 1.85);
      return { inside, free };
    }

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      cancelAnimationFrame(raf); // a new press ends the previous cutter animation
      cutter = null;
      const p = canvasPoint(canvas, e);
      const hit = placed.findIndex((c) => Math.hypot(c.x - p.x, c.y - p.y) < radius * 0.9);
      if (hit >= 0) {
        placed.splice(hit, 1);
        sound('tick');
        update();
        return;
      }
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const f = fits(p);
      cutter = { shape: selected, x: p.x, y: p.y, phase: 'aim', ok: f.inside && f.free };
      cancelAnimationFrame(raf);
      draw();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!cutter || cutter.phase !== 'aim') return;
      const p = canvasPoint(canvas, e);
      const f = fits(p);
      cutter.x = p.x;
      cutter.y = p.y;
      cutter.ok = f.inside && f.free;
      draw();
    });
    canvas.addEventListener('pointerup', () => {
      if (!cutter || cutter.phase !== 'aim') return;
      const f = fits(cutter);
      if (!f.inside || !f.free) {
        toast(f.inside ? 'Da ist kein Platz mehr – woanders ausstechen.' : 'Da ist kein Teig.');
        vibrate([20, 30, 20]);
        cutter = null;
        draw();
        return;
      }
      // The cookie counts right away; the cutter pressing in and lifting off is only the show.
      placed.push({ shape: cutter.shape, x: cutter.x, y: cutter.y });
      sound('cut');
      vibrate(12);
      cutter.phase = 'press';
      cutter.t0 = performance.now();
      update();
      raf = requestAnimationFrame(animate);
    });
    canvas.addEventListener('pointercancel', () => {
      if (cutter && cutter.phase === 'aim') cutter = null;
      draw();
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
      cleanup: () => cancelAnimationFrame(raf),
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

  function roundRectPath(p, x, y, w, h, r) {
    p.moveTo(x + r, y);
    p.arcTo(x + w, y, x + w, y + h, r);
    p.arcTo(x + w, y + h, x, y + h, r);
    p.arcTo(x, y + h, x, y, r);
    p.arcTo(x, y, x + w, y, r);
    p.closePath();
  }

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
      case 'kasten': // loaf tin from above
        roundRectPath(p, -1, -0.5, 2, 1, 0.12);
        break;
      case 'ring': // Gugelhupf: a ring with a hole
        p.arc(0, 0, 0.95, 0, Math.PI * 2);
        p.moveTo(0.3, 0);
        p.arc(0, 0, 0.3, 0, Math.PI * 2, true);
        break;
      case 'tarte': {
        const pts = [];
        for (let i = 0; i < 120; i++) {
          const a = (i / 120) * Math.PI * 2;
          const r = 0.92 + 0.05 * Math.cos(18 * a);
          pts.push([Math.cos(a) * r, Math.sin(a) * r]);
        }
        poly(pts);
        break;
      }
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

  /**
   * Where the sprinkles sit on a cookie (unit coordinates). All kinds share one evenly
   * spread layout, so sprinkles keep their distance and never pile up.
   */
  function sprinkleLayout(shape, kinds) {
    const key = `${shape}:${kinds.join(',')}`;
    if (SPRINKLE_SPOTS.has(key)) return SPRINKLE_SPOTS.get(key);
    const rng = seeded([...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7));
    const path = shapePath(shape);
    const want = Math.min(15, 7 * kinds.length);
    const spots = [];
    for (let minD = 0.36; spots.length < want && minD > 0.12; minD -= 0.04) {
      for (let tries = 0; spots.length < want && tries < 300; tries++) {
        const x = (rng() * 2 - 1) * 0.9;
        const y = (rng() * 2 - 1) * 0.9;
        if (!hitCtx.isPointInPath(path, x, y) || !hitCtx.isPointInPath(path, x * 1.22, y * 1.22)) continue;
        if (spots.some((s) => Math.hypot(s.x - x, s.y - y) < minD)) continue;
        spots.push({ x, y, a: rng() * Math.PI, c: rng(), kind: kinds[spots.length % kinds.length] });
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
      case 'puder': {
        // a soft cloud of powdered sugar
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s * 1.3);
        g.addColorStop(0, 'rgba(255,255,255,0.75)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, s * 1.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < 6; i++) ctx.fillRect(Math.cos(i * 2.1 + c * 6) * s * 0.8, Math.sin(i * 2.1 + c * 6) * s * 0.8, 1.2, 1.2);
        break;
      }
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
    if (look.sprinkles && look.sprinkles.length) {
      for (const spot of sprinkleLayout(shape, look.sprinkles)) {
        drawSprinkle(ctx, spot.kind, spot.x * r, spot.y * r, r * 0.17, spot.a, spot.c);
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
    const cakeMode = !!(recipe && recipe.kind && recipe.kind !== 'cookie');
    const msPerMinute = (recipe && recipe.bake && recipe.bake.msPerMinute) || H.CONFIG.bakeMsPerMinute;

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
      const spots = cakeMode ? [{ x: (tw - 20) / 2, y: (th - 20) / 2, r: Math.min(tw, th) * 0.4 }] : trayLayout(cookieList.length, tw - 20, th - 20);
      if (cakeMode) drawTin(ctx, (recipe && recipe.form) || 'springform', tx + 10 + spots[0].x, ty + 10 + spots[0].y, spots[0].r * 1.08);
      cookieList.forEach((shape, i) => drawCookie(ctx, { ...look, kind: 'cookie', mm: cakeMode ? 3 : look.mm }, shape, tx + 10 + spots[i].x, ty + 10 + spots[i].y, spots[i].r * (cakeMode ? 0.9 : 1), i));
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
      minutes = (performance.now() - startedAt) / msPerMinute;
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
        minutes = (performance.now() - startedAt) / msPerMinute;
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

  // ------------------------------------------------------- stove (jam, chocolate)
  function drawFruit(ctx, id, x, y, r) {
    const color = H.FRUITS[id] ? H.FRUITS[id].color : '#c0392b';
    const ball = (bx, by, br, c) => {
      const g = ctx.createRadialGradient(bx - br * 0.35, by - br * 0.35, br * 0.1, bx, by, br);
      g.addColorStop(0, H.mix(c, '#ffffff', 0.45));
      g.addColorStop(1, c);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
    };
    ctx.save();
    switch (id) {
      case 'erdbeere': {
        ctx.translate(x, y);
        ctx.rotate(Math.PI);
        ctx.scale(r, r * 1.1);
        ctx.fillStyle = color;
        ctx.fill(shapePath('herz'));
        ctx.restore();
        ctx.save();
        ctx.fillStyle = '#ffe38a';
        for (let i = 0; i < 6; i++) ctx.fillRect(x - r * 0.5 + (i % 3) * r * 0.45, y - r * 0.2 + Math.floor(i / 3) * r * 0.5, 1.4, 1.4);
        ctx.fillStyle = '#3f9a5b';
        ctx.beginPath();
        ctx.ellipse(x, y - r * 0.95, r * 0.6, r * 0.22, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'himbeere':
        for (const [dx, dy] of [[0, -0.5], [-0.45, -0.15], [0.45, -0.15], [-0.3, 0.35], [0.3, 0.35], [0, 0.05], [0, 0.65]]) ball(x + dx * r, y + dy * r, r * 0.36, color);
        break;
      case 'aprikose':
        ball(x, y, r, color);
        ctx.fillStyle = 'rgba(220,70,40,0.35)';
        ctx.beginPath();
        ctx.arc(x + r * 0.3, y - r * 0.2, r * 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(150,80,20,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x - r * 0.15, y, r * 0.8, -1, 1);
        ctx.stroke();
        break;
      case 'johannisbeere':
        ctx.strokeStyle = '#3f6b2a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - r, y - r);
        ctx.quadraticCurveTo(x, y - r * 0.3, x + r * 0.8, y + r * 0.6);
        ctx.stroke();
        for (let i = 0; i < 5; i++) ball(x - r * 0.7 + i * r * 0.38, y - r * 0.55 + i * r * 0.3, r * 0.3, color);
        break;
      case 'kirsche':
        ctx.strokeStyle = '#3f6b2a';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(x - r * 0.5, y);
        ctx.quadraticCurveTo(x - r * 0.2, y - r * 1.2, x + r * 0.2, y - r * 1.3);
        ctx.moveTo(x + r * 0.55, y + r * 0.1);
        ctx.quadraticCurveTo(x + r * 0.4, y - r * 1.1, x + r * 0.2, y - r * 1.3);
        ctx.stroke();
        ball(x - r * 0.5, y + r * 0.1, r * 0.55, color);
        ball(x + r * 0.55, y + r * 0.2, r * 0.55, color);
        break;
      case 'heidelbeere':
        for (const [dx, dy] of [[-0.45, 0.2], [0.45, 0.2], [0, -0.35], [0, 0.55]]) {
          ball(x + dx * r, y + dy * r, r * 0.42, color);
          ctx.fillStyle = 'rgba(200,200,255,0.5)';
          ctx.fillRect(x + dx * r - 1, y + dy * r - r * 0.3, 2, 2);
        }
        break;
      default:
        ball(x, y, r, color);
    }
    ctx.restore();
  }

  function drawCrate(ctx, id, w, h) {
    // a little wooden crate with fruit piled on top, origin = centre of the slot
    const B = h / 2;
    const cw = w * 0.92;
    const ch = h * 0.42;
    ctx.fillStyle = '#b07a45';
    ctx.fillRect(-cw / 2, B - ch, cw, ch);
    ctx.fillStyle = '#8a5a30';
    for (let i = 1; i < 3; i++) ctx.fillRect(-cw / 2, B - ch + (ch * i) / 3 - 1, cw, 2);
    const r = Math.min(w * 0.14, h * 0.14);
    const pile = [[-0.28, 0.02], [0, -0.04], [0.28, 0.02], [-0.14, -0.2], [0.14, -0.2]];
    for (const [fx, fy] of pile) drawFruit(ctx, id, fx * w, B - ch + fy * h - r * 0.2, r);
    ctx.fillStyle = '#fffdf6';
    rrect(ctx, -cw * 0.42, B - ch * 0.62, cw * 0.84, ch * 0.42, 2);
    ctx.fill();
    ctx.save();
    ctx.translate(0, 0);
    tag(ctx, H.FRUITS[id].name, B - ch * 0.41, cw * 0.78, '#5a2a10', 8, 800);
    ctx.restore();
  }

  function drawNutBowl(ctx, id, w, h) {
    const B = h / 2;
    const bw = w * 0.86;
    const color = H.CRUNCH_ITEMS[id].color;
    ctx.fillStyle = color;
    for (let i = 0; i < 26; i++) {
      const a = i * 2.39996;
      const d = Math.sqrt(i / 26);
      ctx.fillStyle = H.mix(color, i % 3 ? '#ffffff' : '#000000', 0.12);
      ctx.fillRect(Math.cos(a) * d * bw * 0.36 - 2, B - h * 0.36 + Math.sin(a) * d * h * 0.1 - 2, 4, 3);
    }
    ctx.fillStyle = '#f4f1ec';
    ctx.beginPath();
    ctx.moveTo(-bw / 2, B - h * 0.34);
    ctx.quadraticCurveTo(-bw / 2, B, 0, B);
    ctx.quadraticCurveTo(bw / 2, B, bw / 2, B - h * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#7fa7d6';
    ctx.fillRect(-bw / 2 + 4, B - h * 0.22, bw - 8, 2);
    tag(ctx, H.CRUNCH_ITEMS[id].name.replace('gehackte ', ''), B - h * 0.12, bw * 0.9, '#5a3d0c', 8, 800);
  }

  function drawChocBar(ctx, id, w, h) {
    const c = H.CHOCOLATES[id];
    const wrap = { zartbitter: '#7a1e2b', vollmilch: '#6a4c93', weiss: '#9cc3e6' }[id];
    const B = h / 2;
    const bw = w * 0.8;
    const bh = h * 0.8;
    // chocolate peeking out of the wrapper
    ctx.fillStyle = c.color;
    rrect(ctx, -bw / 2, B - bh, bw, bh * 0.45, 3);
    ctx.fill();
    ctx.strokeStyle = H.mix(c.color, '#000000', 0.25);
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(-bw / 2 + (bw * i) / 3, B - bh);
      ctx.lineTo(-bw / 2 + (bw * i) / 3, B - bh * 0.55);
      ctx.stroke();
    }
    ctx.fillStyle = wrap;
    rrect(ctx, -bw / 2 - 1, B - bh * 0.6, bw + 2, bh * 0.6, 3);
    ctx.fill();
    ctx.fillStyle = '#d9b75e';
    ctx.fillRect(-bw / 2 - 1, B - bh * 0.6, bw + 2, 3);
    tag(ctx, c.prefix, B - bh * 0.3, bw * 0.86, '#ffffff', 10, 900);
    shade(ctx, -bw / 2, B - bh, bw, bh);
  }

  function buildStove(body, mode) {
    const isJam = mode === 'jam';
    const isCrunch = mode === 'crunch';
    const catalogue = isJam ? H.JAM_ITEMS : isCrunch ? H.CRUNCH_ITEMS : H.CHOCOLATES;
    const items = isJam ? [...Object.keys(H.FRUITS), 'gelierzucker'] : Object.keys(catalogue);
    const portion = (id) => (isJam ? 50 : isCrunch ? H.CRUNCH_ITEMS[id].portion : 25);
    let caramel = 0;       // crunch: 0 raw, 1 golden, 1.5 dark
    const added = {};
    const order = [];      // added portions, newest last (for undo)
    let heat = 0;          // knob 0..9
    let temp = 20;         // contents (°C)
    let water = 20;        // water bath (chocolate)
    let maxTemp = 0;
    let boilMinutes = 0;
    let burnt = 0;
    let overheat = 0;
    let melt = 0;
    let lastStir = -1e9;
    let stirAngle = 0;
    let stirLast = null;
    const flying = [];
    let raf = 0;
    let lastT = performance.now();
    const target = !isJam && recipe && recipe.choc ? recipe.choc.temp : 45;

    const canvas = el('canvas', 'stove-canvas');
    const controls = el('div', 'stove-controls');
    const down = el('button', 'knob', '−');
    down.type = 'button';
    const heatEl = el('strong', 'stove-heat', 'Herd: aus');
    const up = el('button', 'knob', '+');
    up.type = 'button';
    const undo = el('button', 'scale-btn ghost', '↩ Rückgängig');
    undo.type = 'button';
    controls.append(down, heatEl, up, undo);
    const status = el('p', 'decorate-hint', '');
    const chips = el('div', 'bowl-chips');
    body.append(canvas, controls, status, chips);
    let view = fitCanvas(canvas);
    let L = layout();

    function layout() {
      const { w, h } = view;
      const shelfH = Math.min(h * 0.25, 120);
      const slot = (w - 12) / items.length;
      const itemW = Math.min(slot * 0.92, shelfH * 0.95);
      const hobY = h * 0.6;
      const potW = Math.min(w * 0.5, 210);
      const potH = potW * 0.42;
      const potBottom = hobY + (h - hobY) * 0.42;
      return {
        shelfH,
        slot,
        itemW,
        itemH: shelfH - 16,
        hobY,
        pot: { cx: w * 0.44, bottom: potBottom, top: potBottom - potH, w: potW, h: potH, ry: potW * 0.14 },
        thermo: { x: w * 0.88, top: shelfH + 34, bottom: hobY + (h - hobY) * 0.55 },
      };
    }

    function total() {
      return Object.values(added).reduce((a, b) => a + b, 0);
    }

    function update() {
      heatEl.textContent = heat === 0 ? 'Herd: aus' : `Herd: Stufe ${heat}`;
      down.disabled = heat === 0;
      up.disabled = heat === 9;
      undo.disabled = order.length === 0 || temp > 50 || caramel > 0.05;
      chips.replaceChildren(...Object.entries(added).map(([id, g]) => el('span', 'chip', `${g} g ${catalogue[id].name}`)));
      if (order.length === 0) chips.append(el('span', 'chip empty', isJam ? 'Topf ist leer' : isCrunch ? 'Pfanne ist leer' : 'Schüssel ist leer'));
    }

    function setStatus(now) {
      let text;
      if (isCrunch) {
        if (total() === 0) text = 'Nüsse, Zucker und Butter in die Pfanne tippen.';
        else if (caramel < 0.05) text = temp < 150 ? 'Herd aufdrehen, die Pfanne muss heiß werden …' : 'Gleich fängt es an zu rösten – rühren!';
        else if (now - lastStir > 2500) text = '🔥 Rühren! Sonst brennt es an!';
        else if (caramel < 0.85) text = `Röstet … noch hell (${Math.round(caramel * 100)} %) – weiter rühren.`;
        else if (caramel <= 1.25) text = '✨ Goldbraun – jetzt mit „Fertig“ vom Herd nehmen!';
        else text = '♨️ Zu dunkel!';
      } else if (isJam) {
        if (total() === 0) text = 'Früchte und Gelierzucker aus den Kisten in den Topf tippen.';
        else if (temp < 99.5) text = heat < 6 && temp > 40 ? 'Mehr Hitze – die Marmelade muss sprudelnd kochen.' : 'Herd aufdrehen und aufkochen lassen …';
        else if (now - lastStir > 2500) text = '🔥 Rühren! Sonst brennt es an!';
        else text = `Sprudelt seit ${H.num(Math.floor(boilMinutes * 10) / 10)} Minuten – weiter rühren.`;
      } else if (total() === 0) text = 'Schokolade antippen, um Stücke in die Schüssel zu brechen.';
      else if (temp > target + 10) text = '♨️ Zu heiß! Die Schokolade wird krümelig.';
      else if (melt >= 0.999) text = 'Die Schokolade ist ganz geschmolzen ✓';
      else if (temp < 32) text = 'Das Wasserbad muss warm werden …';
      else text = `Schmilzt … ${Math.round(melt * 100)} % – rühren hilft.`;
      if (status.textContent !== text) status.textContent = text;
    }

    function addItem(id) {
      if (!isJam && melt > 0.5 && !added[id]) {
        toast('Da ist schon geschmolzene Schokolade drin.');
      }
      added[id] = (added[id] || 0) + portion(id);
      order.push(id);
      const { w } = view;
      const i = items.indexOf(id);
      const from = { x: 6 + L.slot * (i + 0.5), y: L.shelfH * 0.6 };
      const to = { x: L.pot.cx + (Math.random() - 0.5) * L.pot.w * 0.4, y: isCrunch ? L.pot.bottom - L.pot.h * 0.4 : L.pot.top + L.pot.ry * 0.3 };
      for (let k = 0; k < (id === 'gelierzucker' || isCrunch ? 8 : 3); k++) {
        flying.push({ id, x0: from.x + (Math.random() - 0.5) * 10, y0: from.y, x1: to.x + (Math.random() - 0.5) * 16, y1: to.y, t: -k * 0.05, r: id === 'gelierzucker' ? 1.5 : Math.min(w * 0.03, 9) });
      }
      sound('plop');
      vibrate(10);
      update();
    }

    function contentsColor() {
      if (isCrunch) return H.bakedColor('#efd9b0', caramel);
      if (isJam) {
        let r = 0, g = 0, b = 0, n = 0;
        for (const [id, grams] of Object.entries(added)) {
          if (!H.FRUITS[id]) continue;
          const c = parseInt(H.FRUITS[id].color.slice(1), 16);
          r += ((c >> 16) & 255) * grams;
          g += ((c >> 8) & 255) * grams;
          b += (c & 255) * grams;
          n += grams;
        }
        let c = n ? `#${[r, g, b].map((v) => Math.round(v / n).toString(16).padStart(2, '0')).join('')}` : '#f5f0e6';
        if (burnt > 0.5) c = H.mix(c, '#2a1208', Math.min(0.6, burnt / 8));
        return c;
      }
      const kinds = Object.entries(added).sort((a, b) => b[1] - a[1]);
      let c = kinds.length ? H.CHOCOLATES[kinds[0][0]].color : '#cccccc';
      if (overheat > 1) c = H.mix(c, '#8a8070', Math.min(0.4, overheat / 10));
      return c;
    }

    function physics(dt, now) {
      const minutes = (dt * 1000) / H.CONFIG.bakeMsPerMinute;
      if (isCrunch) {
        const eq = Math.min(260, 20 + heat * 26);
        temp += (eq - temp) * Math.min(1, dt * 0.6 / (1 + total() / 300));
        if (total() > 0) {
          maxTemp = Math.max(maxTemp, temp);
          const burning = now - lastStir > 2500 && caramel > 0.3;
          if (temp > 150) caramel += dt * ((temp - 150) / 60) * 0.22 * (burning ? 1.5 : 1);
          if (burning && temp > 150) burnt += dt;
        }
      } else if (isJam) {
        const eq = Math.min(103, 20 + heat * 14);
        const k = 0.7 / (1 + total() / 500);
        temp += (eq - temp) * Math.min(1, dt * k);
        if (total() > 0) maxTemp = Math.max(maxTemp, temp);
        const boiling = total() > 0 && temp >= 99.5;
        if (boiling) {
          boilMinutes += minutes;
          if (now - lastStir > 2500) burnt += dt * (heat >= 8 ? 1.5 : 1);
        }
      } else {
        const eq = Math.min(100, 20 + heat * 9);
        water += (eq - water) * Math.min(1, dt * 0.35);
        temp += (water - temp) * Math.min(1, dt * (total() > 0 ? 0.45 : 2));
        if (total() > 0) {
          maxTemp = Math.max(maxTemp, temp);
          if (temp > 32 && melt < 1) melt = Math.min(1, melt + dt * (temp - 32) * 0.0065 * (now - lastStir < 600 ? 1.7 : 1));
          if (temp > target + 10) overheat += dt;
        }
      }
    }

    function drawThermo(ctx) {
      const T = L.thermo;
      ctx.fillStyle = '#f4f6f8';
      rrect(ctx, T.x - 9, T.top, 18, T.bottom - T.top, 9);
      ctx.fill();
      ctx.fillStyle = '#e63946';
      ctx.beginPath();
      ctx.arc(T.x, T.bottom - 10, 9, 0, Math.PI * 2);
      ctx.fill();
      const span = T.bottom - T.top - 28;
      const scaleMax = isCrunch ? 260 : 120;
      const f = Math.max(0, Math.min(1, (temp - 0) / scaleMax));
      ctx.fillRect(T.x - 3, T.bottom - 14 - span * f, 6, span * f + 4);
      ctx.fillStyle = '#58636c';
      ctx.font = `600 8px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const mark of isCrunch ? [50, 100, 150, 200, 250] : [20, 40, 60, 80, 100]) {
        const y = T.bottom - 14 - span * (mark / scaleMax);
        ctx.fillRect(T.x + 4, y, 5, 1);
        ctx.fillText(String(mark), T.x - 11, y);
      }
      ctx.fillStyle = '#ffffff';
      ctx.font = `800 15px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(temp)}°`, T.x, T.top - 10);
    }

    function render(now) {
      const { ctx, w, h } = view;
      ctx.clearRect(0, 0, w, h);
      // wall and shelf
      ctx.fillStyle = '#efe6d8';
      ctx.fillRect(0, 0, w, L.hobY);
      ctx.fillStyle = '#5c3a22';
      ctx.fillRect(0, 0, w, L.shelfH);
      ctx.fillStyle = '#a5703f';
      ctx.fillRect(0, L.shelfH - 8, w, 8);
      items.forEach((id, i) => {
        ctx.save();
        ctx.translate(6 + L.slot * (i + 0.5), (L.shelfH - 8) / 2 + 4);
        if (H.FRUITS[id]) drawCrate(ctx, id, L.itemW, L.itemH);
        else if (isCrunch && (id === 'zucker' || id === 'butter')) drawPackage(ctx, id, L.itemW, L.itemH);
        else if (isCrunch) drawNutBowl(ctx, id, L.itemW, L.itemH);
        else if (id === 'gelierzucker') cardBox(ctx, L.itemW, L.itemH, { body: '#ffffff', band: '#d63a3a', text: ['Gelier', 'zucker'], small: '2:1', width: 0.72, height: 0.86 });
        else drawChocBar(ctx, id, L.itemW, L.itemH);
        ctx.restore();
      });
      // hob
      const hob = ctx.createLinearGradient(0, L.hobY, 0, h);
      hob.addColorStop(0, '#2b2f33');
      hob.addColorStop(1, '#16191c');
      ctx.fillStyle = hob;
      ctx.fillRect(0, L.hobY, w, h - L.hobY);
      const P = L.pot;
      const glow = heat / 9;
      ctx.strokeStyle = `rgb(${Math.round(80 + 175 * glow)}, ${Math.round(40 + 40 * glow)}, 30)`;
      ctx.lineWidth = 4;
      for (const k of [1, 0.7, 0.4]) {
        ctx.beginPath();
        ctx.ellipse(P.cx, P.bottom + 4, P.w * 0.62 * k, P.w * 0.12 * k, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (glow > 0) {
        const g = ctx.createRadialGradient(P.cx, P.bottom + 4, 0, P.cx, P.bottom + 4, P.w * 0.7);
        g.addColorStop(0, `rgba(255,90,30,${0.35 * glow})`);
        g.addColorStop(1, 'rgba(255,90,30,0)');
        ctx.fillStyle = g;
        ctx.fillRect(P.cx - P.w, P.bottom - P.w * 0.2, P.w * 2, P.w * 0.5);
      }
      if (isCrunch) {
        renderPan(ctx, now);
        drawThermo(ctx);
        return;
      }
      // pot (side view, open top)
      const steel = ctx.createLinearGradient(P.cx - P.w / 2, 0, P.cx + P.w / 2, 0);
      steel.addColorStop(0, '#7d8890');
      steel.addColorStop(0.35, '#e9eef1');
      steel.addColorStop(1, '#6f7a82');
      ctx.fillStyle = '#1f1f1f';
      rrect(ctx, P.cx - P.w / 2 - 22, P.top + P.h * 0.25, 26, 8, 4); // handles
      ctx.fill();
      rrect(ctx, P.cx + P.w / 2 - 4, P.top + P.h * 0.25, 26, 8, 4);
      ctx.fill();
      ctx.fillStyle = steel;
      ctx.beginPath();
      ctx.moveTo(P.cx - P.w / 2, P.top);
      ctx.lineTo(P.cx - P.w / 2, P.bottom - 6);
      ctx.quadraticCurveTo(P.cx - P.w / 2, P.bottom, P.cx - P.w / 2 + 6, P.bottom);
      ctx.lineTo(P.cx + P.w / 2 - 6, P.bottom);
      ctx.quadraticCurveTo(P.cx + P.w / 2, P.bottom, P.cx + P.w / 2, P.bottom - 6);
      ctx.lineTo(P.cx + P.w / 2, P.top);
      ctx.ellipse(P.cx, P.top, P.w / 2, P.ry, 0, 0, Math.PI, false);
      ctx.fill();
      ctx.fillStyle = '#4b555c';
      ctx.beginPath();
      ctx.ellipse(P.cx, P.top, P.w / 2 - 2, P.ry - 1, 0, 0, Math.PI * 2);
      ctx.fill();

      let surface = { cx: P.cx, cy: P.top + P.ry * 0.35, rx: P.w / 2 - 6, ry: P.ry * 0.8 };
      if (!isJam) {
        // water bath: a metal bowl sits on the pot
        ctx.fillStyle = 'rgba(160,200,230,0.7)';
        ctx.beginPath();
        ctx.ellipse(P.cx, P.top + 2, P.w / 2 - 4, P.ry * 0.85, 0, 0, Math.PI * 2);
        ctx.fill();
        const bw = P.w * 0.46;
        const by = P.top - P.ry * 0.9;
        ctx.fillStyle = steel;
        ctx.beginPath();
        ctx.moveTo(P.cx - bw, by);
        ctx.quadraticCurveTo(P.cx - bw * 0.9, P.top + P.ry * 0.9, P.cx, P.top + P.ry * 0.9);
        ctx.quadraticCurveTo(P.cx + bw * 0.9, P.top + P.ry * 0.9, P.cx + bw, by);
        ctx.ellipse(P.cx, by, bw, P.ry, 0, 0, Math.PI, false);
        ctx.fill();
        ctx.fillStyle = '#56616a';
        ctx.beginPath();
        ctx.ellipse(P.cx, by, bw - 2, P.ry - 1, 0, 0, Math.PI * 2);
        ctx.fill();
        surface = { cx: P.cx, cy: by + P.ry * 0.3, rx: bw - 6, ry: P.ry * 0.75 };
      }
      if (total() > 0) {
        const c = contentsColor();
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(surface.cx, surface.cy, surface.rx, surface.ry, 0, 0, Math.PI * 2);
        ctx.clip();
        if (isJam) {
          ctx.fillStyle = H.mix(c, '#ffffff', Math.max(0, 0.25 - temp / 400));
          ctx.fillRect(surface.cx - surface.rx, surface.cy - surface.ry, surface.rx * 2, surface.ry * 2);
          // fruit pieces swirl until they cook down
          const cooked = Math.min(1, boilMinutes / 4);
          let i = 0;
          for (const id of order) {
            if (!H.FRUITS[id]) continue;
            const a = i * 2.1 + stirAngle * 0.6;
            const d = 0.25 + ((i * 37) % 10) / 16;
            ctx.globalAlpha = 1 - cooked * 0.8;
            drawFruit(ctx, id, surface.cx + Math.cos(a) * surface.rx * d * 0.8, surface.cy + Math.sin(a) * surface.ry * d * 0.8, surface.ry * 0.4);
            i++;
          }
          ctx.globalAlpha = 1;
          if (temp >= 99.5) {
            // bubbles
            const t = now / 1000;
            ctx.strokeStyle = 'rgba(255,255,255,0.55)';
            ctx.lineWidth = 1.2;
            for (let k = 0; k < 9 + heat; k++) {
              const ph = (t * (1.5 + (k % 3) * 0.4) + k * 0.37) % 1;
              const bx = surface.cx + Math.sin(k * 7.1) * surface.rx * 0.75;
              const by = surface.cy + Math.cos(k * 3.3) * surface.ry * 0.6;
              ctx.beginPath();
              ctx.arc(bx, by, 1 + ph * 4, 0, Math.PI * 2);
              ctx.stroke();
            }
          }
        } else {
          ctx.fillStyle = H.mix(c, '#000000', 0.1);
          ctx.globalAlpha = Math.min(1, 0.2 + melt);
          ctx.fillRect(surface.cx - surface.rx, surface.cy - surface.ry, surface.rx * 2, surface.ry * 2);
          ctx.globalAlpha = 1;
          // chunks that have not melted yet
          const chunks = Math.ceil((1 - melt) * Math.min(14, total() / 15));
          for (let k = 0; k < chunks; k++) {
            const a = k * 2.4 + stirAngle * 0.4;
            const d = ((k * 41) % 10) / 12;
            ctx.save();
            ctx.translate(surface.cx + Math.cos(a) * surface.rx * d * 0.8, surface.cy + Math.sin(a) * surface.ry * d * 0.8);
            ctx.rotate(a);
            ctx.fillStyle = c;
            ctx.fillRect(-7, -4, 14, 8);
            ctx.strokeStyle = H.mix(c, '#000000', 0.3);
            ctx.strokeRect(-7, -4, 14, 8);
            ctx.restore();
          }
          if (overheat > 1) {
            ctx.fillStyle = 'rgba(120,110,95,0.6)';
            for (let k = 0; k < 20; k++) ctx.fillRect(surface.cx + Math.sin(k * 5.7) * surface.rx * 0.8, surface.cy + Math.cos(k * 3.1) * surface.ry * 0.7, 2, 2);
          }
        }
        // stir swirl
        ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let t = 0; t < 10; t += 0.1) {
          const rr = t / 10;
          const x = surface.cx + Math.cos(t + stirAngle) * surface.rx * 0.85 * rr;
          const y = surface.cy + Math.sin(t + stirAngle) * surface.ry * 0.85 * rr;
          if (t === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      }
      // steam, smoke
      if (temp > 60) {
        const t = now / 1000;
        const burning = isJam && burnt > 0.3 && now - lastStir > 2500;
        ctx.fillStyle = burning ? 'rgba(60,50,45,0.35)' : 'rgba(255,255,255,0.28)';
        for (let k = 0; k < 6; k++) {
          const ph = (t * 0.6 + k / 6) % 1;
          ctx.beginPath();
          ctx.arc(surface.cx + Math.sin(k * 2 + t) * surface.rx * 0.5, surface.cy - ph * 70, 6 + ph * 14, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // wooden spoon
      const sp = stirLast ? stirLast.p : { x: surface.cx + surface.rx * 0.35, y: surface.cy };
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#b7834f';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(sp.x, sp.y);
      ctx.lineTo(sp.x + 40, sp.y - 70);
      ctx.stroke();
      ctx.restore();
      // things flying into the pot
      for (const f of flying) {
        if (f.t < 0) continue;
        const e = Math.min(1, f.t);
        const x = f.x0 + (f.x1 - f.x0) * e;
        const y = f.y0 + (f.y1 - f.y0) * e - Math.sin(e * Math.PI) * 30;
        if (H.FRUITS[f.id]) drawFruit(ctx, f.id, x, y, f.r);
        else {
          ctx.fillStyle = f.id === 'gelierzucker' ? '#ffffff' : H.CHOCOLATES[f.id].color;
          if (f.id === 'gelierzucker') {
            ctx.beginPath();
            ctx.arc(x, y, f.r, 0, Math.PI * 2);
            ctx.fill();
          } else ctx.fillRect(x - 7, y - 4, 14, 8);
        }
      }
      drawThermo(ctx);
      if (isJam && temp >= 99.5 && total() > 0) {
        ctx.fillStyle = '#ffffff';
        ctx.font = `800 14px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.fillText(`⏱ ${H.num(Math.floor(boilMinutes * 10) / 10)} min`, 10, L.hobY + 16);
      }
    }

    /** Crunch: a wide pan with nuts that roast from pale to golden to burnt. */
    function renderPan(ctx, now) {
      const P = L.pot;
      const pw = P.w * 1.25;
      const top = P.bottom - P.h * 0.4;
      ctx.fillStyle = '#2d2d2d';
      rrect(ctx, P.cx + pw / 2 - 6, top + 4, view.w * 0.3, 10, 5); // handle
      ctx.fill();
      ctx.fillStyle = '#3a3a3a';
      ctx.beginPath();
      ctx.moveTo(P.cx - pw / 2, top);
      ctx.lineTo(P.cx - pw / 2 + 10, P.bottom);
      ctx.lineTo(P.cx + pw / 2 - 10, P.bottom);
      ctx.lineTo(P.cx + pw / 2, top);
      ctx.ellipse(P.cx, top, pw / 2, P.ry, 0, 0, Math.PI, false);
      ctx.fill();
      ctx.fillStyle = '#1f1f1f';
      ctx.beginPath();
      ctx.ellipse(P.cx, top, pw / 2 - 3, P.ry - 2, 0, 0, Math.PI * 2);
      ctx.fill();
      if (total() > 0) {
        const c = contentsColor();
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(P.cx, top + 2, pw / 2 - 8, P.ry - 5, 0, 0, Math.PI * 2);
        ctx.clip();
        const n = Math.min(70, Math.round(total() / 3));
        for (let k = 0; k < n; k++) {
          const a = k * 2.39996 + stirAngle * 0.5;
          const d = Math.sqrt((k + 0.5) / n);
          const id = order[k % order.length];
          const base = id === 'zucker' ? '#ffffff' : id === 'butter' ? '#f6dd7c' : H.CRUNCH_ITEMS[id].color;
          ctx.fillStyle = H.mix(base, c, Math.min(1, caramel * 0.9 + 0.1));
          ctx.save();
          ctx.translate(P.cx + Math.cos(a) * d * (pw / 2 - 12), top + 2 + Math.sin(a) * d * (P.ry - 7));
          ctx.rotate(a);
          ctx.fillRect(-3, -2, 6, 4);
          ctx.restore();
        }
        if (caramel > 0.2) {
          ctx.fillStyle = `rgba(255,255,255,${Math.min(0.35, caramel * 0.3)})`;
          ctx.beginPath();
          ctx.ellipse(P.cx - pw * 0.15, top - 2, pw * 0.15, 3, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
        if (caramel > 1.3 || (burnt > 0.3 && performance.now() - lastStir > 2500)) {
          const t = now / 1000;
          ctx.fillStyle = 'rgba(60,50,45,0.35)';
          for (let k = 0; k < 6; k++) {
            const ph = (t * 0.6 + k / 6) % 1;
            ctx.beginPath();
            ctx.arc(P.cx + Math.sin(k * 2 + t) * pw * 0.3, top - ph * 70, 6 + ph * 14, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      // wooden spatula
      const sp = stirLast ? stirLast.p : { x: P.cx + pw * 0.2, y: top };
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#b7834f';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(sp.x, sp.y);
      ctx.lineTo(sp.x + 40, sp.y - 70);
      ctx.stroke();
      ctx.restore();
      for (const f of flying) {
        if (f.t < 0) continue;
        const e = Math.min(1, f.t);
        const x = f.x0 + (f.x1 - f.x0) * e;
        const y = f.y0 + (f.y1 - f.y0) * e - Math.sin(e * Math.PI) * 30;
        ctx.fillStyle = f.id === 'zucker' ? '#ffffff' : f.id === 'butter' ? '#f6dd7c' : H.CRUNCH_ITEMS[f.id].color;
        ctx.fillRect(x - 3, y - 2, 6, 4);
      }
    }

    function frame(now) {
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;
      physics(dt, now);
      for (let i = flying.length - 1; i >= 0; i--) {
        flying[i].t += dt / 0.45;
        if (flying[i].t >= 1) flying.splice(i, 1);
      }
      setStatus(now);
      if (Math.random() < 0.1) update();
      render(now);
      raf = requestAnimationFrame(frame);
    }

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const p = canvasPoint(canvas, e);
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (p.y < L.shelfH) {
        const i = Math.floor((p.x - 6) / L.slot);
        if (i >= 0 && i < items.length) addItem(items[i]);
        return;
      }
      const P = L.pot;
      const cy = isCrunch ? P.bottom - P.h * 0.4 : isJam ? P.top : P.top - P.ry * 0.9;
      if (Math.abs(p.x - P.cx) < P.w * (isCrunch ? 0.75 : 0.6) && Math.abs(p.y - cy) < P.h * 0.9) {
        stirLast = { a: Math.atan2((p.y - cy) * 3, p.x - P.cx), p };
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!stirLast) return;
      const p = canvasPoint(canvas, e);
      const P = L.pot;
      const cy = isCrunch ? P.bottom - P.h * 0.4 : isJam ? P.top : P.top - P.ry * 0.9;
      const a = Math.atan2((p.y - cy) * 3, p.x - P.cx);
      let d = a - stirLast.a;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      if (Math.abs(d) > 0.05 && Math.abs(d) < 1.5 && total() > 0) {
        stirAngle += d;
        lastStir = performance.now();
      }
      stirLast = { a, p };
    });
    const endStir = () => { stirLast = null; };
    canvas.addEventListener('pointerup', endStir);
    canvas.addEventListener('pointercancel', endStir);

    down.addEventListener('click', () => {
      heat = Math.max(0, heat - 1);
      sound('tick');
      update();
    });
    up.addEventListener('click', () => {
      heat = Math.min(9, heat + 1);
      sound('tick');
      update();
    });
    undo.addEventListener('click', () => {
      const id = order.pop();
      if (!id) return;
      added[id] -= portion(id);
      if (added[id] <= 0) delete added[id];
      update();
    });

    update();
    raf = requestAnimationFrame(frame);
    return {
      collect: () => (isCrunch ? { added, caramel, burnt } : isJam ? { added, boilMinutes, burnt } : { added, melt, maxTemp, overheat }),
      check() {
        if (total() === 0) return isJam ? 'Der Topf ist noch leer.' : isCrunch ? 'Die Pfanne ist noch leer.' : 'Die Schüssel ist noch leer.';
        if (isCrunch && caramel < 0.3) return 'Der Crunch ist noch gar nicht geröstet.';
        if (isJam && boilMinutes <= 0) return 'Die Marmelade hat noch gar nicht gekocht.';
        if (!isJam && melt < 0.99) return 'Die Schokolade ist noch nicht ganz geschmolzen.';
        return null;
      },
      cleanup: () => cancelAnimationFrame(raf),
      resize() {
        view = fitCanvas(canvas);
        L = layout();
      },
    };
  }

  // ------------------------------------------------------ cakes and tortes
  function formShape() {
    const form = (steps.form && steps.form.form) || (recipe && recipe.form) || 'springform';
    return H.FORMS[form] ? H.FORMS[form].shape : 'kreis';
  }

  /** A painted layer over a shape (butter in a tin): coverage from sample points. */
  function makePainter(shape, color, brush = 0.22) {
    const path = shapePath(shape);
    const grid = [];
    for (let y = -1; y <= 1; y += 0.08) {
      for (let x = -1; x <= 1; x += 0.08) {
        if (hitCtx.isPointInPath(path, x, y) && hitCtx.isPointInPath(path, x * 1.1, y * 1.1)) grid.push({ x, y, on: false });
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const pctx = canvas.getContext('2d');
    pctx.setTransform(256 / 2.2, 0, 0, 256 / 2.2, 128, 128);
    pctx.fillStyle = color;
    let last = null;
    let covered = 0;
    return {
      get coverage() { return covered; },
      lift() { last = null; },
      paintAt(u) {
        const from = last || u;
        const n = Math.max(1, Math.ceil(Math.hypot(u.x - from.x, u.y - from.y) / 0.05));
        for (let i = 1; i <= n; i++) {
          const x = from.x + ((u.x - from.x) * i) / n;
          const y = from.y + ((u.y - from.y) * i) / n;
          pctx.beginPath();
          pctx.arc(x, y, brush, 0, Math.PI * 2);
          pctx.fill();
          for (const g of grid) if (!g.on && Math.hypot(g.x - x, g.y - y) < brush) g.on = true;
        }
        last = u;
        covered = grid.filter((g) => g.on).length / Math.max(1, grid.length);
      },
      draw(ctx, cx, cy, R, alpha) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(R, R);
        ctx.clip(path);
        ctx.globalAlpha = alpha;
        ctx.drawImage(canvas, -1.1, -1.1, 2.2, 2.2);
        ctx.restore();
      },
    };
  }

  /** A baking tin from above. */
  function drawTin(ctx, id, x, y, r) {
    const shape = H.FORMS[id].shape;
    const path = shapePath(shape);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(r, r);
    const g = ctx.createLinearGradient(-1, -1, 1, 1);
    g.addColorStop(0, '#eef2f5');
    g.addColorStop(0.5, '#a7b1b9');
    g.addColorStop(1, '#69737b');
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.save();
    ctx.translate(0.04, 0.07);
    ctx.fill(path);
    ctx.restore();
    ctx.fillStyle = g;
    ctx.fill(path);
    ctx.save();
    ctx.scale(0.86, 0.86);
    ctx.fillStyle = '#8d979f';
    ctx.fill(path);
    ctx.restore();
    if (id === 'gugelhupf') {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 0.03;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 0.36, Math.sin(a) * 0.36);
        ctx.lineTo(Math.cos(a) * 0.86, Math.sin(a) * 0.86);
        ctx.stroke();
      }
    }
    if (id === 'springform') {
      ctx.fillStyle = '#5d666d';
      ctx.fillRect(0.86, -0.12, 0.16, 0.24);
    }
    ctx.lineWidth = 0.03;
    ctx.strokeStyle = '#f4f7f9';
    ctx.stroke(path);
    ctx.restore();
  }

  function buildForm(body) {
    let form = null;
    let painter = null;
    let brushAt = null;
    const forms = Object.keys(H.FORMS);
    const bar = el('div', 'cutters form-bar');
    const buttons = new Map();
    for (const id of forms) {
      const b = el('button', 'cutter');
      b.type = 'button';
      const icon = el('canvas', 'cutter-icon');
      icon.width = 72;
      icon.height = 72;
      const ictx = icon.getContext('2d');
      drawTin(ictx, id, 36, 36, id === 'kastenform' ? 30 : 28);
      b.append(icon, el('span', 'cutter-name', H.FORMS[id].name.replace('form', '­form')));
      b.addEventListener('click', () => {
        form = id;
        painter = makePainter(H.FORMS[id].shape, '#f3d36b', 0.2);
        sound('tick');
        update();
      });
      buttons.set(id, b);
      bar.append(b);
    }
    const canvas = el('canvas', 'cut-canvas');
    const meter = el('div', 'stir-meter');
    const meterBar = el('span');
    const meterText = el('small', '', 'Eingefettet: 0 %');
    meter.append(meterBar, meterText);
    body.append(bar, canvas, meter);
    let view = fitCanvas(canvas);

    function R() {
      return Math.min(view.w * 0.42, view.h * (form === 'kastenform' ? 0.8 : 0.42));
    }

    function update() {
      for (const [id, b] of buttons) b.classList.toggle('picked', id === form);
      const c = painter ? painter.coverage : 0;
      meterBar.style.width = `${Math.round(c * 100)}%`;
      meterText.textContent = !form ? 'Erst eine Backform wählen' : c >= 0.9 ? 'Schön eingefettet ✓' : `Eingefettet: ${Math.round(c * 100)} % – mit dem Finger Butter verstreichen`;
      meter.classList.toggle('done', c >= 0.9);
      draw();
    }

    function draw() {
      const { ctx, w, h } = view;
      ctx.clearRect(0, 0, w, h);
      drawWorktop(ctx, w, h);
      if (!form) {
        ctx.fillStyle = 'rgba(59,36,22,0.7)';
        ctx.font = `700 15px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText('Welche Backform steht im Rezept?', w / 2, h / 2);
        return;
      }
      drawTin(ctx, form, w / 2, h / 2, R());
      painter.draw(ctx, w / 2, h / 2, R() * 0.86, 0.55);
      if (brushAt) {
        // a little piece of butter on a paper, used like a brush
        ctx.save();
        ctx.translate(brushAt.x, brushAt.y);
        ctx.rotate(-0.4);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-14, -26, 28, 22);
        ctx.fillStyle = '#f3d36b';
        rrect(ctx, -11, -10, 22, 12, 3);
        ctx.fill();
        ctx.restore();
      }
    }

    function paint(e) {
      if (!form) return;
      const p = canvasPoint(canvas, e);
      brushAt = p;
      const r = R() * 0.86;
      painter.paintAt({ x: (p.x - view.w / 2) / r, y: (p.y - view.h / 2) / r });
      if (Math.random() < 0.1) sound('tick');
      update();
    }
    let down = false;
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (!form) {
        toast('Erst oben eine Backform wählen.');
        return;
      }
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      down = true;
      painter.lift();
      paint(e);
    });
    canvas.addEventListener('pointermove', (e) => { if (down) paint(e); });
    const end = () => {
      down = false;
      brushAt = null;
      if (painter) painter.lift();
      draw();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    update();
    return {
      collect: () => ({ form, greased: painter ? painter.coverage : 0 }),
      check() {
        if (!form) return 'Noch keine Backform gewählt.';
        if (painter.coverage < 0.6) return 'Die Form ist noch nicht eingefettet.';
        return null;
      },
      resize() {
        view = fitCanvas(canvas);
        draw();
      },
    };
  }

  // ------------------------------------------------------------- layers
  function drawSponge(ctx, x, y, w, h, crust) {
    // a piece of sponge cake from the side
    ctx.fillStyle = '#f2d58c';
    rrect(ctx, x, y, w, h, Math.min(6, h / 3));
    ctx.fill();
    ctx.fillStyle = 'rgba(200,150,60,0.35)';
    for (let i = 0; i < Math.floor(w / 9); i++) ctx.fillRect(x + 4 + ((i * 37) % Math.max(1, w - 8)), y + 3 + ((i * 17) % Math.max(1, h - 6)), 2, 2);
    ctx.fillStyle = crust;
    ctx.fillRect(x, y, w, Math.min(4, h / 4));
  }

  function buildLayers(body) {
    const cuts = [];
    let knife = null; // { x0, y0, x, y }
    const canvas = el('canvas', 'cut-canvas');
    const info = el('div', 'bowl-chips');
    const undo = el('button', 'btn btn-ghost small-btn', '↩ Letzten Schnitt zurück');
    undo.type = 'button';
    body.append(canvas, info, undo);
    let view = fitCanvas(canvas);
    const crust = myLook().color;

    function cake() {
      const { w, h } = view;
      return { x: w * 0.12, y: h * 0.3, w: w * 0.76, h: h * 0.34 };
    }

    function update() {
      info.replaceChildren(el('span', 'chip', `${cuts.length} ${cuts.length === 1 ? 'Schnitt' : 'Schnitte'} → ${cuts.length + 1} ${cuts.length ? 'Böden' : 'Boden'}`));
      undo.disabled = cuts.length === 0;
      draw();
    }

    function draw() {
      const { ctx, w, h } = view;
      ctx.clearRect(0, 0, w, h);
      drawWorktop(ctx, w, h);
      const C = cake();
      // turntable
      ctx.fillStyle = '#d6dbe0';
      ctx.beginPath();
      ctx.ellipse(w / 2, C.y + C.h + 8, C.w * 0.6, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#9aa5ad';
      ctx.fillRect(w / 2 - 10, C.y + C.h + 14, 20, 26);
      // the sponge, split at the cuts
      const sorted = [...cuts].sort((a, b) => a - b);
      const edges = [0, ...sorted, 1];
      for (let i = 0; i < edges.length - 1; i++) {
        const top = C.y + edges[i] * C.h + (i ? 2 : 0);
        const bottom = C.y + edges[i + 1] * C.h - (i < edges.length - 2 ? 2 : 0);
        drawSponge(ctx, C.x, top, C.w, bottom - top, i === 0 ? crust : '#f6e2a8');
      }
      ctx.fillStyle = H.mix(crust, '#000000', 0.15);
      ctx.fillRect(C.x, C.y, 5, C.h);
      ctx.fillRect(C.x + C.w - 5, C.y, 5, C.h);
      if (knife) {
        ctx.save();
        ctx.fillStyle = '#e9eef2';
        ctx.strokeStyle = '#7d8890';
        ctx.lineWidth = 1;
        const kx = knife.x;
        const ky = knife.y;
        rrect(ctx, kx - 150, ky - 4, 150, 8, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#3b2416';
        rrect(ctx, kx, ky - 6, 46, 12, 5);
        ctx.fill();
        ctx.restore();
      }
    }

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      const p = canvasPoint(canvas, e);
      knife = { x0: p.x, y0: p.y, x: p.x, y: p.y };
      draw();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!knife) return;
      const p = canvasPoint(canvas, e);
      knife.x = p.x;
      knife.y = p.y;
      draw();
    });
    canvas.addEventListener('pointerup', () => {
      if (!knife) return;
      const C = cake();
      const k = knife;
      knife = null;
      const dx = Math.abs(k.x - k.x0);
      const dy = Math.abs(k.y - k.y0);
      if (dx < 12 && dy < 12) {
        // a tap on a cut takes it back
        const rel = (k.y - C.y) / C.h;
        const i = cuts.findIndex((c) => Math.abs(c - rel) * C.h < 10);
        if (i >= 0) {
          cuts.splice(i, 1);
          sound('tick');
        }
        update();
        return;
      }
      const y = (k.y + k.y0) / 2;
      const rel = (y - C.y) / C.h;
      if (dx < C.w * 0.55 || dy > 30 || rel < 0.05 || rel > 0.95) {
        toast('Quer über den ganzen Biskuit wischen.');
        update();
        return;
      }
      if (cuts.some((c) => Math.abs(c - rel) < 0.05)) {
        toast('Da ist schon ein Schnitt.');
        update();
        return;
      }
      cuts.push(Math.round(rel * 1000) / 1000);
      sound('cut');
      vibrate(15);
      update();
    });
    undo.addEventListener('click', () => {
      cuts.pop();
      update();
    });

    update();
    return {
      collect: () => ({ cuts }),
      check: () => (cuts.length === 0 ? 'Der Biskuit ist noch nicht geschnitten.' : null),
      resize() {
        view = fitCanvas(canvas);
        draw();
      },
    };
  }

  // -------------------------------------------------------------- cream
  function drawCreamCarton(ctx, w, h) {
    const B = h / 2;
    const bw = w * 0.56;
    const top = B - h * 0.72;
    ctx.fillStyle = '#e8eef5';
    ctx.beginPath();
    ctx.moveTo(-bw / 2, top);
    ctx.lineTo(0, top - h * 0.18);
    ctx.lineTo(bw / 2, top);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-bw / 2, top, bw, B - top);
    ctx.fillStyle = '#e0517f';
    ctx.fillRect(-bw / 2, top + (B - top) * 0.55, bw, (B - top) * 0.45);
    tag(ctx, 'Sahne', top + (B - top) * 0.3, bw * 0.86, '#e0517f', 10, 900);
    tag(ctx, '100 ml', top + (B - top) * 0.78, bw * 0.86, '#ffffff', 8, 800);
    shade(ctx, -bw / 2, top, bw, B - top);
  }

  function creamStage(st) {
    if (st < 0.25) return 'flüssig';
    if (st < 0.5) return 'schaumig';
    if (st < 0.85) return 'cremig';
    if (st <= 1.15) return 'steif ✓';
    if (st <= 1.25) return 'sehr fest – aufhören!';
    return 'Butter! 😱';
  }

  function buildCream(body) {
    let ml = 0;
    let vanille = 0;
    let stiff = 0;
    let mixing = false;
    let raf = 0;
    let lastT = performance.now();
    let spin = 0;
    const order = [];
    const canvas = el('canvas', 'stove-canvas');
    const controls = el('div', 'mix-controls cream-controls');
    const undo = el('button', 'scale-btn ghost', '↩');
    undo.type = 'button';
    undo.setAttribute('aria-label', 'Rückgängig');
    const mixer = el('button', 'scale-btn pour', 'Halten: Mixer an');
    mixer.type = 'button';
    controls.append(undo, mixer);
    const meter = el('div', 'stir-meter');
    const meterBar = el('span');
    const meterText = el('small', '', 'Sahne: flüssig');
    meter.append(meterBar, meterText);
    const chips = el('div', 'bowl-chips');
    body.append(canvas, controls, meter, chips);
    let view = fitCanvas(canvas);

    function L() {
      const { w, h } = view;
      const shelfH = Math.min(h * 0.25, 120);
      return { shelfH, slot: (w - 12) / 2, bowl: { cx: w / 2, rimY: h * 0.62, rx: Math.min(w * 0.38, 160), ry: Math.min(w * 0.38, 160) * 0.3, depth: Math.min(w * 0.38, 160) * 0.65 } };
    }

    function update() {
      chips.replaceChildren(...(ml ? [el('span', 'chip', `${ml} ml Sahne`)] : []), ...(vanille ? [el('span', 'chip', `${vanille} Päckchen Vanillezucker`)] : []));
      if (!ml && !vanille) chips.append(el('span', 'chip empty', 'Schüssel ist leer'));
      meterBar.style.width = `${Math.min(100, (stiff / 1.3) * 100)}%`;
      meterText.textContent = ml ? `Sahne: ${creamStage(stiff)}` : 'Erst Sahne in die Schüssel';
      meter.classList.toggle('done', stiff >= 0.85 && stiff <= 1.15);
      meter.classList.toggle('over', stiff > 1.15);
      undo.disabled = order.length === 0 || stiff > 0.2;
    }

    function add(id) {
      if (id === 'sahne') {
        if (ml > 0) stiff *= ml / (ml + 100); // fresh cream makes it runny again
        ml += 100;
      } else vanille += 1;
      order.push(id);
      sound('plop');
      vibrate(10);
      update();
    }

    function render(now) {
      const { ctx, w, h } = view;
      const G = L();
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#efe6d8';
      ctx.fillRect(0, 0, w, h * 0.72);
      ctx.fillStyle = '#5c3a22';
      ctx.fillRect(0, 0, w, G.shelfH);
      ctx.fillStyle = '#a5703f';
      ctx.fillRect(0, G.shelfH - 8, w, 8);
      const itemW = Math.min(G.slot * 0.6, G.shelfH * 0.9);
      ctx.save();
      ctx.translate(6 + G.slot * 0.5, (G.shelfH - 8) / 2 + 4);
      drawCreamCarton(ctx, itemW, G.shelfH - 16);
      ctx.restore();
      ctx.save();
      ctx.translate(6 + G.slot * 1.5, (G.shelfH - 8) / 2 + 4);
      drawPackage(ctx, 'vanille', itemW, G.shelfH - 16);
      ctx.restore();
      ctx.fillStyle = '#c99c6b';
      ctx.fillRect(0, h * 0.72, w, h * 0.28);
      const B = G.bowl;
      // bowl
      const g = ctx.createLinearGradient(B.cx - B.rx, 0, B.cx + B.rx, 0);
      g.addColorStop(0, '#9ba6ae');
      g.addColorStop(0.35, '#f2f5f7');
      g.addColorStop(1, '#7d8890');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(B.cx - B.rx, B.rimY);
      ctx.quadraticCurveTo(B.cx - B.rx * 0.9, B.rimY + B.depth, B.cx, B.rimY + B.depth);
      ctx.quadraticCurveTo(B.cx + B.rx * 0.9, B.rimY + B.depth, B.cx + B.rx, B.rimY);
      ctx.ellipse(B.cx, B.rimY, B.rx, B.ry, 0, 0, Math.PI, false);
      ctx.fill();
      ctx.fillStyle = '#aab4bb';
      ctx.beginPath();
      ctx.ellipse(B.cx, B.rimY, B.rx * 0.95, B.ry * 0.9, 0, 0, Math.PI * 2);
      ctx.fill();
      if (ml > 0) {
        const f = Math.min(1, ml / 600);
        const sx = B.rx * (0.6 + 0.3 * f);
        const sy = B.ry * (0.55 + 0.3 * f);
        const cy = B.rimY + B.ry * 0.35 * (1 - f);
        const butter = stiff > 1.25;
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(B.cx, cy, sx, sy, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = butter ? '#efe0a0' : '#fdfcf6';
        ctx.fillRect(B.cx - sx, cy - sy, sx * 2, sy * 2);
        if (stiff < 0.25) {
          ctx.fillStyle = 'rgba(255,255,255,0.8)';
          ctx.beginPath();
          ctx.ellipse(B.cx - sx * 0.3, cy - sy * 0.3, sx * 0.25, sy * 0.15, -0.2, 0, Math.PI * 2);
          ctx.fill();
        } else if (stiff < 0.5) {
          ctx.strokeStyle = 'rgba(200,200,190,0.8)';
          for (let i = 0; i < 18; i++) {
            ctx.beginPath();
            ctx.arc(B.cx + Math.sin(i * 3.1) * sx * 0.8, cy + Math.cos(i * 1.7) * sy * 0.7, 2 + (i % 3), 0, Math.PI * 2);
            ctx.stroke();
          }
        } else if (!butter) {
          // soft waves, then stiff peaks
          ctx.fillStyle = 'rgba(225,222,210,0.9)';
          const peaks = stiff >= 0.85 ? 9 : 5;
          for (let i = 0; i < peaks; i++) {
            const px = B.cx + Math.sin(i * 2.3) * sx * 0.7;
            const py = cy + Math.cos(i * 1.9) * sy * 0.6;
            const ph = stiff >= 0.85 ? 10 : 5;
            ctx.beginPath();
            ctx.moveTo(px - 8, py + 3);
            ctx.quadraticCurveTo(px, py - ph * 2, px + 8, py + 3);
            ctx.fill();
          }
        } else {
          ctx.fillStyle = '#d9c26b';
          for (let i = 0; i < 14; i++) {
            ctx.beginPath();
            ctx.arc(B.cx + Math.sin(i * 2.9) * sx * 0.75, cy + Math.cos(i * 1.3) * sy * 0.65, 4 + (i % 4), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
      }
      ctx.strokeStyle = '#eef2f5';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(B.cx, B.rimY, B.rx, B.ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      // hand mixer: lowered and spinning while held
      const mx = B.cx + B.rx * 0.15;
      const low = mixing ? B.ry * 0.6 : -B.ry * 2.2;
      ctx.save();
      ctx.strokeStyle = '#c9ced3';
      ctx.lineWidth = 3;
      for (const off of [-10, 10]) {
        const sw = Math.sin(spin + off) * 5;
        ctx.beginPath();
        ctx.moveTo(mx + off, B.rimY + low - 60);
        ctx.lineTo(mx + off, B.rimY + low);
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(mx + off, B.rimY + low - 6, 6 + sw * 0.3, 10, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = '#f4f6f8';
      rrect(ctx, mx - 34, B.rimY + low - 100, 68, 42, 14);
      ctx.fill();
      ctx.fillStyle = '#e0517f';
      rrect(ctx, mx + 10, B.rimY + low - 130, 22, 40, 8);
      ctx.fill();
      ctx.restore();
      if (mixing && ml > 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        for (let i = 0; i < 4; i++) ctx.fillRect(mx - 25 + Math.random() * 50, B.rimY - 5 - Math.random() * 20, 2, 2);
      }
    }

    function frame(now) {
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;
      if (mixing) {
        spin += dt * 40;
        if (ml > 0) {
          const before = stiff;
          stiff = Math.min(2, stiff + dt * 0.11 * Math.sqrt(300 / Math.max(ml, 100)));
          if (before < 0.85 && stiff >= 0.85) {
            sound('ding');
            vibrate(30);
          }
          if (before <= 1.25 && stiff > 1.25) {
            sound('aww');
            vibrate([60, 40, 60]);
          }
        }
        if (Math.random() < dt * 6) update();
      }
      render(now);
      raf = requestAnimationFrame(frame);
    }

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const p = canvasPoint(canvas, e);
      const G = L();
      if (p.y < G.shelfH) add(p.x < view.w / 2 ? 'sahne' : 'vanille');
    });
    mixer.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { mixer.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (!ml) toast('Erst Sahne in die Schüssel tippen.');
      mixing = true;
      mixer.classList.add('holding');
      sound('whoosh');
    });
    const stop = () => {
      mixing = false;
      mixer.classList.remove('holding');
      update();
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) mixer.addEventListener(type, stop);
    mixer.addEventListener('contextmenu', (e) => e.preventDefault());
    undo.addEventListener('click', () => {
      const id = order.pop();
      if (id === 'sahne') ml = Math.max(0, ml - 100);
      else if (id === 'vanille') vanille = Math.max(0, vanille - 1);
      update();
    });

    update();
    raf = requestAnimationFrame(frame);
    return {
      collect: () => ({ ml, vanille, stiff }),
      check() {
        if (!ml) return 'Noch keine Sahne in der Schüssel.';
        if (stiff < 0.85) return 'Die Sahne ist noch nicht steif.';
        return null;
      },
      cleanup: () => cancelAnimationFrame(raf),
      resize() {
        view = fitCanvas(canvas);
      },
    };
  }

  // --------------------------------------------------- stacking the torte
  const LAYER_HEIGHT = { boden: 26, sahne: 12, crunch: 8, erdbeere: 11, kirsche: 11, himbeere: 11, marmelade: 6 };

  /** Side view of a torte, stacked from the bottom; returns the height used. */
  function drawTorteSlice(ctx, layers, cx, bottom, width, maxH, look, scale = null) {
    const total = layers.reduce((sum, id) => sum + LAYER_HEIGHT[id], 0);
    const k = scale || Math.min(2, maxH / Math.max(1, total));
    let y = bottom;
    const cream = (look && look.cream) ? look.cream.color : '#fdfcf7';
    const crust = (look && look.color) || '#d9a24f';
    const crunchColor = (look && look.crunchColor) || '#c98a3a';
    layers.forEach((id, i) => {
      const hgt = LAYER_HEIGHT[id] * k;
      const x = cx - width / 2;
      y -= hgt;
      if (id === 'boden') drawSponge(ctx, x, y, width, hgt, i === layers.lastIndexOf('boden') ? crust : '#f6e2a8');
      else if (id === 'sahne') {
        ctx.fillStyle = cream;
        rrect(ctx, x, y, width, hgt, 3);
        ctx.fill();
        ctx.strokeStyle = 'rgba(200,195,180,0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let px = 0; px <= width; px += 8) ctx.lineTo(x + px, y + 1 + Math.sin(px * 0.4) * 1.5);
        ctx.stroke();
      } else if (id === 'marmelade') {
        ctx.fillStyle = (look && look.jamColor) || '#c2185b';
        ctx.fillRect(x, y, width, hgt);
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.fillRect(x + 4, y + 1, width - 8, Math.max(1, hgt * 0.25));
      } else if (id === 'crunch') {
        ctx.fillStyle = H.mix(crunchColor, '#ffffff', 0.15);
        ctx.fillRect(x, y, width, hgt);
        ctx.fillStyle = H.mix(crunchColor, '#000000', 0.2);
        for (let px = 2; px < width - 2; px += 5) ctx.fillRect(x + px, y + ((px * 7) % Math.max(1, hgt - 2)), 3, 2);
      } else {
        ctx.fillStyle = cream;
        ctx.fillRect(x, y, width, hgt);
        const color = H.FRUITS[id] ? H.FRUITS[id].color : '#d7263d';
        for (let px = 6; px < width - 4; px += 14) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.ellipse(x + px, y + hgt / 2, 5, Math.max(2, hgt / 2 - 1), 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
    return bottom - y;
  }

  function buildAssemble(body) {
    const layers = [];
    let dropAt = 0;
    let raf = 0;
    const bodens = steps.layers ? steps.layers.cuts.length + 1 : 1;
    const look = myLook();
    const canvas = el('canvas', 'cut-canvas');
    const pad = el('div', 'layer-pad');
    const buttons = new Map();
    for (const [id, item] of Object.entries(H.LAYER_ITEMS)) {
      const b = el('button', 'layer-btn');
      b.type = 'button';
      b.dataset.id = id;
      b.append(el('span', `layer-swatch layer-${id}`), el('span', 'layer-name', item.name));
      b.addEventListener('click', () => {
        layers.push(id);
        dropAt = performance.now();
        sound(id === 'boden' ? 'plop' : 'drop');
        vibrate(10);
        update();
      });
      buttons.set(id, b);
      pad.append(b);
    }
    const undo = el('button', 'btn btn-ghost small-btn', '↩ Oberste Schicht wieder runter');
    undo.type = 'button';
    body.append(canvas, pad, undo);
    let view = fitCanvas(canvas);

    function update() {
      const used = layers.filter((id) => id === 'boden').length;
      for (const [id, b] of buttons) {
        let disabled = false;
        if (id === 'boden') {
          disabled = used >= bodens;
          b.querySelector('.layer-name').textContent = `Boden (${bodens - used})`;
        }
        if (id === 'sahne') disabled = !steps.cream || !steps.cream.ml;
        if (id === 'crunch') disabled = !steps.crunch || !Object.keys(steps.crunch.added).length;
        if (id === 'marmelade') disabled = !steps.jam || !Object.keys(steps.jam.added).length;
        b.disabled = disabled;
      }
      undo.disabled = layers.length === 0;
      cancelAnimationFrame(raf);
      animate();
    }

    function animate() {
      const { ctx, w, h } = view;
      ctx.clearRect(0, 0, w, h);
      drawWorktop(ctx, w, h);
      // cake stand
      const standY = h * 0.86;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(w / 2, standY, w * 0.42, 12, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#d9dee2';
      ctx.fillRect(w / 2 - 12, standY + 6, 24, h - standY);
      const t = Math.min(1, (performance.now() - dropAt) / 260);
      const shown = t < 1 ? layers.slice(0, -1) : layers;
      // one scale for the whole stack, so a falling layer has its final size
      const total = Math.max(80, layers.reduce((sum, id) => sum + LAYER_HEIGHT[id], 0));
      const k = Math.min(2.2, (standY - 60) / total);
      const used = drawTorteSlice(ctx, shown, w / 2, standY - 4, w * 0.62, standY - 40, look, k);
      if (t < 1 && layers.length) {
        const last = layers[layers.length - 1];
        const y = (standY - 4 - used) - (1 - t) * 120;
        drawTorteSlice(ctx, [last], w / 2, y, w * 0.62, 200, look, k);
        raf = requestAnimationFrame(animate);
      }
      if (!layers.length) {
        ctx.fillStyle = 'rgba(59,36,22,0.7)';
        ctx.font = `700 14px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.fillText('Von unten nach oben schichten', w / 2, h * 0.45);
      }
    }

    undo.addEventListener('click', () => {
      layers.pop();
      dropAt = 0;
      update();
    });

    update();
    return {
      collect: () => ({ layers }),
      check: () => (layers.length === 0 ? 'Noch nichts geschichtet.' : null),
      cleanup: () => cancelAnimationFrame(raf),
      resize() {
        view = fitCanvas(canvas);
        update();
      },
    };
  }

  // ------------------------------------------------- decorating the torte
  function drawTopping(ctx, id, x, y, s, seed = 0) {
    ctx.save();
    switch (id) {
      case 'tupfen': {
        const g = ctx.createRadialGradient(x - s * 0.2, y - s * 0.2, s * 0.1, x, y, s);
        g.addColorStop(0, '#ffffff');
        g.addColorStop(1, '#e9e4d6');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, s * 0.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(190,180,160,0.8)';
        ctx.lineWidth = Math.max(1, s * 0.08);
        ctx.beginPath();
        for (let a = 0; a < Math.PI * 5; a += 0.3) ctx.lineTo(x + Math.cos(a) * s * 0.7 * (1 - a / (Math.PI * 6)), y + Math.sin(a) * s * 0.7 * (1 - a / (Math.PI * 6)));
        ctx.stroke();
        break;
      }
      case 'erdbeere':
      case 'himbeere':
        drawFruit(ctx, id, x, y, s * 0.55);
        break;
      case 'kirsche': {
        const g = ctx.createRadialGradient(x - s * 0.15, y - s * 0.15, s * 0.05, x, y, s * 0.45);
        g.addColorStop(0, '#d8506b');
        g.addColorStop(1, '#7b1026');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, s * 0.42, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#3f6b2a';
        ctx.lineWidth = Math.max(1, s * 0.08);
        ctx.beginPath();
        ctx.moveTo(x, y - s * 0.35);
        ctx.quadraticCurveTo(x + s * 0.2, y - s * 0.9, x + s * 0.5, y - s * 1);
        ctx.stroke();
        break;
      }
      case 'mandel': {
        const rng = seeded(seed * 31 + 3);
        for (let i = 0; i < 7; i++) {
          ctx.save();
          ctx.translate(x + (rng() - 0.5) * s * 1.1, y + (rng() - 0.5) * s * 1.1);
          ctx.rotate(rng() * Math.PI);
          ctx.fillStyle = i % 2 ? '#f1d7ae' : '#e6c08a';
          ctx.strokeStyle = '#b98a52';
          ctx.lineWidth = Math.max(0.6, s * 0.04);
          ctx.beginPath();
          ctx.ellipse(0, 0, s * 0.3, s * 0.16, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
        break;
      }
      case 'raspel':
      case 'krokant': {
        const rng = seeded(seed * 31 + (id === 'raspel' ? 1 : 2));
        for (let i = 0; i < 9; i++) {
          ctx.fillStyle = id === 'raspel' ? (i % 2 ? '#3b1f12' : '#5b341f') : (i % 2 ? '#c98a3a' : '#e0a95a');
          ctx.save();
          ctx.translate(x + (rng() - 0.5) * s * 1.2, y + (rng() - 0.5) * s * 1.2);
          ctx.rotate(rng() * Math.PI);
          ctx.fillRect(-s * 0.18, -s * 0.06, s * 0.36, s * 0.12);
          ctx.restore();
        }
        break;
      }
      case 'minze':
        ctx.fillStyle = '#3fae6a';
        ctx.beginPath();
        ctx.ellipse(x, y, s * 0.5, s * 0.25, 0.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#2b7a4a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - s * 0.35, y - s * 0.2);
        ctx.lineTo(x + s * 0.35, y + s * 0.2);
        ctx.stroke();
        break;
      default:
        break;
    }
    ctx.restore();
  }

  /** Where toppings sit when only their numbers are known (plate, comparison). */
  function toppingLayout(items) {
    const spots = [];
    const tupfen = items.tupfen || 0;
    const fruitId = ['erdbeere', 'kirsche', 'himbeere'].find((f) => items[f]);
    for (let i = 0; i < tupfen; i++) {
      const a = -Math.PI / 2 + (i / tupfen) * Math.PI * 2;
      spots.push({ id: 'tupfen', x: Math.cos(a) * 0.76, y: Math.sin(a) * 0.76 });
    }
    if (fruitId) {
      const n = items[fruitId];
      const ring = n <= tupfen ? 0.76 : 0.52;
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
        spots.push({ id: fruitId, x: Math.cos(a) * ring, y: Math.sin(a) * ring - (ring === 0.76 ? 0.05 : 0) });
      }
    }
    const centre = [];
    for (const id of ['raspel', 'krokant', 'minze']) for (let i = 0; i < (items[id] || 0); i++) centre.push(id);
    centre.forEach((id, i) => {
      const a = (i / Math.max(1, centre.length)) * Math.PI * 2 + 0.3;
      const d = centre.length === 1 ? 0 : id === 'minze' ? 0.5 : 0.28;
      spots.push({ id, x: Math.cos(a) * d, y: Math.sin(a) * d });
    });
    return spots;
  }

  /** A torte from above, with an optional explicit list of placed toppings. */
  function drawTorte(ctx, look, x, y, r, seed = 0, placed = null) {
    const cream = look.cream || { color: '#fdfcf7', texture: 'smooth' };
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.ellipse(x, y + r * 0.12, r, r * 0.95, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = H.mix(cream.color, '#000000', 0.12);
    ctx.beginPath();
    ctx.arc(x, y + r * 0.06, r, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, H.mix(cream.color, '#e8dcc2', 0.45));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(170,150,120,0.55)';
    ctx.lineWidth = Math.max(1.5, r * 0.012);
    ctx.stroke();
    if (cream.texture === 'runny') {
      ctx.fillStyle = 'rgba(250,250,240,0.8)';
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2;
        ctx.beginPath();
        ctx.ellipse(x + Math.cos(a) * r * 1.02, y + Math.sin(a) * r * 1.02 + 4, r * 0.08, r * 0.14, a, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (cream.texture === 'lumpy') {
      ctx.fillStyle = 'rgba(210,190,110,0.6)';
      for (let i = 0; i < 12; i++) {
        ctx.beginPath();
        ctx.arc(x + Math.sin(i * 2.7) * r * 0.7, y + Math.cos(i * 1.9) * r * 0.7, r * 0.06, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const items = placed || toppingLayout(look.toppings || {});
    const s = r * 0.17;
    for (const [i, t] of items.entries()) {
      if (t.id === 'tupfen') drawTopping(ctx, t.id, x + t.x * r, y + t.y * r, s, seed + i);
    }
    for (const [i, t] of items.entries()) {
      if (t.id !== 'tupfen') drawTopping(ctx, t.id, x + t.x * r, y + t.y * r, s, seed + i);
    }
    ctx.restore();
  }

  function buildTop(body) {
    const placed = []; // { id, x, y } in units of the torte radius
    const onSide = []; // { id, x, y } 0..1 across the front of the side
    let view3 = 'top';
    let selected = 'tupfen';
    const look = myLook();
    const switcher = el('div', 'mode-switch view-switch');
    const topBtn = el('button', '', '⬇️ Oben');
    topBtn.type = 'button';
    const sideBtn = el('button', '', '↔️ Rand');
    sideBtn.type = 'button';
    switcher.append(topBtn, sideBtn);
    topBtn.addEventListener('click', () => { view3 = 'top'; update(); });
    sideBtn.addEventListener('click', () => { view3 = 'side'; update(); });
    const canvas = el('canvas', 'cut-canvas');
    const bar = el('div', 'cutters topping-bar');
    const buttons = new Map();
    for (const [id, t] of Object.entries(H.TOPPINGS)) {
      const b = el('button', 'cutter');
      b.type = 'button';
      const icon = el('canvas', 'cutter-icon');
      icon.width = 72;
      icon.height = 72;
      const ictx = icon.getContext('2d');
      drawTopping(ictx, id, 36, 38, 34, 3);
      b.append(icon, el('span', 'cutter-name', t.many.replace('Häufchen ', '').replace('Mandelblättchen', 'Mandeln').replace('Schokoraspel', 'Raspel').replace('Sahnetupfen', 'Tupfen').replace('Minzblätter', 'Minze')));
      b.addEventListener('click', () => {
        selected = id;
        update();
      });
      buttons.set(id, b);
      bar.append(b);
    }
    const counts = el('div', 'bowl-chips');
    body.append(switcher, bar, canvas, counts);
    let view = fitCanvas(canvas);

    function geo() {
      const { w, h } = view;
      return { cx: w / 2, cy: h / 2, r: Math.min(w * 0.44, h * 0.44) };
    }

    function tallyOf(list) {
      const tally = {};
      for (const p of list) tally[p.id] = (tally[p.id] || 0) + 1;
      return tally;
    }

    function update() {
      topBtn.setAttribute('aria-pressed', String(view3 === 'top'));
      sideBtn.setAttribute('aria-pressed', String(view3 === 'side'));
      for (const [id, b] of buttons) b.classList.toggle('picked', id === selected);
      const chip = (prefix) => ([id, n]) => el('span', 'chip', `${prefix}${n} × ${n === 1 ? H.TOPPINGS[id].one : H.TOPPINGS[id].many}`);
      counts.replaceChildren(...Object.entries(tallyOf(placed)).map(chip('oben: ')), ...Object.entries(tallyOf(onSide)).map(chip('Rand: ')));
      if (!placed.length && !onSide.length) counts.append(el('span', 'chip empty', 'Noch nichts auf der Torte'));
      draw();
    }

    function draw() {
      const { ctx, w, h } = view;
      ctx.clearRect(0, 0, w, h);
      drawWorktop(ctx, w, h);
      if (view3 === 'side') {
        drawSideView(ctx, look, sideGeo(w, h, true), onSide, 'torte');
        return;
      }
      const G = geo();
      drawPlateBase(ctx, G.cx, G.cy, G.r * 1.12);
      drawTorte(ctx, look, G.cx, G.cy, G.r, 0, placed);
    }

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const p = canvasPoint(canvas, e);
      if (view3 === 'side') {
        const S = sideGeo(view.w, view.h, true);
        const u = { x: (p.x - S.x) / S.w, y: (p.y - S.y) / S.h };
        const hit = onSide.findIndex((t) => Math.hypot((t.x - u.x) * S.w, (t.y - u.y) * S.h) < S.h * 0.12);
        if (hit >= 0) {
          onSide.splice(hit, 1);
          sound('tick');
          update();
          return;
        }
        if (u.x < 0.02 || u.x > 0.98 || u.y < 0.05 || u.y > 1) {
          toast('Das ist nicht am Rand der Torte.');
          return;
        }
        onSide.push({ id: selected, x: u.x, y: u.y });
        sound('plop');
        vibrate(8);
        update();
        return;
      }
      const G = geo();
      const u = { x: (p.x - G.cx) / G.r, y: (p.y - G.cy) / G.r };
      const hit = placed.findIndex((t) => Math.hypot(t.x - u.x, t.y - u.y) < 0.09);
      if (hit >= 0) {
        placed.splice(hit, 1);
        sound('tick');
        update();
        return;
      }
      if (Math.hypot(u.x, u.y) > 0.92) {
        toast('Das ist neben der Torte.');
        return;
      }
      placed.push({ id: selected, x: u.x, y: u.y });
      sound('plop');
      vibrate(8);
      update();
    });

    update();
    return {
      collect: () => ({ items: tallyOf(placed), side: tallyOf(onSide) }),
      check() {
        if (placed.length === 0) return 'Die Torte ist noch ganz nackt.';
        if (recipe && recipe.side && onSide.length === 0) return 'Der Rand ist noch nicht verziert.';
        return null;
      },
      resize() {
        view = fitCanvas(canvas);
        draw();
      },
    };
  }

  // --------------------------------------------- the side of cakes and tortes
  /** Geometry of the front view used for decorating the side. */
  function sideGeo(w, h, torte) {
    const sw = w * 0.8;
    const sh = Math.min(h * (torte ? 0.42 : 0.34), sw * 0.55);
    return { x: (w - sw) / 2, y: h * 0.5 - sh / 2, w: sw, h: sh };
  }

  /** Front view of a cake or torte with things stuck to its side (positions 0..1). */
  function drawSideView(ctx, look, G, items, kind) {
    const torte = kind === 'torte';
    // plate
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(G.x + G.w / 2, G.y + G.h + 6, G.w * 0.62, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#7fa7d6';
    ctx.lineWidth = 2;
    ctx.stroke();
    const body = torte ? (look.cream ? look.cream.color : '#fdfcf7') : look.color;
    const g = ctx.createLinearGradient(G.x, 0, G.x + G.w, 0);
    g.addColorStop(0, H.mix(body, '#000000', 0.18));
    g.addColorStop(0.35, H.mix(body, '#ffffff', 0.15));
    g.addColorStop(1, H.mix(body, '#000000', 0.22));
    ctx.fillStyle = g;
    rrect(ctx, G.x, G.y, G.w, G.h, torte ? 10 : 14);
    ctx.fill();
    // top rim seen from the front
    ctx.fillStyle = torte ? '#ffffff' : (look.glaze ? look.glaze.color : H.mix(body, '#ffffff', 0.1));
    ctx.beginPath();
    ctx.ellipse(G.x + G.w / 2, G.y + 2, G.w / 2 - 2, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    if (!torte && look.glaze) {
      // the glaze runs down the side a little
      ctx.fillStyle = look.glaze.color;
      ctx.globalAlpha = look.glaze.opacity;
      for (let i = 0; i < 9; i++) {
        const dx = G.x + 10 + (i / 8) * (G.w - 20);
        const len = G.h * (0.12 + ((i * 37) % 10) / 30);
        rrect(ctx, dx - 6, G.y, 12, len, 6);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    for (const [i, t] of items.entries()) {
      const x = G.x + t.x * G.w;
      const y = G.y + t.y * G.h;
      if (torte) drawTopping(ctx, t.id, x, y, G.h * 0.16, i + 7);
      else drawSprinkle(ctx, t.id, x, y, G.h * 0.09, t.a || 0, t.c || 0);
    }
  }

  /** Spread a set of counts along the visible front of the side (0..1 positions). */
  function sideLayout(counts) {
    // every kind spread over the whole width; rosettes along the bottom
    const out = [];
    let k = 0;
    for (const [id, n] of Object.entries(counts || {})) {
      for (let i = 0; i < n; i++, k++) {
        out.push({
          id,
          x: 0.06 + ((i + 0.5) / n) * 0.88,
          y: id === 'tupfen' ? 0.88 : 0.3 + ((k * 37) % 10) / 22,
          a: k * 1.7,
          c: ((k * 53) % 10) / 10,
        });
      }
    }
    return out;
  }

  /** A cake or torte seen slightly from above, so the side shows too. */
  function drawBig3D(ctx, look, shape, x, y, r, seed = 0) {
    const torte = look.kind === 'torte';
    const sq = 0.55;
    const sideH = r * (torte ? 0.5 : 0.36);
    const path = shapePath(shape);
    const xmax = shape === 'kasten' ? 1 : shape === 'kreis' ? 0.92 : 0.95;
    const body = torte ? (look.cream ? look.cream.color : '#fdfcf7') : look.color;
    ctx.save();
    ctx.translate(x, y - sideH / 2);
    // shadow and bottom
    ctx.save();
    ctx.translate(0, sideH + r * 0.06);
    ctx.scale(r * 1.04, r * sq * 1.04);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fill(path);
    ctx.restore();
    ctx.save();
    ctx.translate(0, sideH);
    ctx.scale(r, r * sq);
    ctx.fillStyle = H.mix(body, '#000000', torte ? 0.12 : 0.22);
    ctx.fill(path);
    ctx.restore();
    const g = ctx.createLinearGradient(-r, 0, r, 0);
    g.addColorStop(0, H.mix(body, '#000000', torte ? 0.1 : 0.2));
    g.addColorStop(0.4, H.mix(body, '#ffffff', 0.1));
    g.addColorStop(1, H.mix(body, '#000000', torte ? 0.14 : 0.25));
    ctx.fillStyle = g;
    ctx.fillRect(-r * xmax, 0, r * xmax * 2, sideH);
    // the top, squashed
    ctx.save();
    ctx.scale(1, sq);
    if (torte) drawTorte(ctx, look, 0, 0, r, seed);
    else drawCookie(ctx, { ...look, mm: 0.2 }, shape, 0, 0, r, seed);
    if (look.stuck) {
      ctx.strokeStyle = 'rgba(40,20,10,0.6)';
      ctx.lineWidth = Math.max(1.5, r * 0.03);
      ctx.beginPath();
      ctx.moveTo(-r * 0.6, -r * 0.1);
      ctx.lineTo(-r * 0.2, r * 0.05);
      ctx.lineTo(r * 0.1, -r * 0.15);
      ctx.lineTo(r * 0.5, r * 0.1);
      ctx.stroke();
    }
    ctx.restore();
    // The visible side starts at the front edge of the top.
    const front = (px) => sq * r * (shape === 'kasten' ? 0.5 : xmax * Math.sqrt(Math.max(0, 1 - (px / (r * xmax)) ** 2)));
    if (!torte && look.glaze) {
      ctx.fillStyle = look.glaze.color;
      ctx.globalAlpha = look.glaze.opacity;
      for (let i = 0; i < 10; i++) {
        const dx = -r * xmax * 0.85 + (i / 9) * r * xmax * 1.7;
        const fy = front(dx);
        rrect(ctx, dx - r * 0.04, fy - r * 0.04, r * 0.08, r * 0.04 + sideH * (0.2 + ((i * 37) % 10) / 30), r * 0.04);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    const sideItems = torte ? sideLayout(look.side) : sideLayout(Object.fromEntries((look.sideSprinkles || []).map((k) => [k, 9])));
    for (const [i, t] of sideItems.entries()) {
      const px = -r * xmax * 0.9 + t.x * r * xmax * 1.8;
      const py = front(px) + (0.12 + t.y * 0.76) * sideH;
      if (torte) drawTopping(ctx, t.id, px, py, sideH * 0.24, seed + i);
      else drawSprinkle(ctx, t.id, px, py, sideH * 0.12, t.a, t.c);
    }
    ctx.restore();
  }

  /** German school grade from a percentage. */
  function schoolGrade(total) {
    const table = [[95, '1+'], [90, '1'], [85, '1−'], [80, '2+'], [75, '2'], [70, '2−'], [65, '3+'], [60, '3'], [55, '3−'], [50, '4+'], [45, '4'], [40, '4−'], [25, '5'], [0, '6']];
    return table.find(([min]) => total >= min)[1];
  }

  /** Cookie, cake or torte – whatever the look describes. */
  function drawBake(ctx, look, shape, x, y, r, seed = 0) {
    if (look.kind === 'torte' || look.kind === 'cake') {
      drawBig3D(ctx, look, shape, x, y, r, seed);
      return;
    }
    drawCookie(ctx, look, shape, x, y, r, seed);
    if (look.stuck) {
      // stuck in the tin: torn and cracked
      ctx.save();
      ctx.strokeStyle = 'rgba(40,20,10,0.6)';
      ctx.lineWidth = Math.max(1.5, r * 0.03);
      ctx.beginPath();
      ctx.moveTo(x - r * 0.6, y - r * 0.1);
      ctx.lineTo(x - r * 0.2, y + r * 0.05);
      ctx.lineTo(x + r * 0.1, y - r * 0.15);
      ctx.lineTo(x + r * 0.5, y + r * 0.1);
      ctx.stroke();
      ctx.fillStyle = 'rgba(30,15,8,0.35)';
      ctx.beginPath();
      ctx.arc(x + r * 0.45, y - r * 0.4, r * 0.18, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- sprinkles
  // First the player brushes the icing onto one big cookie (the others follow by
  // themselves), then shakes the sprinkle jars over it.
  function buildSprinkle(body) {
    const chosen = [];
    let selected = null;
    const glaze = myLook({ sprinkle: { sprinkles: [] } }).glaze;
    const spreadWord = recipe && recipe.jam ? 'die Marmelade' : recipe && recipe.choc ? 'die Schokolade' : 'den Guss';
    let phase = glaze ? 'glaze' : 'sprinkle'; // glaze | others | sprinkle
    const bigShape = cookieList[0] || 'kreis';
    const others = cookieList.slice(1);
    const bigPath = shapePath(bigShape);

    // icing: sample points inside the big cookie tell how much is covered
    const grid = [];
    for (let y = -1; y <= 1; y += 0.08) {
      for (let x = -1; x <= 1; x += 0.08) {
        if (hitCtx.isPointInPath(bigPath, x, y) && hitCtx.isPointInPath(bigPath, x * 1.15, y * 1.15)) grid.push({ x, y, on: false });
      }
    }
    let covered = 0;
    const BRUSH = 0.2;
    const paint = document.createElement('canvas'); // the painted icing, unit square [-1.1, 1.1]
    paint.width = 256;
    paint.height = 256;
    const pctx = paint.getContext('2d');
    pctx.setTransform(256 / 2.2, 0, 0, 256 / 2.2, 128, 128);
    pctx.fillStyle = glaze ? glaze.color : '#ffffff';
    let brushAt = null;
    let lastPaint = null;
    let glazedOthers = 0;
    let othersTimer = null;

    // sprinkles on the big cookie, and on the side of a cake
    const bigSprinkles = [];
    const sideSprinkles = [];
    const sideChosen = [];
    const isCake = !!(recipe && recipe.kind === 'cake');
    let view3 = 'top';
    const falling = [];
    let shaker = null;
    let shakeAcc = 0;

    let raf = 0;
    let lastT = performance.now();

    const canvas = el('canvas', 'decorate-canvas');
    const meter = el('div', 'stir-meter');
    const meterBar = el('span');
    const meterText = el('small', '', 'Glasur: 0 %');
    meter.append(meterBar, meterText);
    const jarsEl = el('div', 'sprinkle-jars');
    const buttons = new Map();
    for (const [id, s] of Object.entries(H.SPRINKLES)) {
      const b = el('button', 'sprinkle-jar');
      b.type = 'button';
      const icon = el('canvas', 'sprinkle-icon');
      icon.width = 80;
      icon.height = 80;
      const ictx = icon.getContext('2d');
      ictx.fillStyle = id === 'puder' ? '#b98552' : '#e8d2b0'; // white dust needs a darker cookie
      ictx.beginPath();
      ictx.arc(40, 40, 36, 0, Math.PI * 2);
      ictx.fill();
      for (const spot of sprinkleLayout('kreis', [id])) drawSprinkle(ictx, id, 40 + spot.x * 38, 40 + spot.y * 38, 13, spot.a, spot.c);
      b.append(icon, el('span', 'sprinkle-name', s.label || s.name));
      b.addEventListener('click', () => {
        selected = id;
        sound('tick');
        update();
      });
      buttons.set(id, b);
      jarsEl.append(b);
    }
    const hint = el('p', 'decorate-hint');
    const switcher = el('div', 'mode-switch view-switch');
    const topBtn = el('button', '', '⬇️ Oben');
    topBtn.type = 'button';
    const sideBtn = el('button', '', '↔️ Rand');
    sideBtn.type = 'button';
    switcher.append(topBtn, sideBtn);
    topBtn.addEventListener('click', () => { view3 = 'top'; update(); });
    sideBtn.addEventListener('click', () => { view3 = 'side'; update(); });
    body.append(switcher, canvas, meter, hint, jarsEl);
    switcher.hidden = !isCake || phase !== 'sprinkle';
    meter.hidden = phase !== 'glaze';
    jarsEl.hidden = phase !== 'sprinkle';
    let view = fitCanvas(canvas);

    function layout() {
      const { w, h } = view;
      const R = Math.min(w * 0.3, h * 0.3);
      const stripTop = h * 0.76;
      const small = trayLayout(Math.max(1, others.length), w - 20, h - stripTop - 6).map((s) => ({ ...s, x: s.x + 10, y: s.y + stripTop }));
      return { cx: w / 2, cy: h * 0.4, R, stripTop, small };
    }
    let L = layout();

    function update() {
      for (const [id, b] of buttons) {
        b.classList.toggle('picked', id === selected);
        b.classList.toggle('used', chosen.includes(id));
      }
      meter.hidden = phase !== 'glaze';
      jarsEl.hidden = phase !== 'sprinkle';
      switcher.hidden = !isCake || phase !== 'sprinkle';
      topBtn.setAttribute('aria-pressed', String(view3 === 'top'));
      sideBtn.setAttribute('aria-pressed', String(view3 === 'side'));
      for (const [id, b] of buttons) b.classList.toggle('used', chosen.includes(id) || sideChosen.includes(id));
      meterBar.style.width = `${Math.round(covered * 100)}%`;
      meterText.textContent = `Glasur: ${Math.round(covered * 100)} %`;
      if (phase === 'glaze') hint.textContent = `🖌️ Streich ${spreadWord} auf das große Plätzchen.`;
      else if (phase === 'others') hint.textContent = 'Der Küchengehilfe glasiert die anderen …';
      else if (!selected) hint.textContent = 'Streudose wählen und dann über dem Plätzchen hin- und herfahren.';
      else hint.textContent = `✨ Fahr mit der Streudose über ${isCake ? (view3 === 'side' ? 'den Rand' : 'den Kuchen') : 'das Plätzchen'}: ${H.SPRINKLES[selected].name}.`;
      if (phase === 'glaze' && isCake) hint.textContent = `🖌️ Streich ${spreadWord} auf den Kuchen.`;
    }

    function toUnit(p) {
      return { x: (p.x - L.cx) / L.R, y: (p.y - L.cy) / L.R };
    }

    function paintAt(u) {
      const from = lastPaint || u;
      const steps = Math.max(1, Math.ceil(Math.hypot(u.x - from.x, u.y - from.y) / 0.05));
      for (let i = 1; i <= steps; i++) {
        const x = from.x + ((u.x - from.x) * i) / steps;
        const y = from.y + ((u.y - from.y) * i) / steps;
        pctx.beginPath();
        pctx.arc(x, y, BRUSH, 0, Math.PI * 2);
        pctx.fill();
        for (const g of grid) if (!g.on && Math.hypot(g.x - x, g.y - y) < BRUSH) g.on = true;
      }
      lastPaint = u;
      covered = grid.filter((g) => g.on).length / Math.max(1, grid.length);
      if (Math.random() < 0.15) sound('tick');
      if (covered >= 0.9) finishGlaze();
      update();
    }

    function finishGlaze() {
      if (phase !== 'glaze') return;
      phase = 'others';
      brushAt = null;
      sound('ding');
      vibrate(30);
      const step = () => {
        if (glazedOthers >= others.length) {
          phase = 'sprinkle';
          update();
          return;
        }
        glazedOthers++;
        sound('plop');
        othersTimer = setTimeout(step, 140);
      };
      othersTimer = setTimeout(step, 300);
      update();
    }

    function shakeTick(dt, now) {
      if (!shaker || !selected || phase !== 'sprinkle') return;
      shakeAcc += dt * 28;
      while (shakeAcc >= 1) {
        shakeAcc -= 1;
        const a = Math.random() * Math.PI * 2;
        const d = Math.random() * 26;
        falling.push({
          side: isCake && view3 === 'side',
          kind: selected,
          x0: shaker.x + Math.sin(now / 60) * 4,
          y0: shaker.y - 46,
          x1: shaker.x + Math.cos(a) * d,
          y1: shaker.y + Math.sin(a) * d * 0.8,
          t: 0,
          a: Math.random() * Math.PI,
          c: Math.random(),
        });
      }
      if (Math.random() < dt * 10) sound('shake');
    }

    function land(p) {
      if (p.side) {
        const S = sideGeo(view.w, view.h, false);
        const u = { x: (p.x1 - S.x) / S.w, y: (p.y1 - S.y) / S.h };
        if (u.x < 0.03 || u.x > 0.97 || u.y < 0.08 || u.y > 0.97) return;
        if (sideSprinkles.some((t) => Math.hypot((t.x - u.x) * S.w, (t.y - u.y) * S.h) < S.h * 0.1)) return;
        if (sideSprinkles.length >= 40) return;
        sideSprinkles.push({ id: p.kind, x: u.x, y: u.y, a: p.a, c: p.c });
        if (!sideChosen.includes(p.kind)) {
          sideChosen.push(p.kind);
          update();
        }
        return;
      }
      const u = toUnit({ x: p.x1, y: p.y1 });
      if (!hitCtx.isPointInPath(bigPath, u.x * 1.12, u.y * 1.12)) return; // fell beside the cookie
      if (bigSprinkles.some((s) => Math.hypot(s.x - u.x, s.y - u.y) < 0.17)) return;
      if (bigSprinkles.filter((s) => s.kind === p.kind).length >= 14) return;
      bigSprinkles.push({ kind: p.kind, x: u.x, y: u.y, a: p.a, c: p.c });
      if (!chosen.includes(p.kind)) {
        chosen.push(p.kind);
        update();
      }
    }

    function drawBrush(ctx, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(-0.7);
      ctx.fillStyle = '#b7834f';
      rrect(ctx, -4, -78, 8, 50, 4);
      ctx.fill();
      ctx.fillStyle = '#c9ced3';
      ctx.fillRect(-7, -30, 14, 10);
      ctx.fillStyle = '#f0deb4';
      ctx.beginPath();
      ctx.moveTo(-7, -20);
      ctx.lineTo(7, -20);
      ctx.lineTo(5, 0);
      ctx.lineTo(-5, 0);
      ctx.fill();
      ctx.fillStyle = glaze ? glaze.color : '#ffffff';
      ctx.fillRect(-5, -6, 10, 6);
      ctx.restore();
    }

    function drawShaker(ctx, p, now) {
      ctx.save();
      ctx.translate(p.x, p.y - 62);
      ctx.rotate(Math.PI * 0.92 + Math.sin(now / 70) * 0.12);
      ctx.fillStyle = 'rgba(235,242,246,0.85)';
      rrect(ctx, -14, -24, 28, 42, 6);
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      rrect(ctx, -14, -24, 28, 42, 6);
      ctx.clip();
      ctx.fillStyle = '#efe3cc';
      ctx.fillRect(-14, -2, 28, 20);
      for (const spot of sprinkleLayout('kreis', [selected]).slice(0, 6)) drawSprinkle(ctx, selected, spot.x * 12, 8 + spot.y * 8, 7, spot.a, spot.c);
      ctx.restore();
      ctx.fillStyle = '#d63a3a';
      rrect(ctx, -15, -30, 30, 9, 3);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      for (let i = -1; i <= 1; i++) ctx.fillRect(i * 7 - 1, -28, 2, 2);
      ctx.restore();
    }

    function render(now) {
      const { ctx, w, h } = view;
      ctx.clearRect(0, 0, w, h);
      drawTray(ctx, 0, 0, w, h);
      // the big cookie
      const base = myLook({ icing: undefined, color: undefined, sprinkle: undefined });
      if (isCake && view3 === 'side') {
        drawSideView(ctx, { ...base, glaze }, sideGeo(w, h, false), sideSprinkles, 'cake');
        for (const p of falling) {
          const e = Math.min(1, p.t);
          drawSprinkle(ctx, p.kind, p.x0 + (p.x1 - p.x0) * e, p.y0 + (p.y1 - p.y0) * e * e, sideGeo(w, h, false).h * 0.09, p.a + p.t * 4, p.c);
        }
        if (shaker && selected) drawShaker(ctx, shaker, now);
        return;
      }
      if (phase === 'glaze') {
        drawCookie(ctx, { ...base, glaze: null, sprinkles: [] }, bigShape, L.cx, L.cy, L.R, 0);
        ctx.save();
        ctx.translate(L.cx, L.cy);
        ctx.scale(L.R, L.R);
        ctx.clip(bigPath);
        ctx.globalAlpha = glaze.opacity;
        ctx.drawImage(paint, -1.1, -1.1, 2.2, 2.2);
        ctx.globalAlpha = 1;
        ctx.lineJoin = 'round';
        ctx.lineWidth = glaze.texture === 'runny' ? 0.1 : 0.3;
        ctx.strokeStyle = base.color;
        ctx.stroke(bigPath);
        ctx.restore();
      } else {
        drawCookie(ctx, { ...base, glaze, sprinkles: [] }, bigShape, L.cx, L.cy, L.R, 0);
      }
      for (const s of bigSprinkles) drawSprinkle(ctx, s.kind, L.cx + s.x * L.R, L.cy + s.y * L.R, L.R * 0.15, s.a, s.c);
      // the other cookies on the strip below
      others.forEach((shape, i) => {
        const look = { ...base, glaze: i < glazedOthers || phase === 'sprinkle' ? glaze : null, sprinkles: phase === 'sprinkle' ? chosen : [] };
        const spot = L.small[i];
        if (spot) drawCookie(ctx, look, shape, spot.x, spot.y, spot.r, i + 1);
      });
      for (const p of falling) {
        const e = Math.min(1, p.t);
        drawSprinkle(ctx, p.kind, p.x0 + (p.x1 - p.x0) * e, p.y0 + (p.y1 - p.y0) * e * e, L.R * 0.15, p.a + p.t * 4, p.c);
      }
      if (brushAt && phase === 'glaze') drawBrush(ctx, brushAt);
      if (shaker && selected && phase === 'sprinkle') drawShaker(ctx, shaker, now);
    }

    function frame(now) {
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;
      shakeTick(dt, now);
      for (let i = falling.length - 1; i >= 0; i--) {
        falling[i].t += dt / 0.28;
        if (falling[i].t >= 1) {
          land(falling[i]);
          falling.splice(i, 1);
        }
      }
      render(now);
      raf = requestAnimationFrame(frame);
    }

    function pointer(e) {
      const p = canvasPoint(canvas, e);
      if (phase === 'glaze') {
        brushAt = p;
        const u = toUnit(p);
        if (Math.hypot(u.x, u.y) < 1.3) paintAt(u);
        else lastPaint = null;
      } else if (phase === 'sprinkle') {
        if (!selected) {
          if (e.type === 'pointerdown') toast('Erst eine Streudose wählen.');
          return;
        }
        shaker = p;
      }
    }

    let down = false;
    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      down = true;
      lastPaint = null;
      pointer(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (down) pointer(e);
    });
    const end = () => {
      down = false;
      lastPaint = null;
      brushAt = null;
      shaker = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    update();
    raf = requestAnimationFrame(frame);
    return {
      collect: () => ({ sprinkles: chosen, side: sideChosen }),
      check() {
        if (phase === 'glaze') return 'Der Guss ist noch nicht aufgepinselt.';
        if (chosen.length === 0) return 'Noch keine Streusel drauf.';
        if (isCake && recipe && recipe.side && sideChosen.length === 0) return 'Der Rand ist noch nicht verziert.';
        return null;
      },
      cleanup() {
        cancelAnimationFrame(raf);
        clearTimeout(othersTimer);
      },
      resize() {
        view = fitCanvas(canvas);
        L = layout();
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
    if (look.kind === 'torte') {
      drawBig3D(ctx, look, 'kreis', w / 2, h * 0.4, r * 0.62, 1);
      if (look.layers && look.layers.length) drawTorteSlice(ctx, look.layers, w / 2, h * 0.95, r * 0.7, h * 0.18, look);
      return;
    }
    if (look.kind === 'cake') {
      drawBig3D(ctx, look, shapes[0] || 'kreis', w / 2, h / 2, r * 0.66, 1);
      return;
    }
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

    const big = !!(recipe && recipe.kind && recipe.kind !== 'cookie');
    if (big) all.hidden = true;

    function layout() {
      const { w, h } = view;
      const trayH = h * 0.38;
      const pr = Math.min(w * 0.46, (h - trayH) * 0.46);
      const plate = { cx: w / 2, cy: trayH + (h - trayH) / 2, r: pr };
      if (big) {
        return { trayH, plate, tray: [{ x: w / 2, y: trayH / 2, r: Math.min(w * 0.3, trayH * 0.36) }], spots: [{ x: plate.cx, y: plate.cy, r: pr * 0.66 }] };
      }
      const tray = trayLayout(cookieList.length, w - 36, trayH - 36).map((s) => ({ ...s, x: s.x + 18, y: s.y + 18 }));
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
        drawBake(ctx, look, shape, L.tray[i].x, L.tray[i].y, L.tray[i].r, i);
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
        drawBake(ctx, look, cookieList[i], x, y, r, i);
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
      nextLabel: big ? 'Abgeben 🍽️' : 'Teller abgeben 🍽️',
      collect: () => ({}),
      check: () => (onPlate.size < cookieList.length ? (big ? 'Das steht noch auf dem Gitter.' : 'Es liegen noch Plätzchen auf dem Blech.') : null),
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
      ? `Dein Teller ist fertig! Warte auf ${others.map((p) => `${p.name} (${H.STATION_INFO[stationList[p.station]].icon} ${H.STATION_INFO[stationList[p.station]].title})`).join(', ')} …`
      : 'Dein Teller ist fertig! Gleich wird verglichen …';
  }

  // ------------------------------------------------------------------ results
  function showResults(msg) {
    const firstShow = !lastResults || lastResults.roundId !== msg.roundId;
    lastResults = msg;
    stopStation();
    recipeEl.hidden = true;
    resultsEl.hidden = false;
    const players = msg.players;
    const winner = players.find((p) => p.id === msg.winner);
    const mine = players.find((p) => p.id === me.id);
    let title;
    const free = !!(msg.recipe && msg.recipe.free);
    const points = (total) => `${H.num(total / 10)} / 10`;
    if (players.length === 1) title = free ? `${points(players[0].total)} Punkte${winner ? ' – Preis verdient!' : ''}` : `${players[0].total} % Rezepttreue${winner ? ' – Preis verdient!' : ''}`;
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
      if (winner && winner.id === me.id && storage.get(sessionStorage, `ploink-bake-prize-${msg.roundId}`) !== '1') {
        // Remember the prize once per round, even if the results arrive again after a reconnect.
        const owned = ownedUtensils();
        if (!owned.includes(msg.prize.id)) owned.push(msg.prize.id);
        storage.set(localStorage, UTENSIL_KEY, JSON.stringify(owned));
        storage.set(sessionStorage, `ploink-bake-prize-${msg.roundId}`, '1');
      }
      if (firstShow) showGift(msg.prize, winner, false);
    }
    if (firstShow && !msg.prize && mine && winner && winner.id !== me.id) sound('aww');
    renderUtensils();

    $('plates').replaceChildren(...players.map((p) => {
      const card = el('div', 'plate-card');
      if (p.id === msg.winner) card.classList.add('winner');
      card.style.setProperty('--seat-color', p.color);
      const canvas = el('canvas', 'plate-canvas');
      const name = el('strong', 'plate-name', p.id === me.id ? `${p.name} (du)` : p.name);
      const total = el('span', 'plate-total', free ? points(p.total) : `${p.total} %`);
      const note = el('span', 'plate-grade', `Note ${schoolGrade(p.total)}`);
      card.append(canvas, name, total, note);
      if (free && p.verdict) card.append(el('small', 'plate-verdict', p.verdict));
      requestAnimationFrame(() => drawPlate(canvas, p.look));
      return card;
    }));

    $('score-head').replaceChildren(row('th', ['', ...players.map((p) => (p.id === me.id ? 'Du' : p.name))]));
    const bodyRows = [];
    const rowsOf = free
      ? H.FREE_CATEGORIES.map((c) => ({ id: c.id, label: `${c.icon} ${c.title}` }))
      : H.scoredOf(msg.recipe).map((id) => ({ id, label: `${H.STATION_INFO[id].icon} ${H.STATION_INFO[id].title}` }));
    const stars = (score) => {
      const n = Math.round(score / 20);
      return '★'.repeat(n) + '☆'.repeat(5 - n);
    };
    for (const { id: station, label } of rowsOf) {
      const tr = row('td', [label, ...players.map((p) => (free ? stars(p.scores[station].score) : `${p.scores[station].score} %`))]);
      if (free) tr.classList.add('stars-row');
      tr.classList.add('score-row');
      players.forEach((p, i) => {
        const best = Math.max(...players.map((q) => q.scores[station].score));
        if (players.length > 1 && p.scores[station].score === best) tr.children[i + 1].classList.add('best');
      });
      const notes = el('tr', 'notes-row');
      notes.hidden = !free; // the jury's comments are the fun part: open from the start
      const cell = el('td', '');
      cell.colSpan = players.length + 1;
      for (const p of players) {
        const line = el('p', 'note-line');
        const who = el('strong', '', `${p.id === me.id ? 'Du' : p.name}: `);
        who.style.color = p.color;
        const list = p.scores[station].notes;
        line.append(who, list.length ? list.join(' · ') : (free ? '—' : 'genau nach Rezept 👌'));
        cell.append(line);
      }
      notes.append(cell);
      tr.addEventListener('click', () => {
        notes.hidden = !notes.hidden;
      });
      bodyRows.push(tr, notes);
    }
    $('score-body').replaceChildren(...bodyRows);
    $('results-hint').textContent = free ? 'Die Kommentare der Jury stehen unter jeder Kategorie.' : 'Tippe auf eine Zeile, um zu sehen, was vom Rezept abwich.';
    $('score-foot').replaceChildren(
      row('th', ['🎓 Note', ...players.map((p) => schoolGrade(p.total))]),
      row('th', [free ? 'Gesamtnote' : 'Rezepttreue', ...players.map((p) => (free ? points(p.total) : `${p.total} %`))]),
      row('td', ['⏱️ Zeit', ...players.map((p) => (p.finished ? formatTime(p.timeMs) : 'nicht fertig'))]),
    );
  }

  /** The prize in big: a wrapped present to tap open, or straight open to look at it again. */
  function showGift(prize, winner, opened) {
    const mine = winner && winner.id === me.id;
    const gift = $('gift');
    gift.hidden = false;
    gift.classList.toggle('open', opened);
    gift.classList.toggle('lost', !mine);
    $('gift-emoji').textContent = prize.emoji;
    $('gift-name').textContent = prize.name;
    $('gift-kicker').textContent = mine ? '🏆 Du hast gewonnen!' : `🏆 ${winner ? winner.name : ''} hat gewonnen`;
    $('gift-hint').textContent = opened
      ? (mine ? 'Liegt jetzt bei deinen Backutensilien.' : `Das bekommt ${winner ? winner.name : ''}.`)
      : (mine ? 'Tippe auf dein Geschenk!' : 'Tippe auf das Geschenk und schau, was es gibt.');
    giftMine = mine;
    giftWinner = winner;
  }

  let giftMine = false;
  let giftWinner = null;
  $('gift-box').addEventListener('click', () => {
    const gift = $('gift');
    if (gift.classList.contains('open')) return;
    gift.classList.add('open');
    $('gift-hint').textContent = giftMine ? 'Liegt jetzt bei deinen Backutensilien.' : `Das bekommt ${giftWinner ? giftWinner.name : ''}.`;
    sound(giftMine ? 'fanfare' : 'aww');
    if (giftMine) vibrate([60, 40, 60, 40, 200]);
  });
  $('gift-close').addEventListener('click', () => {
    $('gift').hidden = true;
  });
  $('prize').addEventListener('click', () => {
    if (lastResults && lastResults.prize) showGift(lastResults.prize, lastResults.players.find((p) => p.id === lastResults.winner), true);
  });

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
  $('mode-recipe').addEventListener('click', () => send({ type: 'mode', mode: 'recipe' }));
  $('mode-free').addEventListener('click', () => send({ type: 'mode', mode: 'free' }));
  for (const b of document.querySelectorAll('#free-options [data-kind]')) {
    b.addEventListener('click', () => send({ type: 'free', kind: b.dataset.kind, jam: $('free-jam').checked }));
  }
  $('free-jam').addEventListener('change', () => send({ type: 'free', kind: (state && state.freeKind) || 'cookie', jam: $('free-jam').checked }));
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
    get station() { return stationList[stationIndex]; },
    get steps() { return steps; },
    get results() { return lastResults; },
  };
})();
