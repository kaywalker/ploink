'use strict';

// Schießbude practice bot: takes a seat and shoots some of the targets over its phone.
// Usage: node test/gallery-bot.js <code> [name] [hit chance 0..1] [ws-url]

const WebSocket = require('ws');
const { targetPosition } = require('../public/shared/gallery-hub');

const code = process.argv[2] || '42';
const name = process.argv[3] || 'Bot';
const skill = Number(process.argv[4] || 0.025);
const url = process.argv[5] || 'ws://localhost:3000/ws/gallery';

const ws = new WebSocket(url);
let me = null;
let seat = -1;
let phase = 'lobby';
const targets = new Map();

ws.on('open', () => ws.send(JSON.stringify({
  type: 'join', code, name, token: `gallerybot-${name}-${code}`.replace(/[^a-zA-Z0-9-]/g, ''),
})));

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type === 'error') {
    console.error(msg.message);
    process.exit(1);
  }
  if (msg.type === 'joined') me = msg.you;
  if (msg.type === 'state') {
    phase = msg.phase;
    seat = msg.seats.findIndex((s) => s.id === me);
    if (phase !== 'playing') targets.clear();
  }
  if (msg.type === 'spawn') targets.set(msg.target.id, msg.target);
  if (msg.type === 'targets') for (const t of msg.list) targets.set(t.id, t);
  if (msg.type === 'pop') targets.delete(msg.id);
});

// Every 100 ms: maybe shoot a visible target (bombs are avoided most of the time).
setInterval(() => {
  if (phase !== 'playing' || seat < 0) return;
  const now = Date.now();
  for (const t of targets.values()) {
    if (now > t.t0 + t.ttl) { targets.delete(t.id); continue; }
    const p = targetPosition(t, now);
    const visible = p.x > seat + 0.05 && p.x < seat + 0.95 && p.y > 0.05 && p.y < 0.9;
    const chance = t.type === 'bomb' ? skill * 0.15 : skill;
    if (visible && Math.random() < chance) {
      ws.send(JSON.stringify({ type: 'shoot', id: t.id }));
      break;
    }
  }
}, 100);

ws.on('close', () => process.exit(0));
