# Ploink

Multiplayer phone games. Everyone opens the site on their phone, picks a mode and enters
the same two-digit room code.

- **Blaster** (`shooter.html`): each phone shows a ship that follows the finger and
  auto-fires while touching. The top edge is split into one lane per opponent; a shot
  leaving through a lane comes down on that opponent's screen. Dodge or shoot it down.
  3 HP, respawn with a short shield.
- **Schießbude** (`gallery.html`): the phones lie side by side and form one continuous
  landscape. Balloons, UFOs, drones and bombs fly across all screens; tap to shoot, the
  first hit scores. 90-second rounds, seats are arranged in the lobby.
- **Kontrollzentrum** (`control.html`): a cooperative shouting game. Every phone gets its
  own panel of oddly named buttons, switches and sliders; every player gets an order that
  usually refers to someone else's panel, so orders have to be shouted across the table.
  Completed orders fill the team bar (next level: faster, more controls), expired orders
  cost stability.
- **Hausmeister-Trupp** (`brawl.html`): a cooperative side-scrolling brawler against waves of
  dust monsters, portrait or landscape. The whole arena is the touch surface (drag = walk,
  tap = broom sweep combo, swipe up = jump, swipe sideways = dash kick); one thumb is enough,
  in landscape a second thumb can sweep while the first steers. Monsters come from every
  direction (both sides, out of the lockers, up from the front) and spread around a janitor
  instead of queueing on one side. Each phone follows its own janitor; the host simulates
  everything and sends ~15 snapshots per second.
- **Katana-Küche** (`ninja.html`): up to six ninjas share one bamboo dojo and slice the fruit
  and vegetables that fall from the sky. Swipe in a direction and the ninja jumps there,
  also in mid-air as often as you like. In the air the ninja rolls
  and the spinning katana cuts everything in reach (tap on the ground: a spin in place).
  Combos score a bonus, wasp nests cost points and stun. A katana hit kicks another ninja
  away and steals 10 of their points; if both katanas are spinning, the blades clash and
  both ninjas bounce apart instead. Power-up bubbles rise from the floor now and then
  (the sky is busy with fruit) and are collected by touching them: giant katana (longer reach), double points, a shield that
  blocks one kick or wasp nest, turbo jumps, and three shuriken: double-tap to throw one
  towards the tapped spot; it slices fruit on its way and knocks a ninja away (a spinning
  katana deflects it). Every ~25 s the floor glows and turns to lava for 8 s:
  landing in it costs 20 points and flings the ninja up, fruit falling in burns; the
  platforms stay safe. Synthesized sound effects and a generative dojo background music (`sfx.js`,
  Web Audio; faster in the last 10 seconds) with separate sound and music buttons;
  `sounds.html` plays each one on its own. Every phone keeps its own best score per
  player name; the lobby shows the bests of everybody in the room, and after a round it
  marks new records and where each round score would land in that list. 75-second rounds; best played in portrait.
- **Plätzchen-Duell** (`bake.html`): two players bake the same random recipe, each on their
  own phone, station by station: weigh the ingredients from a shelf on a kitchen scale (hold
  to pour) and stir them in the bowl, roll the dough to the right thickness, cut out the right
  number of shapes, bake at the right temperature for the right time, stir the icing from
  powdered sugar and lemon juice, colour it with one of 7 piping bags and pick the sprinkles.
  The recipe can be opened at any time. At the end both plates are shown side by side with a
  score per station and what differed from the recipe; the more accurate baker wins a new
  baking utensil (collected per phone in localStorage). Playing alone works as practice
  (a prize from 90 %). Every round brings a random recipe and difficulty: cookies with icing,
  marmalade cookies (cook jam on the stove), chocolate cookies (water bath), cakes (pick and grease
  the tin, glaze, decorate top and side) and cream tortes (cut the sponge into layers, whip cream,
  roast crunch in a pan, stack the layers, decorate top and side). Results show a percentage and
  a school grade. In the **free mode** (lobby switch) there is no recipe: choose cookies, cake or
  torte, with or without marmalade, and a jury rates taste, baking, decoration and creativity.
- **Pong** (`index.html`): a paddle at the bottom; the ball drops in from the top, bounces
  off the side walls and must be kept out of your goal. Return it through the top edge and
  it flies into a random other player's screen.

**Full screen:** the start page has a full-screen button; the choice is remembered and
every game page goes back to full screen on the first touch (`screen-mode.js`). Android
and iPad support this in the browser; on iPhone, Safari only allows full screen for
videos, so Ploink runs without browser bars when it is added to the home screen
(`manifest.webmanifest`, apple-touch-icon).

## Architecture

- Plain HTML/CSS/JS client in `server/public`; no build step.
- The game logic lives in `server/public/shared/*-hub.js`. The hubs are transport-agnostic
  and run either in Node or in the browser of the hosting phone.
- `server/public/shared/net.js` picks the transport per page load:
  - **Server mode**: the page was served by `server/server.js` (`GET health` answers
    `{"ploink": true}`) → WebSocket to that server.
  - **Peer-to-peer mode** (any static hosting): the first phone that enters a code claims
    the PeerJS id `ploink-v1-<mode>-<code>` and becomes the host; everyone else connects
    to it directly via WebRTC. The public PeerJS broker is only used to find each other.
    If the host leaves, the others reconnect and one of them becomes the new host
    (scores of that round are lost).
  - Force a transport with `?net=server` or `?net=p2p`.
- On static hosting a service worker (`sw.js`, network first) caches the site so it loads
  instantly on later visits. Playing needs internet for the PeerJS broker. It is not
  registered next to the Node server.
- Vendored library in `server/public/vendor`: PeerJS 1.5.5 (MIT, see `peerjs-LICENSE`).

## Run with the Node server

```bash
PORT_PREFIX=30 docker compose up -d
```

Open `http://localhost:3080` (or `http://<your-LAN-IP>:3080` on phones in the same Wi-Fi).
Room codes can be passed in the URL: `/#42` (Pong), `/shooter.html#42`, `/gallery.html#42`, `/control.html#42`, `/brawl.html#42`, `/ninja.html#42`, `/bake.html#42`.
Peer-to-peer mode can be tried locally with `http://<host>:3080/?net=p2p`.

## Run without a server (static hosting)

Publish the folder `server/public` on any static host with HTTPS. HTTPS also enables the
screen wake lock, which keeps the host awake.

### GitHub Pages

`.github/workflows/pages.yml` publishes `server/public` on every push to `main`.

1. Create a **public** repository on GitHub (Pages for private repositories needs a paid plan).
2. Push this project to its `main` branch.
3. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. Re-run the workflow in the **Actions** tab (or push again). The site is then available at
   `https://<user>.github.io/<repository>/`.

Limits of peer-to-peer mode:

- The hosting phone must keep the page open and the screen on; a locked or backgrounded
  host freezes the game for everybody.
- Networks that isolate clients (guest or company Wi-Fi) can block direct connections;
  use the Node server there.
- Room codes are shared by everyone using the same site: two groups picking the same code
  at the same time end up in one room.

## Test

```bash
docker compose exec server npm test
```

Practice bots (server mode only) for room 42:

```bash
docker compose exec -d server node test/bot.js 42 Bot
docker compose exec -d server node test/shooter-bot.js 42 Ben
docker compose exec -d server node test/gallery-bot.js 42 Ben 0.025   # last arg: hit chance per 100 ms
```

Stop all bots: `docker compose exec server pkill -f bot.js`
