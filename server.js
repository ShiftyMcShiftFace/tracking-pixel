const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.get('/pixel.gif', async (req, res) => {
  if (req.query.t !== SECRET) return res.status(404).end();

  const entry = {
    ts: new Date().toISOString(),
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
    ua: req.headers['user-agent'] || null,
    query: req.query
  };

  try {
    await supabase.from('hits').insert([{
      ts: entry.ts,
      ip: entry.ip,
      ua: entry.ua,
      query: entry.query
    }]);
  } catch (err) {
    console.error('Supabase insert error:', err.message);
  }

  try { fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n'); } catch (err) {}
  sendDiscordNotification(entry);

  res.set({ 'Content-Type': 'image/gif', 'Content-Length': PIXEL.length, 'Cache-Control': 'no-store' });
  res.send(PIXEL);
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
    console.error('Supabase fetch error:', err.message);
    res.status(500).json([]);
  }
});

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
    #table-container {
      padding: 16px;
      background: #fafafa;
      border-top: 1px solid #ddd;
      max-height: 40vh;
      overflow-y: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid #eee;
    }
    th {
      background: #f0f0f0;
      position: sticky;
      top: 0;
    }
    tr:hover { background: #f5f5f5; }
  </style>
</head>
<body>
  <div id="info"><strong>Tracking Pixel Map</strong><br>Loading...</div>
  <div id="map"></div>
  <div id="table-container">
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>IP Address</th>
          <th>User-Agent</th>
        </tr>
      </thead>
      <tbody id="hits-table"></tbody>
    </table>
  </div>

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const map = L.map('map').setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(map);

    const info = document.getElementById('info');
    const tbody = document.getElementById('hits-table');

    async function geolocate(ip) {
      try {
        const r = await fetch('https://ipapi.co/' + ip + '/json/');
        if (r.ok) {
          const d = await r.json();
          if (d.latitude && d.longitude) return d;
        }
      } catch (e) {}
      try {
        const r = await fetch('https://ipwho.is/' + ip);
        if (r.ok) {
          const d = await r.json();
          if (d.success && d.latitude && d.longitude) {
            return { latitude: d.latitude, longitude: d.longitude, city: d.city, country_name: d.country };
          }
        }
      } catch (e) {}
      return null;
    }

    async function loadHits() {
      try {
        const res = await fetch('/api/hits');
        const data = await res.json();

        // Deduplicate by IP for the map (keep most recent)
        const unique = {};
        data.forEach(h => {
          if (!unique[h.ip] || new Date(h.ts) > new Date(unique[h.ip].ts)) {
            unique[h.ip] = h;
          }
        });
        const uniqueHits = Object.values(unique);

        info.innerHTML = '<strong>Tracking Pixel Map</strong><br>' +
                         data.length + ' total hits<br>' +
                         uniqueHits.length + ' unique IPs';

        let plotted = 0;
        for (const hit of uniqueHits) {
          const geo = await geolocate(hit.ip);
          if (geo && geo.latitude && geo.longitude) {
            const marker = L.marker([geo.latitude, geo.longitude]).addTo(map);
            marker.bindPopup(
              '<b>IP:</b> ' + hit.ip + '<br>' +
              '<b>Last seen:</b> ' + new Date(hit.ts).toLocaleString() + '<br>' +
              '<b>Location:</b> ' + (geo.city || '') + ', ' + (geo.country_name || '')
            );
            plotted++;
          }
        }
        info.innerHTML += '<br><b>Plotted:</b> ' + plotted;

        // Fill the table with ALL hits
        tbody.innerHTML = '';
        data.forEach(hit => {
          const tr = document.createElement('tr');
          const time = new Date(hit.ts).toLocaleString();
          const ua = (hit.ua || '').substring(0, 80) + ((hit.ua || '').length > 80 ? '…' : '');
          tr.innerHTML = '<td>' + time + '</td><td>' + hit.ip + '</td><td>' + ua + '</td>';
          tbody.appendChild(tr);
        });

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
  res.send('Tracking pixel server is running.<br><a href="/map">Open Map</a>');
});

app.listen(PORT, () => console.log('Server running on port', PORT));