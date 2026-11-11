// Web gateway (bonus): lets players join from a browser link, from any network.
// - HTTP: serves the game files (client/game + three.js) so the link opens the game.
// - WebSocket /ws: a browser cannot open raw TCP/UDP sockets, so for each browser player this gateway
//   opens a REAL TCP connection and a REAL UDP socket to the game server and relays messages both ways.
//   The game server cannot tell the difference: browser players speak exactly the same protocol.
const http = require('http');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function startGateway({ webPort, tcpPort, udpPort, log }) {
  const CLIENT = path.join(__dirname, '..', 'client');
  const ALLOWED = [path.join(CLIENT, 'game'), path.join(CLIENT, 'node_modules', 'three')]; // nothing else is served
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/') { res.writeHead(302, { Location: '/game/' }); return res.end(); }
    let file = path.normalize(path.join(CLIENT, url));
    if (url.endsWith('/')) file = path.join(file, 'index.html');
    if (!ALLOWED.some((dir) => file.startsWith(dir + path.sep))) { res.writeHead(404); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });

  // ---- minimal WebSocket server (RFC 6455): handshake + text frames ----
  server.on('upgrade', (req, sock) => {
    if (req.url !== '/ws' || !req.headers['sec-websocket-key']) return sock.destroy();
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.setNoDelay(true);
    bridge(sock);
  });

  function wsSend(sock, text) {
    if (sock.destroyed) return;
    const p = Buffer.from(text);
    let h;
    if (p.length < 126) h = Buffer.from([0x81, p.length]);
    else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
    sock.write(Buffer.concat([h, p]));
  }

  function bridge(ws) {
    const tcp = net.connect(tcpPort, '127.0.0.1');
    const udp = dgram.createSocket('udp4');
    tcp.setNoDelay(true);
    const close = () => { ws.destroy(); tcp.destroy(); try { udp.close(); } catch { /* already closed */ } };
    let lines = '';
    tcp.on('connect', () => wsSend(ws, '{"t":"connected"}'));
    tcp.on('data', (d) => { lines += d; let i; while ((i = lines.indexOf('\n')) >= 0) { wsSend(ws, lines.slice(0, i)); lines = lines.slice(i + 1); } });
    tcp.on('error', close); tcp.on('close', close);
    udp.on('message', (m) => wsSend(ws, m.toString()));
    udp.on('error', () => {});

    let buf = Buffer.alloc(0);
    ws.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const op = buf[0] & 15, masked = buf[1] & 128;
        let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const total = off + (masked ? 4 : 0) + len;
        if (len > 1e6) return close();
        if (buf.length < total) return;
        const payload = buf.subarray(off + (masked ? 4 : 0), total);
        if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[off + (i & 3)];
        buf = buf.subarray(total);
        if (op === 8) return close();
        if (op !== 1) continue; // only text frames carry game messages
        let m;
        try { m = JSON.parse(payload.toString()); } catch { continue; }
        if (m.k === 'tcp') tcp.write(JSON.stringify(m.m) + '\n');
        else if (m.k === 'udp') udp.send(JSON.stringify(m.m), udpPort, '127.0.0.1');
      }
    });
    ws.on('error', close); ws.on('close', close);
  }

  server.listen(webPort, '0.0.0.0', () => log(`Web gateway on http://localhost:${webPort}/  (browser players)`));
};
