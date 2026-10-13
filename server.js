const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CHANGE THESE TWO VALUES =====
const SECRET = process.env.PIXEL_SECRET || 'Im-gonna-find-you-there-you-are';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || 'https://discord.com/api/webhooks/1559584885478391898/W-gXT43UoDrSpcuKXiP-aklz2E_Y0RzwLxGlb4lVIW3BJD7VZgPBivUgkn80NrBq-IBV';
// ==================================

const LOG_FILE = path.join(__dirname, 'pixel-log.jsonl');

// 1×1 transparent GIF
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

function sendDiscordNotification(entry) {
  if (!DISCORD_WEBHOOK || DISCORD_WEBHOOK.includes('PASTE_YOUR')) return;

  const content = {
    content: `📍 **Pixel Hit**\n` +
             `**Time:** ${entry.ts}\n` +
             `**IP:** ${entry.ip}\n` +
             `**User-Agent:** ${entry.ua || 'unknown'}\n` +
             `**Extra:** ${JSON.stringify(entry.query)}`
  };

  const data = JSON.stringify(content);

  const url = new URL(DISCORD_WEBHOOK);
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length
    }
  };

  const req = https.request(options, (res) => {
    // optional
  });

  req.on('error', (err) => {
    console.error('Discord error:', err.message);
  });

  req.write(data);
  req.end();
}

app.get('/pixel.gif', (req, res) => {
  if (req.query.t !== SECRET) {
    return res.status(404).end();
  }

  const entry = {
    ts: new Date().toISOString(),
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
    ua: req.headers['user-agent'] || null,
    referer: req.headers.referer || null,
    query: req.query
  };

  // Save to log file
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('Log write error:', err.message);
  }

  // Send Discord notification
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