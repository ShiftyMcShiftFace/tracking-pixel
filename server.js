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
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function lookupIP(ip) {
  if (!ip || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.') || ip === '::1') {
    console.log('Skipping private/local IP:', ip);
    return null;
  }

  // Primary: ip-api.com
  try {
    const json = await httpGet(`http://ip-api.com/json/${ip}?fields=status,message,lat,lon,city,country`);
    if (json && json.status === 'success' && json.lat && json.lon) {
      console.log('ip-api.com success for', ip);
      return { lat: json.lat, lon: json.lon, city: json.city, country: json.country, source: 'ip-api' };
    } else {
      console.log('ip-api.com failed for', ip, json?.message || '');
    }
  } catch (e) {
    console.log('ip-api.com exception:', e.message);
  }

  // Fallback 1: ipapi.co
  try {
    const json = await httpGet(`https://ipapi.co/${ip}/json/`);
    if (json && json.latitude && json.longitude) {
      console.log('ipapi.co success for', ip);
      return { lat: json.latitude, lon: json.longitude, city: json.city, country: json.country_name, source: 'ipapi' };
    } else {
      console.log('ipapi.co no coords for', ip);
    }
  } catch (e) {
    console.log('ipapi.co exception:', e.message);
  }

  // Fallback 2: ipwho.is
  try {
    const json = await httpGet(`https://ipwho.is/${ip}`);
    if (json && json.success && json.latitude && json.longitude) {
      console.log('ipwho.is success for', ip);
      return { lat: json.latitude, lon: json.longitude, city: json.city, country: json.country, source: 'ipwho' };
    } else {
      console.log('ipwho.is failed for', ip);
    }
  } catch (e) {
    console.log('ipwho.is exception:', e.message);
  }

  console.log('All geolocation services failed for IP:', ip);
  return null;
}

function sendDiscordNotification(entry) {
  if (!DISCORD_WEBHOOK) return;
  const content = { content: `📍 **Pixel Hit**\n**Time:** ${entry.ts}\n**IP:** ${entry.ip}` };
  const data = JSON.stringify(content);
  try {
    const url = new URL(DISCORD_WEBHOOK);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, () => {});
    req.on('error', () => {});
    req.write(data);
    req.end();
  } catch (err) {}
}

// Tracking pixel (IP only)
app.get('/pixel.gif', async (req, res) => {
  if (req.query.t !== SECRET) return res.status(404).end();

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  const entry = {
    ts: new Date().toISOString(),
    ip,
    ua: req.headers['user-agent'] || null,
    query: req.query
  };

  const geo = await lookupIP(ip);
  if (geo) console.log('Geo success for', ip, 'via', geo.source, geo.lat, geo.lon);

  try {
    const { error } = await supabase.from('hits').insert([{
      ts: entry.ts,
      ip: entry.ip,
      ua: entry.ua,
      query: entry.query,
      ip_lat: geo ? geo.lat : null,
      ip_lon: geo ? geo.lon : null
    }]);
    if (error) console.error('IP insert error:', error.message);
  } catch (err) {
    console.error('Supabase IP error:', err.message);
  }

  try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n'); } catch (err) {}
  sendDiscordNotification(entry);

  res.set({ 'Content-Type': 'image/gif', 'Content-Length': PIXEL.length, 'Cache-Control': 'no-store' });
  res.send(PIXEL);
});

// GPS + IP from the locate page
app.post('/report', async (req, res) => {
  const secret = req.query.t || req.body.t;
  if (secret !== SECRET) return res.status(403).json({ error: 'bad secret' });

  const { latitude, longitude, accuracy } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

  // Also look up the IP location
  const geo = await lookupIP(ip);
  if (geo) console.log('IP geo on GPS report for', ip, 'via', geo.source);

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
    const { data, error } = await supabase
      .from('hits')
      .select('*')
      .order('ts', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json([]);
  }
});

// Auto location page
app.get('/locate', (req, res) => {
  const secret = req.query.t || 'test123';
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Location Reporter</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 40px auto; padding: 20px; text-align: center; }
    #status { margin-top: 20px; font-size: 16px; }
  </style>
</head>
<body>
  <h2>Location Reporter</h2>
  <p>Automatically requesting location...</p>
  <div id="status">Starting...</div>
  <script>
    const status = document.getElementById('status');
    const secret = ${JSON.stringify(secret)};
    function sendLocation() {
      if (!navigator.geolocation) { status.textContent = 'Geolocation not supported'; return; }
      status.textContent = 'Requesting location...';
      navigator.geolocation.getCurrentPosition(async pos => {
        status.textContent = 'Got location, sending...';
        const payload = { t: secret, latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy };
        try {
          const r = await fetch('/report?t=' + encodeURIComponent(secret), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const text = await r.text();
          status.textContent = r.ok ? 'Location sent successfully' : 'Server error: ' + text;
        } catch (e) { status.textContent = 'Network error: ' + e.message; }
      }, err => { status.textContent = 'Location error: ' + err.message; },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    }
    sendLocation();
  </script>
</body>
</html>`);
});

// Map page
app.get('/map', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Tracking Pixel Map</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; }
    #map { height: 60vh; }
    #info {
      position: absolute; top: 10px; left: 10px; z-index: 1000;
      background: white; padding: 12px 16px; border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.15); max-width: 340px;
      font-size: 14px; line-height: 1.4;
    }
    #table-container { padding: 16px; background: #fafafa; border-top: 1px solid #ddd; max-height: 40vh; overflow-y: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eee; }
    th { background: #f0f0f0; position: sticky; top: 0; }
  </style>
</head>
<body>
  <div id="info"><strong>Tracking Pixel Map</strong><br>Loading...</div>
  <div id="map"></div>
  <div id="table-container">
    <table>
      <thead><tr><th>Time</th><th>Type</th><th>IP</th><th>Coords / UA</th></tr></thead>
      <tbody id="hits-table"></tbody>
    </table>
  </div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const map = L.map('map').setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(map);

    const redIcon = new L.Icon({
      iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png',
      shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
      iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
    });

    const blueIcon = new L.Icon({
      iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-blue.png',
      shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
      iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
    });

    const info = document.getElementById('info');
    const tbody = document.getElementById('hits-table');

    async function loadHits() {
      try {
        const res = await fetch('/api/hits');
        const data = await res.json();
        let gpsCount = 0;
        let ipCount = 0;

        tbody.innerHTML = '';
        for (const hit of data) {
          const time = new Date(hit.ts).toLocaleString();
          const isGps = hit.latitude != null && hit.longitude != null;
          const hasIpGeo = hit.ip_lat != null && hit.ip_lon != null;

          if (isGps) gpsCount++;
          if (hasIpGeo && !isGps) ipCount++;

          const tr = document.createElement('tr');
          tr.innerHTML = '<td>' + time + '</td><td>' + (isGps ? 'GPS' : 'IP') + '</td><td>' + hit.ip + '</td><td>' +
            (isGps ? hit.latitude.toFixed(5) + ', ' + hit.longitude.toFixed(5) :
             hasIpGeo ? hit.ip_lat.toFixed(5) + ', ' + hit.ip_lon.toFixed(5) : (hit.ua || '').substring(0, 50)) + '</td>';
          tbody.appendChild(tr);

          if (isGps) {
            L.marker([hit.latitude, hit.longitude], { icon: redIcon })
              .addTo(map)
              .bindPopup('<b>GPS</b><br>' + hit.ip + '<br>' + time);
          } else if (hasIpGeo) {
            L.marker([hit.ip_lat, hit.ip_lon], { icon: blueIcon })
              .addTo(map)
              .bindPopup('<b>IP estimate</b><br>' + hit.ip + '<br>' + time);
          }
        }
        info.innerHTML = '<strong>Tracking Pixel Map</strong><br>' +
                         data.length + ' hits<br>' +
                         '<span style="color:#d33">●</span> GPS: ' + gpsCount + '<br>' +
                         '<span style="color:#3388ff">●</span> IP: ' + ipCount;
      } catch (err) {
        info.innerHTML = 'Error: ' + err.message;
      }
    }
    loadHits();
  </script>
</body>
</html>`);
});

app.get('/', (req, res) => {
  res.send('Tracking pixel server is running.<br><a href="/map">Open Map</a><br><a href="/locate?t=' + SECRET + '">Send GPS Location</a>');
});

app.listen(PORT, () => console.log('Server running on port', PORT));