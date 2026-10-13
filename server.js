const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const SECRET = process.env.PIXEL_SECRET || 'test123';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';

const LOG_FILE = path.join(__dirname, 'pixel-log.jsonl');

// Keep the last 100 hits in memory so the map can show them
let hits = [];

const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

function sendDiscordNotification(entry) {
  if (!DISCORD_WEBHOOK) return;

  const content = {
    content: `📍 **Pixel Hit**\n**Time:** ${entry.ts}\n**IP:** ${entry.ip}\n**User-Agent:** ${entry.ua || 'unknown'}`
  };

  const data = JSON.stringify(content);

  try {
    const url = new URL(DISCORD_WEBHOOK);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, () => {});
    req.on('error', () => {});
    req.write(data);
    req.end();
  } catch (err) {}
}

// Tracking pixel
app.get('/pixel.gif', (req, res) => {
  if (req.query.t !== SECRET) {
    return res.status(404).end();
  }

  const entry = {
    ts: new Date().toISOString(),
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
    ua: req.headers['user-agent'] || null,
    query: req.query
  };

  // Save to memory (for the map)
  hits.unshift(entry);
  if (hits.length > 100) hits.pop();

  // Also save to file
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {}

  sendDiscordNotification(entry);

  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': PIXEL.length,
    'Cache-Control': 'no-store'
  });
  res.send(PIXEL);
});

// API that the map page will call
app.get('/api/hits', (req, res) => {
  res.json(hits);
});

// The map page
app.get('/map', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Tracking Pixel Map</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    body { margin: 0; font-family: sans-serif; }
    #map { height: 100vh; }
    #info {
      position: absolute; top: 10px; left: 10px; z-index: 1000;
      background: white; padding: 10px 15px; border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2); max-width: 300px;
    }
  </style>
</head>
<body>
  <div id="info">
    <strong>Tracking Pixel Map</strong><br>
    Loading hits...
  </div>
  <div id="map"></div>

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const map = L.map('map').setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(map);

    const info = document.getElementById('info');

    async function loadHits() {
      try {
        const res = await fetch('/api/hits');
        const data = await res.json();

        info.innerHTML = '<strong>Tracking Pixel Map</strong><br>' + data.length + ' hits loaded';

        for (const hit of data) {
          // Free IP geolocation (no API key needed for low volume)
          try {
            const geoRes = await fetch('https://ipapi.co/' + hit.ip + '/json/');
            const geo = await geoRes.json();

            if (geo.latitude && geo.longitude) {
              const marker = L.marker([geo.latitude, geo.longitude]).addTo(map);
              marker.bindPopup(
                '<b>IP:</b> ' + hit.ip + '<br>' +
                '<b>Time:</b> ' + new Date(hit.ts).toLocaleString() + '<br>' +
                '<b>Location:</b> ' + (geo.city || '') + ', ' + (geo.country_name || '') + '<br>' +
                '<b>ISP:</b> ' + (geo.org || 'unknown')
              );
            }
          } catch (e) {
            console.log('Geo lookup failed for', hit.ip);
          }
        }
      } catch (err) {
        info.innerHTML = 'Error loading hits';
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

app.listen(PORT, () => {
  console.log('Server running on port', PORT);
});