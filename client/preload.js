// Exposes a tiny, safe network API to the game page as window.net.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('net', {
  connect: (ip) => ipcRenderer.send('connect', ip),
  send: (msg) => ipcRenderer.send('tcp', msg),
  sendUdp: (msg) => ipcRenderer.send('udp', msg),
  on: (fn) => ipcRenderer.on('net', (_, msg) => fn(msg)),
});
