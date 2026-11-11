// Circuit Rush game server.
// TCP (port 5000): login, lobby, rooms, race start/end, laps, finish, items — anything that must arrive, in order.
// UDP (port 5000 too: TCP and UDP port numbers are separate): kart positions (~30/s) and ping/heartbeat — fast, latest packet wins, loss is fine.
// The server is the referee: it decides who is in which room, when a race starts, the finish order,
// who got an item box, which item hit counts, and the points.
const net = require('net');
const dgram = require('dgram');

const TCP_PORT = +process.env.TCP_PORT || 5000;
const UDP_PORT = +process.env.UDP_PORT || TCP_PORT; // same number => one TCP+UDP tunnel/firewall rule
const WEB_PORT = +process.env.WEB_PORT || 8080;      // browser link (bonus)
const MAX_PLAYERS = 3;          // humans per room; the 8-kart grid is filled with bots
const KARTS = 8;
const CHARS = 8;
const HEARTBEAT_TIMEOUT = 3000; // ms without any UDP packet => player is considered gone
const MIN_LAP_MS = 10000;       // anti-cheat: a lap faster than this is rejected
const POINTS = [10, 8, 6, 5, 4, 3, 2, 1];

const players = new Map(); // id -> { id, name, sock, udp, room, char, lastSeen }
const rooms = new Map();   // id -> { id, name, laps, host, players: [id], state, race, scores }
let nextId = 1;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const clean = (v, n) => String(v || '').replace(/[^\w .\-']/g, '').trim().slice(0, n); // names are shown in the UI
const send = (p, msg) => { if (p && !p.sock.destroyed) p.sock.write(JSON.stringify(msg) + '\n'); };
const toRoom = (room, msg, except) => room.players.forEach((id) => id !== except && send(players.get(id), msg));

function roomList() {
  return [...rooms.values()].map((r) => ({ id: r.id, name: r.name, laps: r.laps, count: r.players.length, max: MAX_PLAYERS, state: r.state }));
}
function pushRooms() { const list = roomList(); for (const p of players.values()) send(p, { t: 'rooms', rooms: list }); }
function pushRoom(room) {
  toRoom(room, {
    t: 'room', id: room.id, name: room.name, laps: room.laps, host: room.host, state: room.state,
    players: room.players.map((id) => { const p = players.get(id); return { id, name: p.name, char: p.char, points: room.scores[p.name] || 0 }; }),
  });
}

// ------------------------------------------------------------------------------------------------
// TCP: one socket per player, newline-delimited JSON messages
// ------------------------------------------------------------------------------------------------
net.createServer((sock) => {
  sock.setNoDelay(true); // send small messages immediately (no Nagle batching)
  const p = { id: nextId++, name: null, sock, udp: null, room: null, char: 0, lastSeen: Date.now() };
  log(`tcp connect #${p.id} from ${sock.remoteAddress}`);
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > 1e6) return sock.destroy(); // garbage protection
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // ignore malformed input
      try { handle(p, msg); } catch (e) { log('handler error', e); }
    }
  });
  sock.on('error', () => {}); // 'close' follows
  sock.on('close', () => drop(p, 'connection closed'));
}).listen(TCP_PORT, '0.0.0.0', () => log(`TCP listening on ${TCP_PORT}`));

function handle(p, m) {
  if (m.t === 'login') {
    const name = clean(m.name, 14);
    if (!name) return send(p, { t: 'error', msg: 'Enter a name' });
    if ([...players.values()].some((o) => o.name.toLowerCase() === name.toLowerCase())) return send(p, { t: 'error', msg: 'Name already taken' });
    p.name = name; p.lastSeen = Date.now();
    players.set(p.id, p);
    log(`login #${p.id} "${name}"`);
    send(p, { t: 'login_ok', id: p.id, name });
    return send(p, { t: 'rooms', rooms: roomList() });
  }
  if (!players.has(p.id)) return; // everything below needs a login
  const room = rooms.get(p.room);

  switch (m.t) {
    case 'create': {
      if (room) leave(p);
      const r = { id: nextId++, name: clean(m.name, 24) || `${p.name}'s room`, laps: 3, host: p.id, players: [], state: 'lobby', race: null, scores: {} };
      rooms.set(r.id, r);
      log(`room #${r.id} "${r.name}" created by ${p.name}`);
      return join(p, r);
    }
    case 'join': {
      const r = rooms.get(m.room);
      if (!r) return send(p, { t: 'error', msg: 'Room not found' });
      if (r.players.length >= MAX_PLAYERS) return send(p, { t: 'error', msg: 'Room is full' });
      if (r.state !== 'lobby') return send(p, { t: 'error', msg: 'Race in progress' });
      if (room) leave(p);
      return join(p, r);
    }
    case 'leave': if (room) leave(p); return;
    case 'char': { // each racer can be picked by only one player in the room
      const c = Math.abs(m.char | 0) % CHARS;
      if (!room || !room.players.some((id) => id !== p.id && players.get(id).char === c)) p.char = c;
      if (room) pushRoom(room);
      return;
    }
    case 'start': if (room && room.host === p.id && room.state === 'lobby') startRace(room, m); return;
  }
  if (!room || !room.race) return;
  const race = room.race;
  const owns = (k) => race.grid[k] && (race.grid[k].owner === p.id || (race.grid[k].owner == null && room.host === p.id));

  switch (m.t) {
    case 'loaded':
      race.loaded.add(p.id);
      if (room.players.every((id) => race.loaded.has(id))) go(room);
      return;
    case 'lap': { // client reports crossing the line; server checks it is the next lap and not impossibly fast
      if (room.state !== 'racing' || !owns(m.kart)) return;
      const k = race.karts[m.kart], now = Date.now();
      if (m.lap !== k.lap + 1 || now - k.lapAt < MIN_LAP_MS) return log(`rejected lap from ${p.name}`, m);
      k.lap = m.lap; k.lapAt = now;
      return;
    }
    case 'finish': { // finish order = order in which the SERVER receives the reports
      if (room.state !== 'racing' || !owns(m.kart)) return;
      const k = race.karts[m.kart];
      if (k.time != null || k.lap !== room.laps || Date.now() - k.lapAt < MIN_LAP_MS) return;
      k.time = (Date.now() - race.goAt) / 1000;
      race.order.push(m.kart);
      toRoom(room, { t: 'finish', kart: m.kart, name: race.grid[m.kart].name, place: race.order.length, time: k.time });
      checkEnd(room);
      return;
    }
    case 'box': { // item box: first claim wins, box respawns after 2 s
      if (!owns(m.kart) || (race.boxes.get(m.box) || 0) > Date.now()) return;
      race.boxes.set(m.box, Date.now() + 2000);
      return toRoom(room, { t: 'box', box: m.box, kart: m.kart });
    }
    case 'use': // item fired: tell everyone else so they spawn the same projectile
      if (owns(m.kart)) toRoom(room, { t: 'use', kart: m.kart, item: m.item, useId: m.useId, back: !!m.back, fwd: !!m.fwd }, p.id);
      return;
    case 'hit': { // victim's owner claims a hit; each projectile can hit once (blue shell: once per kart)
      if (!owns(m.kart)) return;
      const key = m.multi ? `${m.useId}:${m.kart}` : String(m.useId);
      if (race.hits.has(key)) return;
      race.hits.add(key);
      return toRoom(room, { t: 'hit', useId: m.useId, kart: m.kart, kind: m.kind, multi: !!m.multi });
    }
  }
}

function join(p, room) {
  const taken = new Set(room.players.map((id) => players.get(id).char));
  if (taken.has(p.char)) p.char = [...Array(CHARS).keys()].find((c) => !taken.has(c));
  p.room = room.id;
  room.players.push(p.id);
  log(`${p.name} joined room #${room.id}`);
  pushRoom(room); pushRooms();
}

function leave(p) {
  const room = rooms.get(p.room);
  p.room = null;
  if (!room) return;
  room.players = room.players.filter((id) => id !== p.id);
  log(`${p.name} left room #${room.id}`);
  if (!room.players.length) { rooms.delete(room.id); return pushRooms(); }
  if (room.host === p.id) room.host = room.players[0]; // host migration: new host also takes over the bots
  if (room.race) {
    const karts = room.race.grid.map((g, i) => (g.owner === p.id ? i : -1)).filter((i) => i >= 0);
    toRoom(room, { t: 'left', id: p.id, name: p.name, karts });
    if (room.state === 'loading' && room.players.every((id) => room.race.loaded.has(id))) go(room);
    checkEnd(room);
  }
  pushRoom(room); pushRooms();
}

function drop(p, reason) {
  if (p.dropped) return;
  p.dropped = true;
  if (players.get(p.id) === p) {
    log(`disconnect ${p.name}: ${reason}`);
    leave(p);
    players.delete(p.id);
  }
  p.sock.destroy();
}

// ------------------------------------------------------------------------------------------------
// Race lifecycle: start -> (all clients loaded) go -> finishes -> end
// ------------------------------------------------------------------------------------------------
function startRace(room, m) {
  const humans = room.players.map((id) => players.get(id));
  const used = new Set(humans.map((h) => h.char));
  const free = [...Array(CHARS).keys()].filter((c) => !used.has(c));
  const grid = humans.map((h) => ({ owner: h.id, name: h.name, char: h.char }));
  while (grid.length < KARTS) { const c = free.length ? free.shift() : grid.length % CHARS; grid.push({ owner: null, name: null, char: c }); }
  for (let i = grid.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [grid[i], grid[j]] = [grid[j], grid[i]]; } // random grid slots
  if ([1, 3, 5].includes(m.laps)) room.laps = m.laps;
  room.state = 'loading';
  room.race = {
    grid, loaded: new Set(), goAt: 0, order: [], boxes: new Map(), hits: new Set(),
    karts: grid.map(() => ({ lap: 1, lapAt: 0, time: null, progress: 0 })),
  };
  log(`race start in room #${room.id} (${humans.map((h) => h.name).join(', ')})`);
  toRoom(room, { t: 'race_start', grid, laps: room.laps, difficulty: ['easy', 'normal', 'hard'].includes(m.difficulty) ? m.difficulty : 'normal' });
  setTimeout(() => { if (room.state === 'loading') go(room); }, 10000); // don't wait forever for a slow PC
  pushRooms();
}

function go(room) {
  if (room.state !== 'loading') return;
  room.state = 'racing';
  room.race.goAt = Date.now() + 3500; // clients run the 3-2-1 countdown (3.5 s) and race time starts at GO
  room.race.karts.forEach((k) => { k.lapAt = room.race.goAt; });
  toRoom(room, { t: 'go' });
  pushRooms();
}

function checkEnd(room) {
  const race = room.race;
  if (!race || room.state !== 'racing') return;
  const humansLeft = race.grid.map((g, i) => (room.players.includes(g.owner) ? i : -1)).filter((i) => i >= 0);
  const humansDone = humansLeft.every((i) => race.karts[i].time != null);
  if (humansDone) { clearTimeout(race.timer); race.timer = setTimeout(() => endRace(room), 4000); return; } // let close bots cross the line
  // once the first human finishes, the rest have 45 s
  if (!race.timer && humansLeft.some((i) => race.karts[i].time != null)) race.timer = setTimeout(() => endRace(room), 45000);
}

function endRace(room) {
  const race = room.race;
  if (!race || room.state !== 'racing') return;
  clearTimeout(race.timer);
  // finishers in server arrival order, then everyone else ranked by how far they got
  const rest = race.grid.map((_, i) => i).filter((i) => !race.order.includes(i)).sort((a, b) => race.karts[b].progress - race.karts[a].progress);
  const results = [...race.order, ...rest].map((i, place) => {
    const g = race.grid[i], left = g.owner != null && !room.players.includes(g.owner);
    const points = left ? 0 : POINTS[place] || 0; // players who disconnected score nothing
    if (g.owner != null) {
      const p = players.get(g.owner);
      if (p && room.players.includes(p.id)) room.scores[p.name] = (room.scores[p.name] || 0) + points;
    }
    return { kart: i, name: g.name, char: g.char, human: g.owner != null, time: race.karts[i].time, points };
  });
  room.state = 'lobby';
  room.race = null;
  log(`race end in room #${room.id}:`, results.map((r) => r.name || `bot${r.kart}`).join(' > '));
  toRoom(room, { t: 'race_end', results });
  pushRoom(room); pushRooms();
}

// ------------------------------------------------------------------------------------------------
// UDP: JSON datagrams. 's' = kart states (relayed to the room), 'ping' = heartbeat + latency probe.
// ------------------------------------------------------------------------------------------------
const udp = dgram.createSocket('udp4');
udp.on('message', (buf, rinfo) => {
  let m;
  try { m = JSON.parse(buf); } catch { return; }
  const p = players.get(m.id);
  if (!p) return;
  p.lastSeen = Date.now();
  p.udp = rinfo; // remember the address the packets really come from (works behind NAT)
  if (m.t === 'ping') return udp.send(JSON.stringify({ t: 'pong', ts: m.ts }), rinfo.port, rinfo.address);
  if (m.t !== 's') return;
  const room = rooms.get(p.room);
  if (!room || room.state !== 'racing' || !Array.isArray(m.k)) return;
  // keep each kart's progress (lap + track position) to rank karts that did not finish
  for (const s of m.k) { const k = room.race.karts[s[0]]; if (k && k.time == null) k.progress = (s[7] | 0) + (+s[6] || 0); }
  for (const id of room.players) {
    const o = players.get(id);
    if (id !== p.id && o && o.udp) udp.send(buf, o.udp.port, o.udp.address);
  }
});
udp.bind(UDP_PORT, '0.0.0.0', () => log(`UDP listening on ${UDP_PORT}`));

require('./gateway')({ webPort: WEB_PORT, tcpPort: TCP_PORT, udpPort: UDP_PORT, log });

// heartbeat check: a player that stops sending UDP (cable pulled, PC frozen) is dropped even if TCP never closed
setInterval(() => {
  const now = Date.now();
  for (const p of players.values()) {
    if (now - p.lastSeen > HEARTBEAT_TIMEOUT) { send(p, { t: 'error', msg: 'Timed out (no UDP heartbeat)' }); drop(p, 'heartbeat timeout'); }
  }
}, 1000);
