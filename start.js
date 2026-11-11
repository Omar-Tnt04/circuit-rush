// One command to host Circuit Rush:  npm start
// 1. installs the game files once (needed to serve the browser version)
// 2. installs Cloudflare's tunnel tool once (gives a public https link)
// 3. starts the game server (TCP+UDP 5000, web 8080) and prints the link players open in a browser
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const run = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });
const client = path.join(__dirname, 'client');

if (!fs.existsSync(path.join(client, 'node_modules', 'three'))) {
  console.log('Installing game files (one time)...');
  // npmmirror: works on networks that block registry.npmjs.org
  run('npm install --registry=https://registry.npmmirror.com', { cwd: client, env: { ...process.env, ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/' } });
}

function findCloudflared() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'),
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ];
  try { return execSync('where cloudflared', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim(); } catch { /* not on PATH */ }
  return candidates.find((p) => fs.existsSync(p));
}
let cloudflared = findCloudflared();
if (!cloudflared && process.platform === 'win32') {
  console.log('Installing Cloudflare tunnel tool (one time)...');
  try { run('winget install --id Cloudflare.cloudflared -e --silent --accept-source-agreements --accept-package-agreements'); } catch { /* reported below */ }
  cloudflared = findCloudflared();
}

require('./server/server.js'); // game server + web gateway

const lan = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => `http://${a.address}:8080`);
const banner = (lines) => console.log('\n' + '='.repeat(64) + '\n' + lines.join('\n') + '\n' + '='.repeat(64) + '\n');

if (!cloudflared) {
  banner(['Public link unavailable (cloudflared not installed).', 'Same network players open:', ...lan.map((u) => '   ' + u)]);
} else {
  // http2 instead of QUIC: QUIC needs outgoing UDP, which school/campus networks often block
  const tunnel = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://localhost:8080']);
  console.log('Opening public link (takes ~10-30 s)...');
  let url = null, connected = false, shown = false;
  const resolver = new (require('dns').promises.Resolver)();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  const showWhenLive = async () => {
    if (shown || !url || !connected) return;
    shown = true;
    // wait until the new name exists in public DNS, so players don't get "site can't be reached"
    for (let i = 0; i < 30; i++) {
      try { await resolver.resolve4(new URL(url).hostname); break; } catch { await new Promise((r) => setTimeout(r, 2000)); }
    }
    await new Promise((r) => setTimeout(r, 3000));
    banner(['PLAYERS: open this link in Chrome/Edge, from any network:', '', '   ' + url, '',
      'If it says "site can\'t be reached" on THIS PC: run  ipconfig /flushdns  and reload.',
      'Same network also works: ' + lan.join('  ')]);
  };
  const watch = (d) => {
    const text = d.toString();
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) url = m[0];
    if (/Registered tunnel connection/i.test(text)) connected = true;
    for (const line of text.split('\n')) if (/\bERR\b/.test(line)) console.log('[tunnel] ' + line.trim());
    showWhenLive();
  };
  tunnel.stdout.on('data', watch);
  tunnel.stderr.on('data', watch);
  process.on('exit', () => tunnel.kill());
  process.on('SIGINT', () => process.exit());
}
