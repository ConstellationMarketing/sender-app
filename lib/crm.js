'use strict';

// Pulls active + onboarding clients from the OS CRM (which is the same
// data shown at https://os.goconstellation.com/crm). The OS CRM page is
// itself just a frontend on top of the ClickUp "Client Information" list —
// ClickUp is the source of truth for clients + assignees, and the OS CRM
// page reads it live, so we read it the same way here.
//
// Env vars (these already exist on the VPS for meerkat/content-engine/etc.,
// the Sender just reuses them — no new setup needed):
//
//   CLICKUP_API_KEY      — Constellation's ClickUp PAT. REQUIRED.
//   CRM_CLICKUP_LIST_ID  — numeric ClickUp list id for Client Information.
//                          Defaults to '901703957188' (matches the OS CRM
//                          fallback in functions/crm-api/_lib/clickup.js).
//
// Custom-field column names we look for inside each ClickUp task (in order;
// first non-empty wins). These don't need env vars — the candidate list
// covers the common variations the team has used over time.

const CLICKUP_BASE = 'https://api.clickup.com/api/v2';
const DEFAULT_LIST_ID = '901703957188';   // matches OS CRM fallback

// Statuses pulled from ClickUp's Client Information list. Sender treats any
// of these as a sendable relationship — they're the clients we have an
// active obligation to (Live = doing full marketing for them, Onboarding =
// brand new, Hosting Only = retained for website hosting). Anything else
// (churned, lost, paused, etc.) is excluded.
const WANT_STATUSES = new Set([
  'active',
  'onboarding',
  'live',
  'hosting only',
  'hosting-only',
  'hosting_only',
  'hosting',
]);

// Candidate ClickUp custom-field names (case-insensitive substring match).
// We use substring rather than exact match so "Primary Contact Email" and
// "Contact Email — Primary" both resolve to the same email lookup.
const EMAIL_FIELD_NEEDLES = ['primary contact email', 'contact email', 'email'];
const FIRM_FIELD_NEEDLES  = ['firm', 'company'];
// Contact-first-name lookup. ClickUp's Client Information list uses a
// mix of names ('Client First Name', 'Primary Contact First Name',
// 'Contact First Name') across historical tasks. We try each substring
// in order and take the first non-empty value. If nothing matches, the
// column stays NULL and buildMergeRow falls back to firstWord(name),
// which is the pre-existing behavior (firm-name-based greeting).
//
// A common failure mode we've seen: writers put the full contact name
// (e.g. "Andrew Taylor") in a "Primary Contact" field. The plain word
// 'contact' matches that too — we strip past the first whitespace-run
// via firstWord() when populating, so "Andrew Taylor" → "Andrew".
const FIRST_NAME_FIELD_NEEDLES = [
  'client first name',
  'primary contact first name',
  'contact first name',
  'first name',
  'primary contact',
  'main contact',
];

function getKey() {
  const k = process.env.CLICKUP_API_KEY;
  if (!k) throw new Error('CLICKUP_API_KEY not set — needed to read the OS CRM (ClickUp Client Information list).');
  return k;
}

function getListId() {
  return (process.env.CRM_CLICKUP_LIST_ID || DEFAULT_LIST_ID).trim();
}

async function cuFetch(path) {
  const r = await fetch(`${CLICKUP_BASE}${path}`, {
    headers: {
      'Authorization': getKey(),
      'Accept': 'application/json',
    },
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const msg = (json && (json.err || json.error)) || text || r.statusText;
    throw new Error(`ClickUp ${r.status} ${path}: ${msg}`);
  }
  return json;
}

// Find a custom field by trying each needle in order. Returns trimmed
// string value or '' if no match. Substring + case-insensitive.
function findCustomField(task, needles) {
  if (!Array.isArray(task.custom_fields)) return '';
  for (const needle of needles) {
    const lc = needle.toLowerCase();
    for (const f of task.custom_fields) {
      if (!String(f.name || '').toLowerCase().includes(lc)) continue;
      if (f.value == null) continue;
      const v = typeof f.value === 'object' ? (f.value.email || f.value.text || '') : String(f.value);
      const s = v.trim();
      if (s) return s;
    }
  }
  return '';
}

/**
 * Fetch active + onboarding clients from the OS CRM (ClickUp). Paginates
 * the ClickUp list endpoint (100 tasks/page) until exhausted.
 *
 * Returns an array of normalized client objects:
 *   { id, name, email, firm, status, assignees: [{ id, name, email }] }
 *
 * The `assignees` array preserves ClickUp's `username` + `email` per
 * assignee, so the sync code in routes/api.js can match the FIXED_LISTS
 * names (Luiza / Federico / Alejandra) against either field — works for
 * teammates whose ClickUp display name is just "Luiza" AND for the
 * ones whose only identifier is luiza@goconstellation.com.
 */
async function fetchActiveClients() {
  const listId = getListId();
  const out = [];

  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      page: String(page),
      archived: 'false',
      subtasks: 'false',
      include_closed: 'true',
    });
    const data = await cuFetch(`/list/${encodeURIComponent(listId)}/task?${params.toString()}`);
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
    for (const t of tasks) {
      const status = String(t?.status?.status || '').toLowerCase();
      if (!WANT_STATUSES.has(status)) continue;

      // Hosting / onboarding clients often don't have a contact-email field
      // filled in yet, but the team still wants them visible in the All
      // Clients table so they can track them. We synthesize a placeholder
      // "email" per-task (using the ClickUp task id) so each row gets a
      // unique value for the upsert's onConflict key, while still rendering
      // as "no email" in the UI (the splitEmails regex won't match this
      // placeholder, so no clickable address is shown) and being auto-
      // skipped at send time (splitEmails → [] → recorded as failed).
      let email = findCustomField(t, EMAIL_FIELD_NEEDLES);
      if (!email) {
        email = `(no-email-clickup-${t.id})`;
      }

      const firm = findCustomField(t, FIRM_FIELD_NEEDLES) || String(t.name || '');

      // Contact first name: take whatever the field has and reduce to the
      // first whitespace-separated token. Camila's fields sometimes have a
      // full name ("Andrew Taylor") in a Primary Contact field, sometimes
      // just a first name in a "Client First Name" field — either shape
      // resolves to "Andrew" here.
      const contactNameRaw = findCustomField(t, FIRST_NAME_FIELD_NEEDLES);
      const first_name = String(contactNameRaw || '').trim().split(/\s+/)[0] || '';

      const assignees = (t.assignees || []).map(a => ({
        id:    a.id,
        name:  a.username || a.email || '',
        email: a.email || '',
      }));

      // Preserve the real ClickUp status (lowercased) instead of squashing
      // everything to 'active'. The frontend renders this as a pill, so the
      // raw value also doubles as the CSS class suffix (pill-onboarding,
      // pill-live, pill-active).
      out.push({
        id:     String(t.id),
        name:   String(t.name || ''),
        first_name,
        email,
        firm,
        status,
        assignees,
      });
    }
    if (tasks.length < 100) break;
  }
  return out;
}

module.exports = { fetchActiveClients };
