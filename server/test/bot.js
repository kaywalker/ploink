'use strict';

// Practice bot: joins a room and returns every ball after a short delay.
// Usage: node test/bot.js <code> [name] [ws-url]

const WebSocket = require('ws');

const code = process.argv[2] || '42';
const name = process.argv[3] || 'Bot';
const url = process.argv[4] || 'ws://localhost:3000/ws';

const ws = new WebSocket(url);
ws.on('open', () => ws.send(JSON.stringify({ type: 'join', code, name, token: `bot-${name}-${code}`.replace(/[^a-zA-Z0-9-]/g, '') })));
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'error') {
    console.error(msg.message);
    process.exit(1);
  }
  if (msg.type !== 'ball') return;
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'exit',
      id: msg.id,
      seq: msg.seq,
      x: 0.15 + Math.random() * 0.7,
      angle: (Math.random() * 2 - 1) * 0.8,
      speed: msg.speed * 1.05,
    }));
  }, msg.delay + 1200 + Math.random() * 800);
});
ws.on('close', () => process.exit(0));
