'use strict';

// Sender — standalone Node.js service for the OS bots list.
// Express server that serves a static frontend at / and JSON API at /api/*.
//
// Runs locally on http://localhost:3010 by default. Same pattern as SPR0
// and Meerkat: PM2 keeps it alive on the VPS, Cloudflare Tunnel exposes it
// at sender.goconstellation.com, and the OS bots list iframes that URL.

require('dotenv').config();

const path = require('path');
const express = require('express');
const apiRouter = require('./routes/api');

const app = express();
const PORT = Number(process.env.PORT) || 3010;

app.use(express.json({ limit: '10mb' }));

// CORS — allow the OS app's origins (and localhost for dev).
const allowed = (process.env.ALLOWED_ORIGINS || 'https://os.goconstellation.com,http://localhost:8788')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// /healthz — convenience alias for the wiki, which documents this URL.
// The full env-var snapshot lives at /api/health; /healthz just confirms
// the Node process + Express stack are alive so an external uptime monitor
// can ping it cheaply without touching Supabase.
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'sender', ts: Date.now() });
});

// API
app.use('/api', apiRouter);

// JSON 500 for anything that throws inside an /api/* handler. Without this,
// an unhandled rejection (e.g. missing env var) would crash the Node process
// and subsequent requests would fail with ERR_CONNECTION_REFUSED.
app.use('/api', (err, _req, res, _next) => {
  console.error('[sender] api error:', err);
  res.status(500).json({ error: err.message || 'Server error' });
});

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback — anything not /api/* serves index.html
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[sender] listening on http://localhost:${PORT}`);
});
