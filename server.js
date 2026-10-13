const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

const SECRET = process.env.PIXEL_SECRET || 'test123';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const LOG_FILE = path.join(__dirname, 'pixel-log.jsonl');

const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

function httpGet(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function lookupIP(ip) {
  if (!ip || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.') || ip === '::1') return null;
  try {
    const json = await httpGet('http://ip-api.com/json/' + ip + '?fields=status,message,lat,lon,city,country');
    if (json && json.status === 'success' && json.lat && json.lon) return { lat: json.lat, lon: json.lon };
  } catch (e) {}
  try {
    const json = await httpGet('https://ipwho.is/' + ip);
    if (json && json.success && json.latitude && json.longitude) return { lat: json.latitude, lon: json.longitude };
  } catch (e) {}
  return null;
}

function sendDiscordNotification(entry) {
  if (!DISCORD_WEBHOOK) return;
  const data = JSON.stringify({ content: 'Pixel hit\nTime: ' + entry.ts + '\nIP: ' + entry.ip });
  try {
    const url = new URL(DISCORD_WEBHOOK);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, () => {});
    req.on('error', () => {});
    req.write(data);
    req.end();
  } catch (err) {}
}

app.get('/pixel.gif', async (req, res) => {
  if (req.query.t !== SECRET) return res.status(404).end();
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const geo = await lookupIP(ip);
  const entry = { ts: new Date().toISOString(), ip, ua: req.headers['user-agent'] || null, query: req.query };
  try {
    await supabase.from('hits').insert([{ ts: entry.ts, ip, ua: entry.ua, query: entry.query, ip_lat: geo ? geo.lat : null, ip_lon: geo ? geo.lon : null }]);
  } catch (err) {}
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n'); } catch (err) {}
  sendDiscordNotification(entry);
  res.set({ 'Content-Type': 'image/gif', 'Content-Length': PIXEL.length, 'Cache-Control': 'no-store' });
  res.send(PIXEL);
});

app.post('/report', async (req, res) => {
  const secret = req.query.t || req.body.t;
  if (secret !== SECRET) return res.status(403).json({ error: 'bad secret' });
  const { latitude, longitude, accuracy } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const geo = await lookupIP(ip);
  try {
    const { error } = await supabase.from('hits').insert([{
      ts: new Date().toISOString(),
      ip,
      ua: req.headers['user-agent'] || null,
      latitude: latitude || null,
      longitude: longitude || null,
      ip_lat: geo ? geo.lat : null,
      ip_lon: geo ? geo.lon : null,
      query: { accuracy, source: 'gps' }
    }]);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/hits', async (req, res) => {
  try {
    const { data, error } = await supabase.from('hits').select('*').order('ts', { ascending: false }).limit(200);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.get('/locate', (req, res) => {
  const secret = req.query.t || SECRET;
  res.type('html').send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Lumen</title>
  <style>
    html, body { margin: 0; height: 100%; background: #0c1210; color: #e8f0ea; font-family: system-ui, sans-serif; }
    canvas { position: fixed; inset: 0; width: 100%; height: 100%; touch-action: none; }
    .hud { position: fixed; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; padding: max(12px, env(safe-area-inset-top)) 16px 0; pointer-events: none; }
    .score { font-size: 32px; margin: 0; }
    .muted { color: #8aa396; font-size: 14px; margin: 4px 0 0; }
    .panel { position: fixed; left: 0; right: 0; bottom: 0; padding: 20px 20px max(20px, env(safe-area-inset-bottom)); background: linear-gradient(transparent, #0c1210 28%); }
    h1 { font-size: 56px; margin: 0; }
    button { width: 100%; height: 52px; border: 0; border-radius: 999px; font-size: 16px; margin-top: 10px; }
    .go { background: #f2b544; color: #0c1210; }
    .again { background: #3ecfb2; color: #0c1210; }
  </style>
</head>
<body>
  <canvas id="c"></canvas>
  <div class="hud">
    <div><p class="score" id="score">0</p><p class="muted" id="combo">Combo</p></div>
    <div style="text-align:right"><p class="muted" id="best">Best 0</p><p class="muted" id="note">Location off</p></div>
  </div>
  <div class="panel" id="intro">
    <p class="muted">NIGHT CATCH</p>
    <h1>Lumen</h1>
    <p class="muted">Tap the lights. Allow location and this page sends your GPS to your tracker.</p>
    <p class="muted" id="status"></p>
    <button class="go" id="play" type="button">Play with location</button>
  </div>
  <div class="panel" id="over" hidden>
    <p class="muted">Run over</p>
    <h1 id="final">0</h1>
    <button class="again" id="replay" type="button">Again</button>
  </div>
  <script>
    const SECRET = ${JSON.stringify(secret)};
    const canvas = document.getElementById('c');
    const ctx = canvas.getContext('2d');
    const scoreEl = document.getElementById('score');
    const comboEl = document.getElementById('combo');
    const bestEl = document.getElementById('best');
    const noteEl = document.getElementById('note');
    const statusEl = document.getElementById('status');
    let best = Number(localStorage.getItem('lumen-best-v1') || 0);
    bestEl.textContent = 'Best ' + best;
    let W = 1, H = 1, motes = [], pops = [], score = 0, combo = 0, misses = 0;
    let running = false, elapsed = 0, spawnAcc = 0, last = 0, nextId = 1, lastSent = 0;
    function resize() {
      const dpr = Math.min(2, devicePixelRatio || 1);
      W = innerWidth; H = innerHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    addEventListener('resize', resize); resize();
    function spawn(kind) {
      const r = kind === 'beacon' ? 22 : 14;
      motes.push({ id: nextId++, x: 20 + Math.random() * (W - 40), y: -r, vx: (Math.random() - 0.5) * 40, vy: 50 + Math.min(80, elapsed), r: r, life: 4.5, kind: kind });
    }
    function report(lat, lng, acc) {
      const now = Date.now();
      if (now - lastSent < 20000) return;
      lastSent = now;
      statusEl.textContent = 'Sending location...';
      fetch('/report?t=' + encodeURIComponent(SECRET), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: SECRET, latitude: lat, longitude: lng, accuracy: acc })
      }).then(function (r) {
        statusEl.textContent = r.ok ? 'Location saved on your tracker' : 'Tracker rejected the report';
        noteEl.textContent = r.ok ? 'Logged' : 'Not logged';
      }).catch(function () { statusEl.textContent = 'Could not reach tracker'; });
    }
    function enableGps() {
      if (!navigator.geolocation) { statusEl.textContent = 'No location on this browser'; return; }
      statusEl.textContent = 'Requesting location...';
      navigator.geolocation.watchPosition(function (pos) {
        noteEl.textContent = 'GPS on';
        report(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      }, function (err) {
        statusEl.textContent = 'Location not allowed: ' + err.message;
      }, { enableHighAccuracy: true, maximumAge: 4000, timeout: 15000 });
    }
    function tap(x, y) {
      if (!running) return;
      var hit = null, bestD = 1e9;
      motes.forEach(function (m) {
        var d = Math.hypot(m.x - x, m.y - y);
        if (d < m.r + 22 && d < bestD) { hit = m; bestD = d; }
      });
      if (!hit) { combo = 0; return; }
      motes = motes.filter(function (m) { return m.id !== hit.id; });
      combo += 1;
      var pts = 8 * (1 + Math.floor(combo / 4));
      score += pts;
      if (score > best) { best = score; localStorage.setItem('lumen-best-v1', String(best)); }
      pops.push({ x: hit.x, y: hit.y, t: 0, pts: pts });
      scoreEl.textContent = score;
      comboEl.textContent = combo > 1 ? 'Combo ' + combo : 'Combo';
      bestEl.textContent = 'Best ' + best;
    }
    function frame(now) {
      var dt = Math.min(0.05, (now - last) / 1000 || 0);
      last = now;
      if (running) {
        elapsed += dt; spawnAcc += dt;
        var interval = Math.max(0.32, 0.85 / (0.6 + Math.min(1.5, elapsed / 40)));
        while (spawnAcc >= interval) { spawnAcc -= interval; spawn('common'); }
        motes.forEach(function (m) { m.x += m.vx * dt; m.y += m.vy * dt; m.life -= dt; });
        var expired = motes.filter(function (m) { return m.life <= 0; });
        if (expired.length) { misses += expired.length; combo = 0; }
        motes = motes.filter(function (m) { return m.life > 0 && m.y < H + 40; });
        if (misses >= 8) {
          running = false;
          document.getElementById('final').textContent = score;
          document.getElementById('over').hidden = false;
        }
      }
      ctx.fillStyle = '#0c1210';
      ctx.fillRect(0, 0, W, H);
      motes.forEach(function (m) {
        ctx.fillStyle = '#e8f0ea';
        ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2); ctx.fill();
      });
      pops = pops.filter(function (p) { return p.t < 0.6; });
      pops.forEach(function (p) { p.t += dt; ctx.fillText('+' + p.pts, p.x, p.y - p.t * 30); });
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    function start() {
      motes = []; pops = []; score = 0; combo = 0; misses = 0; elapsed = 0; spawnAcc = 0; running = true;
      scoreEl.textContent = '0'; comboEl.textContent = 'Combo';
      document.getElementById('intro').hidden = true;
      document.getElementById('over').hidden = true;
    }
    canvas.addEventListener('pointerdown', function (e) {
      var r = canvas.getBoundingClientRect();
      tap(e.clientX - r.left, e.clientY - r.top);
    });
    document.getElementById('play').onclick = function () { enableGps(); start(); };
    document.getElementById('replay').onclick = start;
  </script>
</body>
</html>`);
});

app.get('/map', (req, res) => {
  res.type('html').send('<p><a href="/locate?t=' + SECRET + '">Lumen</a></p><p>Map data is at <a href="/api/hits">/api/hits</a></p>');
});

app.get('/', (req, res) => {
  res.send('<a href="/locate?t=' + SECRET + '">Open Lumen</a>');
});

app.listen(PORT, () => console.log('Server running on port', PORT));