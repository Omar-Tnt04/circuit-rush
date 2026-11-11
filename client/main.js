// Electron main process: owns the real TCP and UDP sockets and bridges them to the game window over IPC.
const { app, BrowserWindow, ipcMain } = require('electron');
const net = require('net');
const dgram = require('dgram');
const path = require('path');

let win, tcp, udp, host, port;
const toGame = (msg) => win && !win.isDestroyed() && win.webContents.send('net', msg);

ipcMain.on('connect', (_, ip) => {
  // reconnect: silence the old sockets so their 'close' doesn't look like a disconnect
  if (tcp) { tcp.removeAllListeners(); tcp.on('error', () => {}); tcp.destroy(); }
  if (udp) { udp.removeAllListeners(); udp.close(); }
  // "host" or "host:port" (e.g. a playit.gg tunnel address); the server uses the same port for TCP and UDP
  const m = String(ip).trim().match(/^(.*?)(?::(\d+))?$/);
  host = m[1] || '127.0.0.1'; port = +m[2] || 5000;
  // TCP: reliable, ordered stream. Messages are JSON lines.
  tcp = net.connect(port, host, () => toGame({ t: 'connected' }));
  tcp.setNoDelay(true);
  let buf = '';
  tcp.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { toGame(JSON.parse(line)); } catch { /* ignore malformed */ }
    }
  });
  tcp.on('error', (e) => toGame({ t: 'error', msg: e.message }));
  tcp.on('close', () => toGame({ t: 'disconnected' }));
  // UDP: connectionless datagrams for kart positions and ping.
  udp = dgram.createSocket('udp4');
  udp.on('message', (m) => { try { toGame(JSON.parse(m)); } catch { /* ignore */ } });
  udp.on('error', () => {});
});
ipcMain.on('tcp', (_, msg) => { if (tcp && !tcp.destroyed) tcp.write(JSON.stringify(msg) + '\n'); });
ipcMain.on('udp', (_, msg) => { if (udp && host) udp.send(JSON.stringify(msg), port, host); });

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280, height: 760, autoHideMenuBar: true, backgroundColor: '#000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false }, // keep heartbeat + UDP running when minimized
  });
  win.loadFile(path.join(__dirname, 'game', 'index.html'));
});
app.on('window-all-closed', () => app.quit());
