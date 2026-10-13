const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// CHANGE THIS to a long random string (at least 32 characters)
const SECRET = process.env.PIXEL_SECRET || 'Im-gonna-find-you-there-you-are';

const LOG_FILE = path.join(__dirname, 'pixel-log.jsonl');

// 1×1 transparent GIF
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

app.get('/pixel.gif', (req, res) => {
  // Simple secret check
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

  // Write one line to the log file
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');

  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': PIXEL.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.send(PIXEL);
});

// Simple status page so you can check the server is alive
app.get('/', (req, res) => {
  res.send('Tracking pixel server is running. Use /pixel.gif?t=YOUR_SECRET');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});