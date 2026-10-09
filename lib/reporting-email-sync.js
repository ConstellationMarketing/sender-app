'use strict';

// Reporting-email sync — makes the OS CRM the single source of truth for the
// report send-to address.
//
// The Sender sends ONLY to reporting_email (policy 2026-09-02). The canonical
// value lives in the OS CRM at public.client.reporting_email. This job copies
// that value into sender_clients_recipients.reporting_email, matched by ClickUp
// task id (client.clickup_ticket_id == recipient.clickup_task_id — the stable
// key, immune to name drift). It MIRRORS EXACTLY: if the CRM has an email, the
// Sender gets it; if the CRM is blank, the Sender is blanked too, so the client
// correctly shows as "no reporting email" and CS fixes it in the OS CRM (the one
// place). Runs on a 4-hour timer (server.js) and on demand via the manual Sync
// button (POST /api/sync-reporting-emails).

const { getSupabase } = require('./supabase');

async function syncReportingEmails() {
  const sb = getSupabase();

  // 1. CRM source: active clients + their reporting_email, keyed by task id.
  const { data: clients, error: cErr } = await sb
    .from('client')
    .select('clickup_ticket_id, reporting_email, status')
    .in('status', ['Live', 'Hosting', 'Onboarding']);
  if (cErr) throw new Error('read client: ' + cErr.message);

  const crmByTask = new Map();
  for (const c of (clients || [])) {
    if (!c.clickup_ticket_id) continue;
    const v = String(c.reporting_email || '').trim();
    crmByTask.set(String(c.clickup_ticket_id), v || null);
  }

  // 2. Sender recipients.
  const { data: recips, error: rErr } = await sb
    .from('sender_clients_recipients')
    .select('id, clickup_task_id, reporting_email');
  if (rErr) throw new Error('read recipients: ' + rErr.message);

  // 3. Mirror the CRM value onto each matched recipient when it differs.
  let matched = 0, updated = 0, cleared = 0, unmatched = 0;
  for (const r of (recips || [])) {
    const key = String(r.clickup_task_id || '');
    if (!key || !crmByTask.has(key)) { unmatched++; continue; }
    matched++;
    const next = crmByTask.get(key);                 // string or null
    const cur  = String(r.reporting_email || '').trim() || null;
    if (cur === next) continue;                       // already in sync
    const { error: uErr } = await sb
      .from('sender_clients_recipients')
      .update({ reporting_email: next })
      .eq('id', r.id);
    if (uErr) { console.warn('[reporting-email-sync] update failed', r.id, uErr.message); continue; }
    updated++;
    if (!next) cleared++;
  }

  const counters = {
    crm_clients: crmByTask.size,
    recipients:  (recips || []).length,
    matched, updated, cleared, unmatched,
  };
  return { counters };
}

module.exports = { syncReportingEmails };
