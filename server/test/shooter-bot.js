'use strict';

// Blaster practice bot: shoots at random opponents and gets hit now and then.
// Usage: node test/shooter-bot.js <code> [name] [ws-url]

const WebSocket = require('ws');

const code = process.argv[2] || '42';
const name = process.argv[3] || 'Bot';
const url = process.argv[4] || 'ws://localhost:3000/ws/shooter';

const ws = new WebSocket(url);
let me = null;
let opponents = [];

ws.on('open', () => ws.send(JSON.stringify({
  type: 'join', code, name, token: `blasterbot-${name}-${code}`.replace(/[^a-zA-Z0-9-]/g, ''),
})));

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'error') {
    console.error(msg.message);
    process.exit(1);
  }
  if (msg.type === 'joined') me = msg.you;
  if (msg.type === 'state') {
    opponents = msg.players.filter((p) => p.id !== me && p.connected && !p.away && p.respawnMs === 0);
  }
  if (msg.type === 'incoming' && Math.random() < 0.35) {
    // Pretend the shot reached the bot's ship.
    setTimeout(() => ws.send(JSON.stringify({ type: 'hit', id: msg.id })), 1200);
  }
});

// Fire short bursts at a random opponent.
setInterval(() => {
  if (opponents.length === 0) return;
  const target = opponents[Math.floor(Math.random() * opponents.length)];
  const x = 0.1 + Math.random() * 0.8;
  const angle = (Math.random() * 2 - 1) * 0.35;
  for (let i = 0; i < 3; i++) {
    setTimeout(() => ws.send(JSON.stringify({ type: 'shot', target: target.id, x, angle, speed: 1.05 })), i * 250);
  }
}, 2200);

ws.on('close', () => process.exit(0));
