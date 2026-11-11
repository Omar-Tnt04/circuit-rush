// Browser version of client/preload.js. In Electron (file://) window.net already exists and this does nothing.
// In a browser opened from the server's link, messages go over a WebSocket to the server's gateway,
// which forwards them on real TCP / UDP sockets.
if (!window.net && location.protocol.startsWith('http')) {
  let ws = null, handler = null;
  const out = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  window.net = {
    web: true,
    connect() {
      if (ws) { ws.onclose = null; ws.close(); }
      ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
      ws.onmessage = (e) => handler && handler(JSON.parse(e.data));
      ws.onclose = () => handler && handler({ t: 'disconnected' });
    },
    send: (m) => out({ k: 'tcp', m }),
    sendUdp: (m) => out({ k: 'udp', m }),
    on: (fn) => { handler = fn; },
  };
}
