# Circuit Rush: CS411 Multiplayer Game Arena

A competitive 3D kart race for 1 to 3 human players per room. Empty grid slots are filled with bots, up to 8 karts.
One **Node.js server** acts as the referee. Each player runs an **Electron client** that opens real **TCP and UDP sockets**.
The graphics come from [Turbo Kart Rally](https://github.com/bridge-mind/turbo-kart-rally) (MIT, see `client/game/LICENSE`).
The networking (server, sockets, lobby, rooms, sync, items, disconnects) is the part built for this project.

```
server/server.js        game server (no dependencies)
server/selftest.js      automated smoke test of the protocol
server/gateway.js       web gateway: serves the browser version, WebSocket <-> real TCP/UDP bridge
start.js                `npm start`: install + server + public link
client/game/net-shim.js browser stand-in for the Electron preload (WebSocket to the gateway)
client/main.js          Electron main process: owns the TCP + UDP sockets
client/preload.js       exposes window.net to the game page
client/game/src/net.js  client networking: UDP kart states, remote kart smoothing
client/game/src/*.js    the game (main.js = flow + server messages, menu.js = login/lobby/room screens)
```

## Run

You need Node.js 18 or newer on every PC, plus a copy of this folder.

**One command (host):** in the project folder run `npm start`. It installs what's missing (game files, Cloudflare's `cloudflared`), starts the server and prints a public `https://….trycloudflare.com` link. Players open that link in Chrome or Edge from any network and play.

**Manual way:**

**Server** (one PC):
```bash
cd server
node server.js
```
It listens on **TCP 5000** and **UDP 5000** (TCP and UDP port numbers are separate, so one number covers both) and serves the browser version on **HTTP 8080**. Allow them in the firewall
(Windows: accept the "allow access" prompt, for both private and public networks).

**Client** (each player PC):
```bash
cd client
npm install
npm start
```
If the network blocks `registry.npmjs.org` (some campus Wi-Fi does), install from the npmmirror mirror instead (PowerShell):
```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; npm install --registry=https://registry.npmmirror.com
```
`npm install` is needed only once; after that the game runs offline (three.js is bundled locally).

Press Enter on the title screen, type the server's IP address (`127.0.0.1` when the server runs on the same PC) and a name, then click CONNECT.
In the lobby, create a room or join one. Pick a racer. The room host (★) chooses the bot class and the number of laps, then clicks **START RACE**. The host can start alone or with 1 or 2 other players.

To find the server PC's IP address: `ipconfig` on Windows (IPv4 Address), or `ip a` on Linux.

Test the server without the game: `cd server && node selftest.js`.

## Controls
Arrow keys or WASD: drive · Space: drift · E / Shift: use item · C: look back · Esc: menu (leave race) · M: mute ·
**L: toggle 20% UDP packet loss** (demo: remote karts stay smooth).

## Protocol: what goes over TCP and what over UDP

| Interaction | Protocol | Why |
|---|---|---|
| login, room list, create/join/leave room, character, start | TCP | must arrive, in order |
| `race_start` (grid), `loaded`, `go` (countdown start) | TCP | everyone must start the same race at the same moment |
| lap and finish reports, results and points | TCP | a lost message would make the standings wrong |
| item box claim, item use, item hit claim | TCP | one lost or duplicated message changes the race |
| kart position, heading, speed (30 times per second) | UDP | stale after about 30 ms; the newest packet replaces the old one, so resending is useless |
| ping / heartbeat (1 per second) | UDP | measures real latency and detects dead clients |

TCP messages are JSON lines (`{"t":"login","name":"Ana"}\n`). UDP datagrams are JSON objects with a sequence number. Receivers drop packets older than the last one they saw, because UDP can reorder packets.
The other karts are **dead-reckoned and smoothed**: each client moves a remote kart forward along its last known direction and speed, then eases it toward each new packet. A lost packet therefore shows no visible jump.

### The server is the referee
- **Rooms:** at most 3 humans per room. You can join only while the room is in the lobby. Only the host can start the race.
- **Fair start:** clients load the track and send `loaded`. When every player has loaded (or after a 10 s timeout), the server sends `go` and all clients begin the 3-2-1 countdown together.
- **Laps:** each client reports its laps. The server rejects a lap number that is not the next one and any lap faster than 10 s.
- **Finish order** follows the order in which the server *receives* the finish reports, so two karts that finish almost together are ordered fairly.
- **Item boxes:** the first claim wins. A second kart touching the same box gets nothing.
- **Item hits:** the victim's PC claims the hit. The server accepts only the first claim for each projectile, so one shell cannot hit twice.
- **Points:** 10/8/6/5/4/3/2/1 by place. The totals add up in the room across races.
- **Ownership:** a client may report only for its own kart (and for the bots, if it is the host). Other reports are ignored.

### Simultaneous players and disconnections
- Every player has its own TCP socket. A message handler error is caught, so one bad client cannot crash the server, and malformed JSON is ignored.
- A disconnect is detected in two ways: the TCP socket closes (window closed or app crashed), or **no UDP packet arrives for 3 s** (cable pulled or PC frozen).
- When a player disconnects, the server tells the room (`left`), the player's kart is removed, the race continues, and the player is ranked by distance covered.
- If the host leaves, the next player becomes host and takes over driving the bots. A room with no players is deleted.

## Bonus: playing across different networks

There are two ways to play across networks. Both run against the same server.

### A. Browser link (easiest for players)
Run `npm start` on the host PC. It prints a link like `https://random-words.trycloudflare.com`. Players open it in Chrome or Edge on any network, type a name, and play. They install nothing.

How it works: a browser cannot open raw TCP or UDP sockets. The browser therefore talks to the server's **web gateway** (`server/gateway.js`) over a WebSocket. For each browser player, the gateway opens a **real TCP connection and a real UDP socket** to the game server and relays the messages. Browser players and Electron players can share the same room.
Limitation to mention in the slides: between the browser and the gateway, all traffic (including positions) travels over TCP (WebSocket). Cloudflare tunnels carry only TCP and HTTP.

On the same network, players can also open `http://SERVER-IP:8080` directly (`npm start` prints it).

### B. Electron client with real TCP + UDP across networks (best for the TCP/UDP grade)
The server must be reachable on **TCP and UDP port 5000**. Choose one option:
1. **playit.gg (free, no router access needed):** install the playit agent on the server PC and create one tunnel of type **TCP+UDP** pointing to local port **5000**. It gives an address like `something.gl.joinmc.link:12345`. Players run the Electron client (`cd client && npm start`) and type that `address:port` as the server.
2. **Tailscale or ZeroTier VPN:** install it on all PCs and sign in to the same account. Players type the server's `100.x.y.z` address. UDP works through it.
3. **Cloud server or port forwarding:** run the server on a VPS with a public IP, or forward TCP and UDP 5000 on the router. Players type the public IP.

The client accepts `host` or `host:port`. The server records the address each UDP packet really comes from, so clients behind NAT receive replies without extra setup.
