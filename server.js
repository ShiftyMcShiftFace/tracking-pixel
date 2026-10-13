const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const SECRET = process.env.PIXEL_SECRET || 'test123';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';

const LOG_FILE = path.join(__dirname, 'pixel-log.jsonl');

const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

function sendDiscordNotification(entry) {
  console.log('Attempting to send Discord notification...');
  console.log('Webhook present:', !!DISCORD_WEBHOOK);

  if (!DISCORD_WEBHOOK) {
    console.log('No DISCORD_WEBHOOK set – skipping');
    return;
  }

  const content = {
    content: `📍 **Pixel Hit**\n` +
             `**Time:** ${entry.ts}\n` +
             `**IP:** ${entry.ip}\n` +
             `**User-Agent:** ${entry.ua || 'unknown'}\n` +
             `**Extra:** ${JSON.stringify(entry.query)}`
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

    const req = https.request(options, (res) => {
      console.log('Discord response status:', res.statusCode);
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 204) {
          console.log('Discord response body:', body);
        }
      });
    });

    req.on('error', (err) => {
      console.error('Discord request error:', err.message);
    });

    req.write(data);
    req.end();
  } catch (err) {
    console.error('Discord setup error:', err.message);
  }
}

app.get('/pixel.gif', (req, res) => {
  if (req.query.t !== SECRET) {
    console.log('Wrong secret – returning 404');
    return res.status(404).end();
  }

  const entry = {
    ts: new Date().toISOString(),
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
    ua: req.headers['user-agent'] || null,
    referer: req.headers.referer || null,
    query: req.query
  };

  console.log('Pixel hit from IP:', entry.ip);

  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('Log write error:', err.message);
  }

  sendDiscordNotification(entry);

  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': PIXEL.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.send(PIXEL);
});

app.get('/', (req, res) => {
  res.send('Tracking pixel server is running. Use /pixel.gif?t=YOUR_SECRET');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});