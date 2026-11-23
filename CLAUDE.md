# Ploink

- Game logic lives in `server/public/shared/*-hub.js` (UMD: `require` in Node, globals `PloinkPongHub`/`PloinkBlasterHub`/`PloinkGalleryHub` in the browser). Hubs only see a minimal socket (`on('message'|'close')`, `send`, `readyState/OPEN`, `close`) so they run unchanged in Node and on the hosting phone. Never use Node-only APIs there.
- `server/public/shared/net.js` chooses the transport: WebSocket when `GET health` returns `{ploink: true}`, otherwise PeerJS/WebRTC with host election via the fixed peer id `ploink-v1-<mode>-<code>`. `?net=p2p` forces P2P locally. Link-level heartbeats (`{"type":"__hb"}`) are filtered out before hubs/clients see them.
- QR mode (`shared/qr.js`): host shows one offer QR per guest (`#qr=<code>.<id>.<payload>`), guest answers with `#qra=<id>.<payload>`; a `#qra=` page is relay-only (clients return early, `PloinkNet.relayOnly`) and forwards via BroadcastChannel `ploink-qr`. Payload prefix `c` = compact SDP rebuilt from a template, `z` = deflate, `u` = plain.
- `sw.js` is only registered when the page is not served by the Node server; the in-app Claude browser refuses service workers, test them in Chrome against a static server.
- Ball physics run on each client; the Pong hub is only a relay. A ball's `seq` increments on every hand-off and stale `exit`/`miss` messages with an old `seq` are ignored.
- Client world coordinates: screen width = 1 unit, height = `H` (height/width). Ball `angle` is measured from straight down; on hand-off the hub mirrors `x` and `angle` (phones "face" each other).
- Blaster lanes at the top = connected, non-away opponents in hub order; hits are validated via one-time shot ids. The same code in different modes is a different room.
- Schießbude: target paths are deterministic functions of the hub clock (`targetPosition`, duplicated in `public/gallery.js`); clients sync via ping/pong and only send `shoot` for hits. Panorama x is in phone widths (seat i shows [i, i+1]), y is a fraction of screen height.
- Static files are served with `no-store` (browsers kept stale CSS with no-cache).
- `node --watch` inside the container does not always notice edits from the host; `docker compose restart server` when a server change does not seem to apply.
