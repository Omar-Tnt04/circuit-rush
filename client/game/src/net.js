// Client-side networking glue. window.net comes from the Electron preload (real TCP/UDP sockets in the main process).
// Without Electron (plain browser) `net.available` is false and the game runs single-player as before.
const handlers = {};
const lastSeq = new Map(); // sender id -> last UDP sequence number seen (older/duplicate packets are dropped)

export const net = {
  available: !!window.net,
  id: null,
  name: null,
  room: null,       // last 'room' message
  ping: 0,
  loss: false,      // demo switch: drop 20% of our outgoing UDP packets
  seq: 0,
  _use: 0,

  connect(ip) { window.net.connect(ip); },
  send(msg) { window.net.send(msg); },
  udp(msg) {
    if (this.loss && Math.random() < 0.2) return;
    window.net.sendUdp({ ...msg, id: this.id });
  },
  on(type, fn) { handlers[type] = fn; },
  get isHost() { return !!this.room && this.room.host === this.id; },
  newUseId() { return `${this.id}-${++this._use}`; },
};

if (net.available) {
  window.net.on((m) => {
    if (m.t === 'pong') { net.ping = Math.round(performance.now() - m.ts); return; }
    if (m.t === 's') {
      if (m.seq <= (lastSeq.get(m.id) ?? -1)) return; // UDP may reorder: keep only the newest
      lastSeq.set(m.id, m.seq);
    }
    if (m.t === 'room') net.room = m;
    if (m.t === 'login_ok') { net.id = m.id; net.name = m.name; lastSeq.clear(); }
    try { handlers[m.t] && handlers[m.t](m); } catch (e) { console.error('[net]', m.t, e); }
  });
  // UDP heartbeat + latency probe, once a second, as long as we are logged in
  setInterval(() => { if (net.id) net.udp({ t: 'ping', ts: performance.now() }); }, 1000);
}

const r2 = (v) => Math.round(v * 100) / 100;

/** UDP state for the karts this client controls: [index, x, y, z, heading, speed, trackT, lap, flags]. */
export function sendKartStates(karts) {
  const k = [];
  for (const kart of karts) {
    if (!kart.local) continue;
    const flags = (kart.drifting ? 1 : 0) | (kart.driftDir > 0 ? 2 : 0) | (kart.boostTimer > 0 ? 4 : 0) | (kart.airborne ? 8 : 0);
    k.push([kart.index, r2(kart.position.x), r2(kart.position.y), r2(kart.position.z), r2(kart.heading), r2(kart.speed), Math.round(kart.trackT * 1e4) / 1e4, kart._lapCount | 0, flags]);
  }
  if (k.length) net.udp({ t: 's', seq: net.seq++, k });
}

/** Store a received state on the kart; driveRemote() moves the kart toward it every frame. */
export function applyKartState(kart, s) {
  kart.net = { x: s[1], y: s[2], z: s[3], h: s[4], speed: s[5], t: s[6], flags: s[8] };
}

/** Remote karts: no physics here — dead-reckon the last state forward and smooth toward it. */
export function driveRemote(k, dt) {
  const s = k.net;
  if (!s) return;
  s.x += Math.sin(s.h) * s.speed * dt; // predict where it is now (hides UDP gaps / lost packets)
  s.z += Math.cos(s.h) * s.speed * dt;
  const a = 1 - Math.exp(-dt * 10);
  k.position.x += (s.x - k.position.x) * a;
  k.position.y += (s.y - k.position.y) * a;
  k.position.z += (s.z - k.position.z) * a;
  let d = s.h - k.heading;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  k.heading += d * a;
  k.speed = s.speed;
  k.velocity.set(Math.sin(k.heading) * s.speed, 0, Math.cos(k.heading) * s.speed);
  k.trackT = s.t;
  k.drifting = !!(s.flags & 1);
  k.driftDir = s.flags & 2 ? 1 : -1;
  k.airborne = !!(s.flags & 8);
  if (s.flags & 4) k.boostTimer = Math.max(k.boostTimer, 0.1);
  // timers normally ticked by Kart physics (item effects shown on remote karts)
  k.time += dt;
  for (const n of ['boostTimer', 'starTimer', 'invulnTimer', 'spinTimer']) k[n] = Math.max(0, k[n] - dt);
  if (k.shrinkTimer > 0 && (k.shrinkTimer -= dt) <= 0) k._endShrink();
  k._animate(dt, 0, 1);
}
