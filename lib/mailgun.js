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

// Build a full 22-key mergeRow for a given recipient + optional batch.
// Shared between real batch-send, test-send, and preview so every code
// path substitutes the same variables. Missing inputs default to '' —
// applyMergeVars() will render '' where the template had the tag.
//
// Args:
//   recipient    — the sender_clients_recipients row (or a subset)
//                  Expected keys: name, first_name, email, firm,
//                                 account_manager, status, client_hub, tags
//   batch        — optional. the sender_sends_batches row (has owner,
//                  which we treat as the sender identity)
//   sender       — optional. the users_profiles row for the batch's owner
//                  (id, full_name, email, calendar_url). When present, it
//                  provides {{sender_email}} and {{calendar_url}} directly
//                  instead of the "{first}@goconstellation.com" derivation.
//   crmClient    — optional. the CRM `client` row joined by name.
//                  Provides website, ga4_property_id, ahrefs_project_id.
//   overrides    — optional. any key here wins over the computed value
//                  (used by test-send to force a particular email addr).
//
// Returns a plain object with all 23 keys.
function buildMergeRow({ recipient = {}, batch = null, sender = null, crmClient = null, overrides = {} } = {}) {
  const now = new Date();
  const monthNames = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December',
  ];
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const firstWord = (s) => String(s || '').trim().split(/\s+/)[0] || '';
  const shortFirm = (s) => {
    // Drop trailing entity suffixes (PLLC, PC, LLP, LLC, Inc., etc.) then
    // return the first meaningful word.
    const cleaned = String(s || '')
      .replace(/\s*(?:,?\s*(?:P\.?L\.?L\.?C\.?|P\.?C\.?|L\.?L\.?P\.?|L\.?L\.?C\.?|Inc\.?|Ltd\.?|LTD|Co\.?)\.?\s*)+$/i, '')
      .trim();
    return firstWord(cleaned) || firstWord(s);
  };
  // Sender identity — prefer the joined users_profiles row when caller
  // provided it (has real email + calendar_url). Fall back to the batch's
  // stored owner string, then to the pre-existing "Constellation Marketing"
  // default so old batches without an owner still render sanely.
  const senderName  = sender?.full_name || batch?.owner || 'Constellation Marketing';
  const senderFirst = firstWord(senderName);
  const senderEmail = sender?.email
    || batch?.owner_email
    || (senderFirst && senderFirst !== 'Constellation'
        ? `${senderFirst.toLowerCase()}@goconstellation.com`
        : 'reports@goconstellation.com');
  const calendarUrl = sender?.calendar_url || '';

  const row = {
    // ── Client identity ─────────────────────────────────────
    name:               recipient.name || '',
    // {{first_name}} — the greeting name in every existing template.
    // Historically resolved to firstWord(name), which turned firm-only
    // task titles into a wrong-looking greeting ("KC" for KC Immigration,
    // "Andrew" for Andrew Taylor Trial Attorneys — luck-of-the-draw
    // whether the first word is a real person's name or just the firm's
    // initials/branding). Camila asked (2026-08-20) to use the FULL firm
    // name instead — "Hi KC Immigration," reads consistently across the
    // whole client roster and requires zero template edits.
    //
    // Precedence:
    //   1. recipient.first_name — set only if the ClickUp task has a
    //      matching custom field (see FIRST_NAME_FIELD_NEEDLES in
    //      lib/crm.js). Wins if present so any future opt-in to real
    //      first names still works.
    //   2. recipient.firm       — the firm custom field, when populated.
    //   3. recipient.name       — the ClickUp task title (always set).
    first_name:         (recipient.first_name || '').trim() || recipient.firm || recipient.name || '',
    client_name:        recipient.name || '',
    firm:               recipient.firm || '',
    firm_short:         shortFirm(recipient.firm),
    email:              recipient.email || '',
    status:             recipient.status || '',
    account_manager:    recipient.account_manager || '',
    client_hub:         recipient.client_hub || '',

    // ── Dates (computed at send time) ────────────────────────
    today:              now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    today_short:        `${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')}/${now.getFullYear()}`,
    current_month:      monthNames[now.getMonth()],
    current_month_year: `${monthNames[now.getMonth()]} ${now.getFullYear()}`,
    last_month:         monthNames[lastMonthDate.getMonth()],
    last_month_year:    `${monthNames[lastMonthDate.getMonth()]} ${lastMonthDate.getFullYear()}`,
    current_year:       String(now.getFullYear()),

    // ── Sender identity ─────────────────────────────────────
    sender_name:        senderName,
    sender_first_name:  senderFirst,
    sender_email:       senderEmail,

    // ── Constellation constants ─────────────────────────────
    constellation:      'Constellation Marketing',
    support_email:      'support@goconstellation.com',

    // ── Sender scheduling link ──────────────────────────────
    // {{calendar_url}} — Calendly / Cal.com / etc. link for the batch
    // owner. Populated from users_profiles.calendar_url when a sender
    // profile is passed in. Empty string if the sender has no
    // calendar_url set, so drafts can still ship without a "Book a
    // call" section rather than showing a broken href.
    calendar_url:       calendarUrl,

    // ── Client dashboards (from CRM) ────────────────────────
    website:            crmClient?.website || '',
    ga4_property_id:    crmClient?.ga4_property_id || '',
    ahrefs_project_id:  crmClient?.ahrefs_project_id || '',

    // ── Live leads (from spr.metric_monthly for the current month) ──
    // Populated by fetchCrmClientForRecipient in routes/api.js. If the
    // SPR pipeline hasn't aggregated this month yet OR the client isn't
    // in metric_monthly, this renders empty in the email. Preview mode
    // uses a sample value from SAMPLE_MERGE in public/index.html so the
    // preview still shows a plausible number.
    leads:              crmClient?.leads != null ? String(crmClient.leads) : '',
  };

  return { ...row, ...overrides };
}

module.exports = { sendOne, applyMergeVars, ensureEnv, buildMergeRow };
