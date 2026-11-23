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
- **Pong** (`index.html`): a paddle at the bottom; the ball drops in from the top, bounces
  off the side walls and must be kept out of your goal. Return it through the top edge and
  it flies into a random other player's screen.

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
  - **QR mode** (`shared/qr.js`, picked on the join screen or with `?net=qr`): no broker at
    all. One phone opens the round as host and shows a QR code per new player (a link with
    the WebRTC offer). The guest scans it (in Ploink or with the normal camera app) and shows
    an answer QR code, which the host scans. Answers scanned with the camera app open a tab
    that hands them to the game tab via `BroadcastChannel`. Offers/answers use a compact SDP
    encoding (~200 characters) with deflate as fallback.
  - Force a transport with `?net=server`, `?net=p2p` or `?net=qr`.
- On static hosting a service worker (`sw.js`, network first) caches the site, so QR mode
  works without internet once the site has been opened. It is not registered next to the
  Node server.
- Vendored libraries in `server/public/vendor`: PeerJS 1.5.5 (MIT), qrcode-generator 2.0.4
  (MIT, license in the file header), jsQR 1.4.0 (Apache-2.0; only loaded when the browser has
  no `BarcodeDetector`).

## Run with the Node server

```bash
PORT_PREFIX=30 docker compose up -d
```

Open `http://localhost:3080` (or `http://<your-LAN-IP>:3080` on phones in the same Wi-Fi).
Room codes can be passed in the URL: `/#42` (Pong), `/shooter.html#42`, `/gallery.html#42`, `/control.html#42`.
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

In-app QR scanning needs camera access, which browsers only allow over HTTPS (or on
localhost). Without it, players scan the codes with their normal camera app.

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
