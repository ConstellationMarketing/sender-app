'use strict';

// Thin Mailgun client. Sends one email at a time via the HTTP API.
// Env vars: MAILGUN_API_KEY, MAILGUN_DOMAIN, MAILGUN_FROM.

const MAILGUN_BASE = 'https://api.mailgun.net/v3';

function ensureEnv() {
  const key = process.env.MAILGUN_API_KEY;
  const domain = process.env.MAILGUN_DOMAIN;
  const from = process.env.MAILGUN_FROM;
  if (!key) throw new Error('MAILGUN_API_KEY not set');
  if (!domain) throw new Error('MAILGUN_DOMAIN not set');
  if (!from) throw new Error('MAILGUN_FROM not set');
  return { key, domain, from };
}

// Fill {{merge_var}} placeholders in a template using a row of values.
// Values not in the row leave the placeholder visible so the writer notices.
function applyMergeVars(template, row) {
  if (!template || !row) return template || '';
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = row[key];
    return v == null ? `{{${key}}}` : String(v);
  });
}

async function sendOne({ to, subject, html, text }) {
  const { key, domain, from } = ensureEnv();
  const body = new URLSearchParams();
  body.set('from', from);
  body.set('to', to);
  body.set('subject', subject || '(no subject)');
  if (html) body.set('html', html);
  if (text) body.set('text', text);

  const auth = 'Basic ' + Buffer.from(`api:${key}`).toString('base64');
  const r = await fetch(`${MAILGUN_BASE}/${encodeURIComponent(domain)}/messages`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text2 = await r.text();
  let json = null; try { json = JSON.parse(text2); } catch {}
  if (!r.ok) {
    const msg = (json && json.message) || text2 || `Mailgun ${r.status}`;
    throw new Error(`Mailgun ${r.status}: ${msg}`);
  }
  return json || { id: '', message: 'queued' };
}

module.exports = { sendOne, applyMergeVars, ensureEnv };
