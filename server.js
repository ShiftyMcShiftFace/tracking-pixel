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
    #map { height: 75vh; }
    #info {
      position: absolute; top: 10px; left: 10px; z-index: 1000;
      background: white; padding: 12px 16px; border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.15); max-width: 340px;
      font-size: 14px; line-height: 1.4;
    }
    #unplotted {
      padding: 12px 16px; background: #f8f8f8; border-top: 1px solid #ddd;
      max-height: 25vh; overflow-y: auto; font-size: 13px;
    }
  </style>
</head>
<body>
  <div id="info"><strong>Tracking Pixel Map</strong><br>Loading...</div>
  <div id="map"></div>
  <div id="unplotted">Checking locations...</div>

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const map = L.map('map').setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(map);

    const info = document.getElementById('info');
    const unplottedDiv = document.getElementById('unplotted');

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

        // Deduplicate by IP (keep the most recent)
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
        const failed = [];

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
          } else {
            failed.push(hit.ip);
          }
        }

        info.innerHTML += '<br><b>Plotted:</b> ' + plotted;

        if (failed.length) {
          unplottedDiv.innerHTML = '<strong>Could not locate these IPs (' + failed.length + '):</strong><br>' +
            failed.slice(0, 20).join('<br>') +
            (failed.length > 20 ? '<br>…and ' + (failed.length - 20) + ' more' : '');
        } else {
          unplottedDiv.innerHTML = 'All unique IPs were plotted.';
        }
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