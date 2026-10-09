'use strict';

// Sender API. Read endpoints + CRUD for every entity + batch sending + CSV import.
// Every async handler is wrapped with `wrap()` so thrown errors become a
// clean 500 instead of crashing the Node process.

const express = require('express');
const crypto = require('crypto');
const { getSupabase } = require('../lib/supabase');
const { sendOne, applyMergeVars, ensureEnv: ensureMailgun, buildMergeRow } = require('../lib/mailgun');

// Fetch the CRM `client` row matching a recipient name (case-insensitive).
// Returns the row (with website, ga4_property_id, ahrefs_project_id) or null.
// Silent on error — the send still works, just without CRM-joined merge vars.
// Fetch the "spr.metric_monthly.total_leads" for a client for the
// PREVIOUS calendar month (YYYY-MM) — the month the report is about.
// Monthly reports always go out in the first week of the FOLLOWING
// month (Camila/CS confirmed 2026-09-01), so "this month" data is both
// wrong (report covers last month) and usually empty (the SPR pipeline
// hasn't aggregated a month that just started). Returns a number or
// null. Best-effort — a missing row or a Supabase hiccup just returns
// null so the {{leads}} merge token renders empty instead of breaking
// the send.
async function fetchLeadsForClient(sb, clientId) {
  if (!clientId) return null;
  try {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const month = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
    const { data } = await sb
      .schema('spr')
      .from('metric_monthly')
      .select('total_leads, total_organic_leads, total_ads_leads')
      .eq('client_id', clientId)
      .eq('month', month)
      .maybeSingle();
    if (!data) return null;
    // {{leads}} = leads from channels WE manage: organic (incl GBP) +
    // managed ads — the same buckets the Client Hub reports. total_leads
    // counts every WhatConverts lead (direct/referral/other included) and
    // inflated the emails vs the Hub (Henkels & Baker 130 vs 122,
    // Sabbeth 126 vs ~102 — reviewer video 2026-09-03).
    // Fallback to total_leads only while the new columns (SPR migration
    // 046) haven't backfilled this month yet.
    const org = data.total_organic_leads;
    const ads = data.total_ads_leads;
    if (typeof org === 'number' || typeof ads === 'number') {
      return (org ?? 0) + (ads ?? 0);
    }
    return typeof data.total_leads === 'number' ? data.total_leads : null;
  } catch {
    return null;
  }
}

// Resolve the batch's owner name to a users_profiles row so buildMergeRow
// can populate sender_email and calendar_url. Matches on full_name first
// (case-insensitive), then on the "First Last" combo formed from full_name
// tokens (so "Maria" alone in owner still finds "Maria Sanchez"). Returns
// null if nothing matches — mailgun.buildMergeRow falls back to the
// pre-existing "Constellation Marketing" default in that case.
async function lookupSenderProfile(sb, ownerName) {
  const q = String(ownerName || '').trim();
  if (!q) return null;
  try {
    // Exact case-insensitive match on full_name.
    const exact = await sb
      .from('users_profiles')
      .select('id, full_name, email, role, calendar_url')
      .ilike('full_name', q)
      .maybeSingle();
    if (exact?.data) return exact.data;
    // First-name-only match. If the batch owner is stored as "Maria" but
    // the profile is "Maria Sanchez", ilike '%Maria%' still resolves it.
    const partial = await sb
      .from('users_profiles')
      .select('id, full_name, email, role, calendar_url')
      .ilike('full_name', `%${q}%`)
      .order('full_name', { ascending: true })
      .limit(1);
    return partial?.data?.[0] || null;
  } catch {
    return null;
  }
}

// Join a Sender recipient to their OS CRM `client` row. Accepts the full
// recipient row (or { name } for legacy callers).
//
// Match order (2026-09-09 rework after Dressie's blank {{leads}}):
//   1. ClickUp task id — sender_clients_recipients.clickup_task_id and
//      client.clickup_ticket_id both refer to the SAME ClickUp CRM-list
//      task, so this is exact and immune to any naming drift.
//   2. Exact name (legacy fast path).
//   3. Normalized name — lowercase alphanumerics only, so punctuation
//      drift ("Wosnik Law, LLC" vs "Wosnik Law LLC") still matches.
//      (Word-level drift like "The … LLC" vs bare name is exactly why
//      the id join is now first: names can NEVER be fully trusted.)
//
// SELF-HEAL: when a name path (2/3) matches but the client row's
// clickup_ticket_id differs from the recipient's clickup_task_id, we
// backfill it (best-effort) so the NEXT lookup — and every other system
// joining on that id (CRM mirror writes, CRM pages) — hits the exact id
// path. The fleet converges to id-based matching by itself.
async function fetchCrmClientForRecipient(sb, recipientOrName) {
  const recipient = typeof recipientOrName === 'string'
    ? { name: recipientOrName }
    : (recipientOrName || {});
  const recipientName = recipient.name;
  const taskId = String(recipient.clickup_task_id || '').trim();
  if (!recipientName && !taskId) return null;
  try {
    const SELECT = 'id, name, clickup_ticket_id, website, ga4_property_id, ahrefs_project_id, client_actual_name';
    let data = null;
    let matchedBy = null;

    // 1. Exact ClickUp task id.
    if (taskId) {
      const r = await sb.from('client').select(SELECT)
        .eq('clickup_ticket_id', taskId).maybeSingle();
      if (r.data) { data = r.data; matchedBy = 'task_id'; }
    }

    // 2. Exact name.
    if (!data && recipientName) {
      const r = await sb.from('client').select(SELECT)
        .ilike('name', String(recipientName).trim()).maybeSingle();
      if (r.data) { data = r.data; matchedBy = 'name'; }
    }

    // 3. Normalized name (~100 rows; cheap).
    if (!data && recipientName) {
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const target = norm(recipientName);
      if (target) {
        const { data: all } = await sb.from('client').select(SELECT);
        data = (all || []).find((c) => norm(c.name) === target) || null;
        if (data) matchedBy = 'normalized_name';
      }
    }
    if (!data) return null;

    // Self-heal the id link on name-path matches.
    if (taskId && matchedBy !== 'task_id' && String(data.clickup_ticket_id || '') !== taskId) {
      try {
        await sb.from('client').update({ clickup_ticket_id: taskId }).eq('id', data.id);
        console.log(`crm-join self-heal: client "${data.name}" clickup_ticket_id -> ${taskId} (was ${data.clickup_ticket_id || 'null'})`);
      } catch { /* best-effort */ }
    }
    // Attach this month's total_leads (from spr.metric_monthly) so the
    // {{leads}} merge tag can resolve without buildMergeRow having to
    // become async. Absent data → null → renders as an empty string in
    // the email, matching how every other CRM-joined field behaves.
    const leads = await fetchLeadsForClient(sb, data.id);
    return { ...data, leads };
  } catch {
    return null;
  }
}
const { parseCsv } = require('../lib/csv');
// fetchActiveClients now reads from the OS CRM's Supabase `client` table
// (the source of truth ClickUp itself feeds into), so no new env vars are
// needed beyond the Supabase keys the app already has.
const { fetchActiveClients } = require('../lib/crm');
const { runAssigneeSync } = require('../lib/assignee-sync');

// HTML-escape helper used by the test-send banner (line ~481) and
// anywhere else we drop dynamic strings into an HTML payload.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const router = express.Router();

function bad(res, status, error) {
  return res.status(status).json({ error });
}
function clean(obj, allowed) {
  const out = {};
  for (const k of allowed) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
// Wrap async handlers so any thrown error / rejected promise is forwarded
// to Express's error middleware instead of killing the process.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ─── Health ────────────────────────────────────────────────────────────────
// Canonical health endpoint — see wiki/infra-health-protocol.md. Returns
// { ok, ts, build, env } with env-var booleans only (never values). Probed
// daily by the central health-check Worker for the green/yellow/red report.
const BUILD_TAG = 'sender-2026-05-31';
router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    build: BUILD_TAG,
    env: {
      SUPABASE_URL:              !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      MAILGUN_API_KEY:           !!process.env.MAILGUN_API_KEY,
      MAILGUN_DOMAIN:            !!process.env.MAILGUN_DOMAIN,
      MAILGUN_FROM:              !!process.env.MAILGUN_FROM,
      MAILGUN_WEBHOOK_SIGNING_KEY: !!process.env.MAILGUN_WEBHOOK_SIGNING_KEY,
      CLICKUP_API_KEY:           !!process.env.CLICKUP_API_KEY,
    },
  });
});

// ─── Mailgun events webhook (open/click/delivery tracking) ─────────────────
// Phase 2 of the monthly-reporting observability work. Mailgun POSTs here for
// every event on a report send (delivered / opened / clicked / failed / …).
// We verify Mailgun's signature, then write one row to sender_tracking_events,
// attributed via the custom variables we stamped at send time (clickup_task_id,
// send_email_id, batch_id, report_month). Phase 3 (summary) and Phase 4
// (reconciliation) read from that table.
//
// Mailgun setup (one-time, in the Mailgun dashboard → Webhooks): point the
// Delivered / Opened / Clicked / Permanent-Fail / Temporary-Fail / Complained /
// Unsubscribed events at:  https://sender.goconstellation.com/api/mailgun-events
// and set MAILGUN_WEBHOOK_SIGNING_KEY to the account's HTTP webhook signing key.
//
// Signature: Mailgun signs `timestamp + token` with HMAC-SHA256 using the
// signing key (not the sending API key). Both values are in the JSON body, so
// the global express.json() parse is fine — no raw-body handling needed.
function verifyMailgunSignature(sig, signingKey) {
  if (!sig || !sig.timestamp || !sig.token || !sig.signature || !signingKey) return false;
  // Reject stale timestamps (>15 min) to blunt replay attempts.
  const ageSec = Math.abs(Date.now() / 1000 - Number(sig.timestamp));
  if (!Number.isFinite(ageSec) || ageSec > 900) return false;
  const expected = crypto.createHmac('sha256', signingKey)
    .update(String(sig.timestamp) + String(sig.token))
    .digest('hex');
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(sig.signature), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

router.post('/mailgun-events', wrap(async (req, res) => {
  const signingKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  const body = req.body || {};
  const sig = body.signature;
  const data = body['event-data'] || body.eventData || null;

  // Verify when a signing key is configured. If it isn't (not set up yet),
  // log loudly but still 200 so Mailgun doesn't hammer retries — the endpoint
  // is unauthenticated only in that un-configured window.
  if (signingKey) {
    if (!verifyMailgunSignature(sig, signingKey)) {
      return bad(res, 401, 'invalid signature');
    }
  } else {
    console.warn('[sender] mailgun-events: MAILGUN_WEBHOOK_SIGNING_KEY unset — accepting unverified');
  }

  if (!data || !data.event) {
    // Not an event payload (e.g. a test ping) — acknowledge so Mailgun is happy.
    return res.json({ ok: true, ignored: true });
  }

  const vars = data['user-variables'] || {};
  const headers = (data.message && data.message.headers) || {};
  const numOrNull = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const row = {
    mailgun_event_id:   data.id || null,
    mailgun_message_id: headers['message-id'] || null,
    event:              String(data.event),
    recipient_email:    data.recipient || null,
    send_email_id:      numOrNull(vars.send_email_id),
    batch_id:           numOrNull(vars.batch_id),
    recipient_id:       numOrNull(vars.recipient_id),
    clickup_task_id:    vars.clickup_task_id || null,
    client_name:        vars.client_name || null,
    report_month:       vars.report_month || null,
    url:                data.url || null,
    event_ts:           data.timestamp ? new Date(Number(data.timestamp) * 1000).toISOString() : null,
    raw:                data,
  };

  const sb = getSupabase();
  // Idempotent: a repeat delivery of the same Mailgun event collides on the
  // mailgun_event_id unique index and is ignored.
  const { error } = await sb
    .from('sender_tracking_events')
    .upsert(row, { onConflict: 'mailgun_event_id', ignoreDuplicates: true });
  if (error) {
    console.error('[sender] mailgun-events insert failed:', error.message);
    // 500 → Mailgun retries later, so a transient DB blip doesn't lose the event.
    return bad(res, 500, error.message);
  }
  return res.json({ ok: true });
}));

// ─── Tracking summary (Phase 3) ────────────────────────────────────────────
// Per-client Received / Opened / Clicked for a report cycle, plus totals.
// Reads sender_tracking_events (populated by the Mailgun webhook above).
//   GET /api/tracking-summary?month=September%202026
// Defaults to the previous calendar month (the month reports are ABOUT),
// matching the report_month label stamped at send time.
router.get('/tracking-summary', wrap(async (req, res) => {
  const sb = getSupabase();

  const monthNames = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  const defaultMonth = (() => {
    const d = new Date();
    const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    return `${monthNames[prev.getMonth()]} ${prev.getFullYear()}`;
  })();
  const month = (req.query.month && String(req.query.month)) || defaultMonth;

  const { data, error } = await sb
    .from('sender_tracking_events')
    .select('event, clickup_task_id, client_name, recipient_email, report_month')
    .eq('report_month', month);
  if (error) return bad(res, 500, error.message);

  const byClient = new Map();
  for (const e of (data || [])) {
    const key = e.clickup_task_id || e.client_name || e.recipient_email || 'unknown';
    let c = byClient.get(key);
    if (!c) {
      c = { clickup_task_id: e.clickup_task_id || null, client_name: e.client_name || null,
            delivered: 0, opened: 0, clicked: 0, failed: 0 };
      byClient.set(key, c);
    }
    const ev = String(e.event || '').toLowerCase();
    if (ev === 'delivered') c.delivered++;
    else if (ev === 'opened') c.opened++;
    else if (ev === 'clicked') c.clicked++;
    else if (ev.includes('fail') || ev === 'complained' || ev === 'rejected' || ev === 'bounced') c.failed++;
  }

  const clients = [...byClient.values()]
    .map(c => ({
      clickup_task_id: c.clickup_task_id,
      client_name:     c.client_name,
      received:        c.delivered > 0,
      opened:          c.opened > 0,
      clicked:         c.clicked > 0,
      failed:          c.failed > 0,
      open_count:      c.opened,
      click_count:     c.clicked,
    }))
    .sort((a, b) => String(a.client_name || '').localeCompare(String(b.client_name || '')));

  const totals = {
    clients:  clients.length,
    received: clients.filter(c => c.received).length,
    opened:   clients.filter(c => c.opened).length,
    clicked:  clients.filter(c => c.clicked).length,
    failed:   clients.filter(c => c.failed).length,
  };

  res.json({ ok: true, month, totals, clients });
}));

// ─── Post-send reconciliation (Phase 4) ────────────────────────────────────
// "Did everyone who should have gotten a report actually get one?" Compares
// the AUTOMATED master list (active recipients) — and an optional CUSTOM list
// the user pastes/uploads for clients reported on by hand — against who was
// actually delivered to this cycle (sender_tracking_events 'delivered').
//
//   POST /api/reconciliation
//   body: { month?: "September 2026", customNames?: ["Firm A", "Firm B", ...] }
//
// Returns the missed clients for each list. "Sent" = a delivered/accepted
// tracking event for that client in this report_month (real sends carry the
// month + clickup_task_id; test sends don't, so they're naturally excluded).
router.post('/reconciliation', wrap(async (req, res) => {
  const sb = getSupabase();
  const body = req.body || {};

  const monthNames = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  const defaultMonth = (() => {
    const d = new Date();
    const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    return `${monthNames[prev.getMonth()]} ${prev.getFullYear()}`;
  })();
  const month = (body.month && String(body.month)) || defaultMonth;

  // Custom-report clients: the saved roster (managed in the Custom Reports
  // tab) PLUS any one-off names pasted into the box this run. Union, de-duped.
  const pasted = Array.isArray(body.customNames)
    ? body.customNames.map(s => String(s || '').trim()).filter(Boolean)
    : [];
  const { data: storedCustom } = await sb
    .from('sender_custom_report_clients')
    .select('firm_name')
    .eq('active', true);
  const stored = (storedCustom || []).map(c => String(c.firm_name || '').trim()).filter(Boolean);
  const seenC = new Set();
  const customNames = [...stored, ...pasted].filter(n => {
    const k = n.toLowerCase();
    if (seenC.has(k)) return false;
    seenC.add(k);
    return true;
  });

  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // 1. Automated master: active recipients with a real email, not skipped,
  //    not orphaned. (Placeholder "(no-email…" addresses never get sent.)
  const { data: recips, error: rErr } = await sb
    .from('sender_clients_recipients')
    .select('id, name, email, reporting_email, status, clickup_task_id, skip_autosend, orphaned_at');
  if (rErr) return bad(res, 500, rErr.message);
  const active = (recips || []).filter(r => {
    const st = String(r.status || '').toLowerCase();
    const isActive = ['live', 'hosting', 'onboarding'].includes(st);
    const hasEmail = (r.reporting_email && /@/.test(r.reporting_email)) ||
      (r.email && /@/.test(r.email) && !String(r.email).startsWith('(no-email'));
    return isActive && hasEmail && !r.skip_autosend && !r.orphaned_at;
  });

  // 2. Sent set for the cycle — delivered/accepted tracking events this month.
  const { data: evs, error: eErr } = await sb
    .from('sender_tracking_events')
    .select('clickup_task_id, client_name, event')
    .eq('report_month', month)
    .in('event', ['delivered', 'accepted']);
  if (eErr) return bad(res, 500, eErr.message);
  const sentTaskIds = new Set();
  const sentNames = new Set();
  for (const e of (evs || [])) {
    if (e.clickup_task_id) sentTaskIds.add(String(e.clickup_task_id));
    if (e.client_name) sentNames.add(norm(e.client_name));
  }
  const wasSent = (taskId, name) =>
    (taskId && sentTaskIds.has(String(taskId))) || (name && sentNames.has(norm(name)));

  // 3. Diff each list.
  const autoMissed = active
    .filter(r => !wasSent(r.clickup_task_id, r.name))
    .map(r => ({ name: r.name, clickup_task_id: r.clickup_task_id, email: r.reporting_email || r.email }))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  const customMissed = customNames
    .filter(n => !sentNames.has(norm(n)))
    .sort((a, b) => a.localeCompare(b));

  res.json({
    ok: true,
    month,
    automated: { expected: active.length, missed: autoMissed, missed_count: autoMissed.length },
    custom:    { expected: customNames.length, missed: customMissed, missed_count: customMissed.length },
  });
}));

// ─── Custom-report client roster (CRUD for the Custom Reports tab) ──────────
// The list of clients that get a hand-built custom report. Managed in the UI
// so it no longer lives only in a Google doc; reconciliation reads it above.
router.get('/custom-reports', wrap(async (_req, res) => {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('sender_custom_report_clients')
    .select('id, firm_name, cs_owner, active, created_at')
    .order('firm_name');
  if (error) return bad(res, 500, error.message);
  res.json({ ok: true, clients: data || [] });
}));

router.post('/custom-reports', wrap(async (req, res) => {
  const sb = getSupabase();
  const firm_name = String((req.body && req.body.firm_name) || '').trim();
  const cs_owner  = String((req.body && req.body.cs_owner) || '').trim() || null;
  if (!firm_name) return bad(res, 400, 'firm_name is required');
  const { data, error } = await sb
    .from('sender_custom_report_clients')
    .insert({ firm_name, cs_owner })
    .select()
    .single();
  if (error) {
    // Duplicate firm (unique index on lower(firm_name)).
    if (/duplicate|unique/i.test(error.message)) return bad(res, 409, `"${firm_name}" is already on the custom-report list`);
    return bad(res, 400, error.message);
  }
  res.json({ ok: true, client: data });
}));

router.delete('/custom-reports/:id', wrap(async (req, res) => {
  const sb = getSupabase();
  const id = req.params.id;
  const { error } = await sb.from('sender_custom_report_clients').delete().eq('id', id);
  if (error) return bad(res, 400, error.message);
  res.json({ ok: true });
}));

// ─── Manual reporting-email sync (OS CRM → Sender) ──────────────────────────
// Pulls public.client.reporting_email into the recipients. Also runs every 4h
// (server.js). The "Sync reporting emails" button in Client Lists calls this.
router.post('/sync-reporting-emails', wrap(async (_req, res) => {
  const { syncReportingEmails } = require('../lib/reporting-email-sync');
  const r = await syncReportingEmails();
  res.json({ ok: true, ...r });
}));

// ─── Snapshot (one-shot read for the UI) ───────────────────────────────────
router.get('/snapshot', wrap(async (_req, res) => {
  const sb = getSupabase();

  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  const [
    recipientsRes, listsRes, listMembersRes, templatesRes, batchesRes,
    queueRes, logsRes, usersRes,
    activeCountRes, sentCountRes, failedCountRes, scheduledCountRes,
  ] = await Promise.all([
    // Select * already brings original_list_id; explicit here so future
    // schema changes don't accidentally drop the column from the payload.
    sb.from('sender_clients_recipients').select('*').order('name'),
    sb.from('sender_clients_lists').select('*').order('name'),
    sb.from('sender_clients_list_members').select('list_id, recipient_id'),
    sb.from('sender_templates_emails').select('*').order('updated_at', { ascending: false }),
    sb.from('sender_sends_batches').select('*').order('created_at', { ascending: false }),
    sb.from('sender_sends_emails').select('*').order('created_at', { ascending: false }).limit(200),
    sb.from('sender_logs_events').select('*').order('occurred_at', { ascending: false }).limit(200),
    sb.from('users_profiles').select('id, full_name, email, role, calendar_url').order('full_name', { ascending: true, nullsFirst: false }),
    // KPI counts everyone who could plausibly receive an email — same set
    // the send loop uses (active / onboarding / live / hosting only).
    // Hosting-only clients need the email too — they're still active firm
    // relationships even when we're not doing the full marketing stack.
    sb.from('sender_clients_recipients').select('id', { count: 'exact', head: true }).in('status', ['active', 'onboarding', 'live', 'hosting only', 'hosting-only', 'hosting_only', 'hosting']),
    sb.from('sender_sends_emails').select('id', { count: 'exact', head: true }).eq('status', 'delivered').gte('sent_at', monthStart.toISOString()),
    sb.from('sender_sends_emails').select('id', { count: 'exact', head: true }).eq('status', 'failed').gte('created_at', monthStart.toISOString()),
    sb.from('sender_sends_batches').select('id', { count: 'exact', head: true }).eq('status', 'scheduled'),
  ]);

  res.json({
    kpis: {
      activeClients:      activeCountRes.count    ?? 0,
      emailsThisMonth:    sentCountRes.count      ?? 0,
      failedSends:        failedCountRes.count    ?? 0,
      scheduledCampaigns: scheduledCountRes.count ?? 0,
    },
    recipients:  recipientsRes.data || [],
    lists:       listsRes.data || [],
    listMembers: listMembersRes.data || [],
    templates:   templatesRes.data || [],
    batches:     batchesRes.data || [],
    queue:       queueRes.data || [],
    logs:        logsRes.data || [],
    users:       usersRes.data || [],
  });
}));

// ─── Recipients (clients) ──────────────────────────────────────────────────
// Both POST and PATCH accept an optional `list_ids: string[]` field. When
// present, list memberships are SYNCED to exactly that set (existing
// memberships removed, then the new ones inserted). Omit `list_ids` to leave
// memberships untouched.
async function syncListMemberships(sb, recipientId, listIds) {
  if (!Array.isArray(listIds)) return;
  await sb.from('sender_clients_list_members').delete().eq('recipient_id', recipientId);
  const ids = listIds.filter(Boolean);
  if (!ids.length) return;
  await sb.from('sender_clients_list_members').insert(
    ids.map(list_id => ({ list_id, recipient_id: recipientId }))
  );
}

router.post('/recipients', wrap(async (req, res) => {
  const sb = getSupabase();
  const row = clean(req.body || {}, ['name','email','firm','account_manager','status','tags','client_hub']);
  if (!row.name)  return bad(res, 400, 'name is required');
  if (!row.email) return bad(res, 400, 'email is required');
  if (!Array.isArray(row.tags)) delete row.tags;
  const { data, error } = await sb.from('sender_clients_recipients').insert(row).select().single();
  if (error) return bad(res, 400, error.message);

  await syncListMemberships(sb, data.id, req.body?.list_ids);

  res.status(201).json(data);
}));

router.patch('/recipients/:id', wrap(async (req, res) => {
  const sb = getSupabase();
  const row = clean(req.body || {}, ['name','email','firm','account_manager','status','tags','client_hub','skip_autosend']);
  const { data, error } = await sb.from('sender_clients_recipients').update(row).eq('id', req.params.id).select().single();
  if (error) return bad(res, 400, error.message);

  await syncListMemberships(sb, req.params.id, req.body?.list_ids);

  res.json(data);
}));

router.delete('/recipients/:id', wrap(async (req, res) => {
  const sb = getSupabase();
  const id = req.params.id;
  // Cascade: remove referenced rows first or the DELETE fails with a foreign-
  // key violation. The schema doesn't have ON DELETE CASCADE on these FKs,
  // so we walk the tree manually:
  //   sender_logs_events  ← references sender_sends_emails.id (via send_email_id)
  //   sender_sends_emails ← references sender_clients_recipients.id (via recipient_id)
  //   sender_clients_list_members ← references sender_clients_recipients.id

  // 1. Find every send-email row this recipient is on, so we can delete
  //    its log events first. Two-step to avoid Supabase nested-delete quirks.
  const { data: sendRows } = await sb
    .from('sender_sends_emails')
    .select('id')
    .eq('recipient_id', id);
  const sendIds = (sendRows || []).map(r => r.id);
  if (sendIds.length) {
    await sb.from('sender_logs_events').delete().in('send_email_id', sendIds);
  }

  // 2. Now safe to delete the send-email rows themselves.
  await sb.from('sender_sends_emails').delete().eq('recipient_id', id);

  // 3. Remove from every list this recipient was a member of.
  await sb.from('sender_clients_list_members').delete().eq('recipient_id', id);

  // 4. Finally, the recipient itself.
  const { error } = await sb.from('sender_clients_recipients').delete().eq('id', id);
  if (error) return bad(res, 400, `Could not delete recipient: ${error.message}`);
  res.json({ ok: true });
}));

// Bulk import via CSV. Body: { csv: "<raw text>" } or { rows: [...] }
router.post('/recipients/import', wrap(async (req, res) => {
  const sb = getSupabase();
  let rows = [];
  if (typeof req.body?.csv === 'string') {
    rows = parseCsv(req.body.csv).rows;
  } else if (Array.isArray(req.body?.rows)) {
    rows = req.body.rows;
  }
  if (!rows.length) return bad(res, 400, 'No rows to import');

  const norm = rows.map(r => {
    const k = {};
    for (const key of Object.keys(r)) k[key.toLowerCase().trim()] = r[key];
    return {
      name:            k.name || k.client_name || k.full_name || '',
      email:           k.email,
      firm:            k.firm || k.company || null,
      account_manager: k.account_manager || k.manager || null,
      status:          (k.status || 'active').toLowerCase(),
      tags:            k.tags ? String(k.tags).split(';').map(s => s.trim()).filter(Boolean) : [],
    };
  }).filter(r => r.name && r.email);

  if (!norm.length) return bad(res, 400, 'No valid rows (need name + email)');

  const { data, error } = await sb
    .from('sender_clients_recipients')
    .upsert(norm, { onConflict: 'email' })
    .select();
  if (error) return bad(res, 400, error.message);
  res.json({ imported: (data || []).length, recipients: data || [] });
}));

// ─── Lists ─────────────────────────────────────────────────────────────────
router.post('/lists', wrap(async (req, res) => {
  const sb = getSupabase();
  const row = clean(req.body || {}, ['name','description','owner','is_fixed']);
  if (!row.name) return bad(res, 400, 'name is required');
  // Default a helpful description when it's a fixed (auto-sync) list.
  if (row.is_fixed && !row.description) {
    row.description = `Auto-populated from ClickUp by assignee match on "${row.name}".`;
  }
  const { data, error } = await sb.from('sender_clients_lists').insert(row).select().single();
  if (error) return bad(res, 400, error.message);
  res.status(201).json(data);
}));

router.patch('/lists/:id', wrap(async (req, res) => {
  const sb = getSupabase();
  const row = clean(req.body || {}, ['name','description','owner','is_fixed']);
  const { data, error } = await sb.from('sender_clients_lists').update(row).eq('id', req.params.id).select().single();
  if (error) return bad(res, 400, error.message);
  res.json(data);
}));

router.delete('/lists/:id', wrap(async (req, res) => {
  const sb = getSupabase();
  const id = req.params.id;
  // Cascade — same reason as recipient delete. A list is referenced by
  // sender_clients_list_members (membership) and sender_sends_batches
  // (audience). We blow away memberships, then null-out the FK on batches
  // (rather than deleting batches — they contain historical send data we
  // want to keep even after the list itself is gone), then drop the list.
  await sb.from('sender_clients_list_members').delete().eq('list_id', id);
  await sb.from('sender_sends_batches').update({ audience_list_id: null }).eq('audience_list_id', id);
  const { error } = await sb.from('sender_clients_lists').delete().eq('id', id);
  if (error) return bad(res, 400, `Could not delete list: ${error.message}`);
  res.json({ ok: true });
}));

// ─── List membership ───────────────────────────────────────────────────────
router.post('/lists/:id/members', wrap(async (req, res) => {
  const sb = getSupabase();
  const recipient_id = req.body?.recipient_id;
  if (!recipient_id) return bad(res, 400, 'recipient_id is required');
  const { error } = await sb
    .from('sender_clients_list_members')
    .insert({ list_id: req.params.id, recipient_id })
    .select();
  if (error) return bad(res, 400, error.message);
  res.json({ ok: true });
}));

router.delete('/lists/:id/members/:recipientId', wrap(async (req, res) => {
  const sb = getSupabase();
  const { error } = await sb
    .from('sender_clients_list_members')
    .delete()
    .eq('list_id', req.params.id)
    .eq('recipient_id', req.params.recipientId);
  if (error) return bad(res, 400, error.message);
  res.json({ ok: true });
}));

// ─── Templates ─────────────────────────────────────────────────────────────
router.post('/templates', wrap(async (req, res) => {
  const sb = getSupabase();
  const row = clean(req.body || {}, ['name','type','subject','body_html','thumb_color']);
  if (!row.name) return bad(res, 400, 'name is required');
  if (!row.type) return bad(res, 400, 'type is required (newsletter | report)');
  const { data, error } = await sb.from('sender_templates_emails').insert(row).select().single();
  if (error) return bad(res, 400, error.message);
  res.status(201).json(data);
}));

router.patch('/templates/:id', wrap(async (req, res) => {
  const sb = getSupabase();
  const row = clean(req.body || {}, ['name','type','subject','body_html','thumb_color']);
  const { data, error } = await sb.from('sender_templates_emails').update(row).eq('id', req.params.id).select().single();
  if (error) return bad(res, 400, error.message);
  res.json(data);
}));

router.delete('/templates/:id', wrap(async (req, res) => {
  const sb = getSupabase();
  const id = req.params.id;
  // Cascade — templates are referenced by sender_sends_batches.template_id.
  // Null it out on those batches rather than deleting them so historical send
  // records (delivered/opened/clicked stats) survive the template's removal.
  await sb.from('sender_sends_batches').update({ template_id: null }).eq('template_id', id);
  const { error } = await sb.from('sender_templates_emails').delete().eq('id', id);
  if (error) return bad(res, 400, `Could not delete template: ${error.message}`);
  res.json({ ok: true });
}));

// ─── Batches (newsletter / report sends) ───────────────────────────────────
router.post('/batches', wrap(async (req, res) => {
  const sb = getSupabase();
  const row = clean(req.body || {}, ['name','type','audience_list_id','template_id','status','scheduled_at','owner','ad_hoc_recipients']);
  if (!row.name) return bad(res, 400, 'name is required');
  if (!row.type) return bad(res, 400, 'type is required (newsletter | report | broadcast)');
  row.status = row.status || 'draft';
  const { data, error } = await sb.from('sender_sends_batches').insert(row).select().single();
  if (error) return bad(res, 400, error.message);
  res.status(201).json(data);
}));

router.patch('/batches/:id', wrap(async (req, res) => {
  const sb = getSupabase();
  const row = clean(req.body || {}, ['name','type','audience_list_id','template_id','status','scheduled_at','owner','ad_hoc_recipients']);
  const { data, error } = await sb.from('sender_sends_batches').update(row).eq('id', req.params.id).select().single();
  if (error) return bad(res, 400, error.message);
  res.json(data);
}));

// ─── User profile — per-user calendar_url (Settings page) ─────────────────
// Whitelisted to calendar_url only — everything else on users_profiles
// (full_name, email, role) is owned by the OS-app source of truth and
// mustn't be edited from the Sender UI. No session auth; the honor
// system applies here as it does for the rest of the app.
router.patch('/users-profiles/:id', wrap(async (req, res) => {
  const sb = getSupabase();
  const row = clean(req.body || {}, ['calendar_url']);
  const { data, error } = await sb
    .from('users_profiles')
    .update(row)
    .eq('id', req.params.id)
    .select('id, full_name, email, role, calendar_url')
    .single();
  if (error) return bad(res, 400, error.message);
  res.json(data);
}));

router.delete('/batches/:id', wrap(async (req, res) => {
  const sb = getSupabase();
  const id = req.params.id;
  // Cascade — a batch owns per-recipient send rows in sender_sends_emails,
  // which in turn link to log events in sender_logs_events. Delete in the
  // right order or the FK violation blocks everything.
  await sb.from('sender_logs_events').delete().eq('batch_id', id);
  await sb.from('sender_sends_emails').delete().eq('batch_id', id);
  const { error } = await sb.from('sender_sends_batches').delete().eq('id', id);
  if (error) return bad(res, 400, `Could not delete batch: ${error.message}`);
  res.json({ ok: true });
}));

// ─── TEST-SEND a batch (preview to your own email) ─────────────────────────
// Sends the batch's template to a single test email instead of the audience
// list. Useful for verifying merge variables / formatting / Mailgun delivery
// before doing the real bulk send. Does NOT touch sender_sends_emails,
// sender_logs_events, or the batch's status — it's a dry-run side-channel.
// Body: { to: "your@email.com", sample_recipient_id?: "<uuid>" }
//   - `to` is the email that receives the test (required)
//   - `sample_recipient_id` (optional) — pull merge vars from this real
//     recipient instead of using "Test Recipient" placeholders
router.post('/batches/:id/test-send', wrap(async (req, res) => {
  const sb = getSupabase();
  ensureMailgun();

  // Accept either `to` (single email, kept for backward compat) or
  // `to_list` (string of comma/space/newline-separated emails — the new
  // modal sends this so the user can test against multiple inboxes at once).
  const rawTo = req.body?.to_list || req.body?.to || '';
  const matches = String(rawTo).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  const seen = new Set();
  const toEmails = matches.map(x => x.trim()).filter(x => {
    const k = x.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  if (!toEmails.length) {
    return bad(res, 400, 'At least one valid email address is required');
  }
  const sampleRecipientId = req.body?.sample_recipient_id || null;

  const { data: batch, error: batchErr } = await sb
    .from('sender_sends_batches').select('*').eq('id', req.params.id).single();
  if (batchErr || !batch)      return bad(res, 404, batchErr?.message || 'Batch not found');
  if (!batch.template_id)      return bad(res, 400, 'Batch has no template — assign one first');

  const { data: tpl, error: tplErr } = await sb
    .from('sender_templates_emails').select('*').eq('id', batch.template_id).single();
  if (tplErr || !tpl) return bad(res, 400, 'Template not found');

  // Same sender lookup as the real /send handler so test emails preview
  // the correct sign-off + calendar link.
  const sender = await lookupSenderProfile(sb, batch.owner);

  // Pull merge-variable values from a sample recipient if one was given,
  // OR from the first recipient on the audience list if available, OR
  // fall back to clearly-labeled placeholders so the test obviously isn't
  // pretending to be a real client.
  // Build the merge row using the shared helper so ALL 22 variables are
  // populated in the test-send preview + email. Overrides force the
  // test-send email to be delivered to toEmails[0] even when the sample
  // recipient row has a real client email — we don't want to accidentally
  // send test copy to a live client.
  let mergeRow = buildMergeRow({
    recipient: {
      name:            'Test Recipient',
      first_name:      'Test',
      email:           toEmails[0],
      firm:            'Test Firm LLP',
      account_manager: 'Test Manager',
      status:          'live',
      client_hub:      'https://example.goconstellation.com/hub/test',
    },
    batch,
    sender,
    crmClient: null,
    overrides: { email: toEmails[0] },
  });
  if (sampleRecipientId) {
    const { data: sample } = await sb
      .from('sender_clients_recipients')
      .select('name, first_name, email, firm, account_manager, status, client_hub, clickup_task_id')
      .eq('id', sampleRecipientId)
      .single();
    if (sample) {
      const crmClient = await fetchCrmClientForRecipient(sb, sample);
      mergeRow = buildMergeRow({
        recipient: sample,
        batch,
        sender,
        crmClient,
        overrides: { email: toEmails[0] },  // still send to test addr
      });
    }
  } else if (batch.audience_list_id) {
    // Grab the first active member of the audience list so the test email
    // shows what a real send to that list would look like.
    const { data: members } = await sb
      .from('sender_clients_list_members')
      .select('recipient:sender_clients_recipients(name, first_name, email, reporting_email, firm, account_manager, status, client_hub, clickup_task_id)')
      .eq('list_id', batch.audience_list_id)
      .limit(5);
    const sample = (members || [])
      .map(m => m.recipient)
      .find(r => r && (r.status === 'active' || r.status === 'live' || r.status === 'onboarding'));
    if (sample) {
      const crmClient = await fetchCrmClientForRecipient(sb, sample);
      mergeRow = buildMergeRow({
        recipient: sample,
        batch,
        sender,
        crmClient,
        overrides: { email: toEmails[0] },
      });
    }
  }

  const subjectBase = tpl.subject || batch.name || 'Test send';
  const subject     = `[TEST] ${applyMergeVars(subjectBase, mergeRow)}`;
  const html        = `
    <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:12px 16px;margin:0 0 16px;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;color:#92400e;">
      <strong>⚠️ This is a TEST send.</strong> Real audience list was NOT contacted. Merge variables filled from <em>${esc(mergeRow.name)}</em>.
    </div>
    ${applyMergeVars(tpl.body_html || '', mergeRow)}
  `;

  // Send to each test address. Don't bail on first failure — we want a
  // per-address breakdown so the user can tell which inbox didn't get it.
  //
  // We ALSO write a row into sender_logs_events for each test address so the
  // Email Logs page shows every event — including tests — with a clearly
  // distinct "test" pill and a "(test only)" meta line. That way the person
  // who fired the test can confirm it went out without pretending it was a
  // real send. send_email_id and batch_id are left null: no queue row
  // exists for a test-send, and the audience batch stays untouched (that's
  // still the whole point of test-send being a "dry-run side-channel").
  // Small helper — Supabase-js .insert() does NOT throw on constraint
  // violations, it returns { data, error }. We were relying on try/catch,
  // which meant every log-row failure was invisible. Wrap it so we
  // actually surface the message to pm2 logs.
  async function logTestEvent(addr, meta) {
    try {
      const { error } = await sb.from('sender_logs_events').insert({
        type: 'test',
        recipient_email: addr,
        meta,
      });
      if (error) {
        console.warn('test-send: log insert failed:', error.message, error.details || '');
      }
    } catch (thrown) {
      console.warn('test-send: log insert threw:', thrown?.message || thrown);
    }
  }
  const results = [];
  for (const addr of toEmails) {
    try {
      // track:false — a test send goes to the strategist, not the client, so
      // it must not generate open/click stats on the client's report.
      const out = await sendOne({ to: addr, subject, html, replyTo: mergeRow.sender_email || '', track: false });
      results.push({ to: addr, ok: true, id: out?.id || null });
      await logTestEvent(addr, `(test only) — merged from ${mergeRow.name || 'test recipient'}`);
    } catch (e) {
      results.push({ to: addr, ok: false, error: String(e.message || e).slice(0, 500) });
      await logTestEvent(addr, `(test only) — FAILED: ${String(e.message || e).slice(0, 200)}`);
    }
  }
  const okCount   = results.filter(r => r.ok).length;
  const failCount = results.length - okCount;
  return res.json({
    ok:         failCount === 0,
    to:         toEmails,
    mergedFrom: mergeRow.name,
    results,
    sentCount:  okCount,
    failedCount: failCount,
  });
}));

// ─── SEND a batch ──────────────────────────────────────────────────────────
router.post('/batches/:id/send', wrap(async (req, res) => {
  const sb = getSupabase();
  ensureMailgun();   // throws → caught by wrap → 500 with message

  const { data: batch, error: batchErr } = await sb
    .from('sender_sends_batches').select('*').eq('id', req.params.id).single();
  if (batchErr || !batch) return bad(res, 404, batchErr?.message || 'Batch not found');

  if (!batch.template_id) return bad(res, 400, 'Batch has no template');
  if (!batch.audience_list_id && !batch.ad_hoc_recipients) {
    return bad(res, 400, 'Batch has no audience list and no ad-hoc recipients');
  }

  const { data: tpl, error: tplErr } = await sb
    .from('sender_templates_emails').select('*').eq('id', batch.template_id).single();
  if (tplErr || !tpl) return bad(res, 400, 'Template not found');

  // Look up the sender's profile so buildMergeRow can populate
  // {{sender_email}}, {{sender_first_name}}, {{calendar_url}}. batch.owner
  // is a users_profiles.full_name; if the batch predates the Owner
  // dropdown (owner is NULL), buildMergeRow falls back to
  // "Constellation Marketing" and empty calendar_url.
  const sender = await lookupSenderProfile(sb, batch.owner);

  // Build the recipient list. Two paths:
  //  1. Ad-hoc recipients (typed into the batch modal for beta-testing) take
  //     priority. We synthesize lightweight in-memory rows — no DB writes
  //     for fake "clients", they don't show up in the Client Lists view.
  //  2. Saved audience list — read the members and filter by sendable status.
  let recipients = [];

  // Effective send-to address. Policy change 2026-09-02 (Omar): real
  // clients are sent ONLY to the OS CRM's Reporting/Newsletter Email
  // (reporting_email). The ClickUp-synced .email is no longer used as a
  // send address — it caused sends to stale ClickUp contact emails when
  // the CRM had the correct one. Clients without reporting_email are
  // filtered out of sends (and flagged in the UI) until the strategist
  // sets the field in the OS CRM.
  //
  // Ad-hoc rows (typed into the batch modal; no DB id) keep using
  // .email — that IS the typed address, there's no CRM row behind it.
  const sendToOf = (r) => {
    if (!r?.id) return String(r?.email || '').trim();
    return String(r?.reporting_email || '').trim();
  };
  if (batch.ad_hoc_recipients && String(batch.ad_hoc_recipients).trim()) {
    const matches = String(batch.ad_hoc_recipients).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    const seen = new Set();
    const adHocEmails = matches.map(x => x.trim()).filter(x => {
      const k = x.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k); return true;
    });
    recipients = adHocEmails.map(addr => ({
      id:              null,                 // synthetic — no DB row
      name:            addr.split('@')[0],
      email:           addr,
      firm:            'Test Firm',
      account_manager: 'Test Manager',
      status:          'active',
      _adHoc:          true,
    }));
    if (!recipients.length) return bad(res, 400, 'Ad-hoc recipients field had no parseable email addresses');
  } else {
    const { data: members, error: memErr } = await sb
      .from('sender_clients_list_members')
      .select('recipient:sender_clients_recipients(*)')
      .eq('list_id', batch.audience_list_id);
    if (memErr) return bad(res, 400, memErr.message);

    // Statuses we'll actually send to. Was just 'active' — now includes
    // 'onboarding' and 'live' because the ClickUp CRM uses both, and the
    // monthly reports need to reach onboarding clients too.
    const SENDABLE_STATUSES = new Set([
      'active', 'onboarding', 'live',
      'hosting only', 'hosting-only', 'hosting_only', 'hosting',
    ]);
    // hasRealEmail = the field has at least one address that matches the
    // standard email shape. Placeholder values like "(no-email-clickup-…)"
    // synthesized for emailless ClickUp clients fail this check and are
    // silently filtered out of the send — they appear in the All Clients
    // list but never receive emails until a real address is added in
    // ClickUp and the team re-syncs.
    const hasRealEmail = (s) =>
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(String(s || ''));

    recipients = (members || [])
      .map(m => m.recipient)
      // Also exclude any recipient with skip_autosend=true — a Sender-local
      // opt-out flag independent of ClickUp status. See migration
      // sql/2026-08-27_recipient_skip_autosend.sql for the motivation.
      // Real /batches/:id/send only; test-send path deliberately ignores
      // this so a strategist can preview what the manual copy will look
      // like even when the recipient is skipped from auto-sends.
      .filter(r => r
        && hasRealEmail(sendToOf(r))
        && SENDABLE_STATUSES.has(String(r.status || '').toLowerCase())
        && !r.skip_autosend);

    if (!recipients.length) return bad(res, 400, 'No sendable recipients in this list (statuses checked: active / onboarding / live / hosting only — must have a Reporting/Newsletter Email set in the OS CRM)');
  }

  await sb.from('sender_sends_batches').update({
    status: 'sending',
    recipients_count: recipients.length,
  }).eq('id', batch.id);

  // For ad-hoc batches, recipient_id will be null on every row. We OMIT
  // the property rather than send null explicitly so Postgres uses its
  // column default — works whether the FK column is nullable or not, as
  // long as the DB migration to drop NOT NULL has been run.
  const queueRows = recipients.map(r => {
    const qr = {
      batch_id: batch.id,
      // Prefer reporting_email (CRM override) over the sync'd .email
      // from ClickUp. sendToOf is defined above.
      recipient_email: sendToOf(r),
      status: 'queued',
    };
    if (r.id) qr.recipient_id = r.id;
    return qr;
  });
  const { data: queued, error: qErr } = await sb
    .from('sender_sends_emails').insert(queueRows).select();
  if (qErr) return bad(res, 500, qErr.message);

  let delivered = 0, failed = 0;
  // Track per-recipient failures so the UI can show the actual Mailgun error
  // instead of just a "N failed" count. Without this, debugging required
  // opening Email Logs and reading each row by hand.
  const failures = [];

  // ClickUp's CRM stores multi-email fields with any separator (commas,
  // semicolons, newlines, even just spaces between addresses). Rather than
  // split on a delimiter list and risk missing one, extract every
  // email-shaped substring from the value. Mailgun then gets one valid
  // address per call.
  const splitEmails = (s) => {
    if (!s) return [];
    const matches = String(s).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    const seen = new Set();
    return matches.map(x => x.trim()).filter(x => {
      const k = x.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  for (const qi of queued) {
    // Match by the effective send-to (reporting_email override wins over
    // sync'd email) — works for both real (id) and ad-hoc (id=null) rows,
    // since ad-hoc batches can have many recipients sharing the same null id.
    const recipient = recipients.find(r => sendToOf(r) === qi.recipient_email) || {};
    const effectiveTo = sendToOf(recipient);
    const addresses = splitEmails(effectiveTo);
    if (!addresses.length) {
      // No valid email parsed — surface as a failure for this queue row.
      failed++;
      failures.push({ email: effectiveTo || '(empty)', reason: 'No valid email address could be parsed from this row' });
      await sb.from('sender_sends_emails').update({
        status: 'failed',
        error_message: 'No valid email parsed',
      }).eq('id', qi.id);
      continue;
    }

    // Full 22-variable merge row. Joins CRM client row by name for
    // website / ga4_property_id / ahrefs_project_id. Empty strings if
    // no CRM match — the template renders '' where those tags appear.
    const crmClient = await fetchCrmClientForRecipient(sb, recipient);
    const mergeRow  = buildMergeRow({
      recipient,
      batch,
      sender,
      crmClient,
      overrides: { email: addresses[0] },   // in case recipient.email has multiple
    });
    const subject = applyMergeVars(tpl.subject || batch.name, mergeRow);
    const html    = applyMergeVars(tpl.body_html, mergeRow);

    // Send to each parsed address. We count this queue row as "delivered"
    // if at least one of its addresses succeeded — Mailgun-side stats are
    // tracked per-address via the logs_events rows below.
    let anyOk    = false;
    let lastErr  = null;
    // Tracking + reconciliation tags, same for every address of this
    // recipient. Echoed back on every Mailgun event (delivered/opened/
    // clicked) so the events webhook attributes each one to the client +
    // cycle, and the post-send reconciliation can tell who was sent to.
    // clickup_task_id is the stable client key (maps to client.clickup_ticket_id,
    // immune to name drift). (Phase 1, 2026-10)
    const trackVars = {
      send_email_id: qi.id,
      batch_id: batch.id,
      recipient_id: recipient.id || '',
      clickup_task_id: recipient.clickup_task_id || '',
      client_name: recipient.name || '',
      report_month: mergeRow.report_month_year || '',
    };
    for (const addr of addresses) {
      try {
        const mg = await sendOne({ to: addr, subject, html, replyTo: mergeRow.sender_email || '', vars: trackVars, tags: ['monthly-report'] });
        anyOk = true;
        await sb.from('sender_logs_events').insert({
          send_email_id: qi.id, batch_id: batch.id,
          type: 'sent', recipient_email: addr,
          // Store the Mailgun message id so delivered/opened/clicked events
          // can be traced back to this send even aside from the custom vars.
          meta: mg?.id ? `mailgun_id=${mg.id}` : null,
        });
      } catch (err) {
        lastErr = String(err.message || err).slice(0, 500);
        failures.push({ email: addr, reason: lastErr });
        await sb.from('sender_logs_events').insert({
          send_email_id: qi.id, batch_id: batch.id,
          type: 'failed', recipient_email: addr,
          meta: lastErr,
        });
      }
    }

    if (anyOk) {
      delivered++;
      await sb.from('sender_sends_emails').update({
        status: 'delivered',
        sent_at: new Date().toISOString(),
      }).eq('id', qi.id);
      // Only stamp the recipient's last_emailed_at if this is a real saved
      // client (ad-hoc test rows have id=null and aren't in the DB).
      if (recipient.id) {
        await sb.from('sender_clients_recipients')
          .update({ last_emailed_at: new Date().toISOString() })
          .eq('id', recipient.id);
      }
    } else {
      failed++;
      await sb.from('sender_sends_emails').update({
        status: 'failed',
        error_message: lastErr || 'All addresses failed',
      }).eq('id', qi.id);
    }
  }

  await sb.from('sender_sends_batches').update({
    status: failed === recipients.length ? 'failed' : 'sent',
    sent_at: new Date().toISOString(),
  }).eq('id', batch.id);

  res.json({
    ok: true,
    batchId: batch.id,
    attempted: recipients.length,
    delivered,
    failed,
    failures,                                          // [{ email, reason }, …]
  });
}));

// ─── ClickUp sync + Rotating List ──────────────────────────────────────────
//
// Each list row in sender_clients_lists has an `is_fixed` flag. Rows with
// is_fixed=true are the account-manager lists — the sync auto-populates
// them from ClickUp Assignees matching the list name. is_fixed=false lists
// are manual (like the Rotating List).
//
// Managing the roster: use the ⚙ Manage lists button in the Sender UI to
// toggle is_fixed on/off or add a new fixed list. When someone joins or
// leaves CS, no code deploy is needed — just flip the toggle.
//
// The SENDER_FIXED_LISTS env var is a fallback used only when the DB has
// zero is_fixed=true rows (bootstrap case). Once the migration seeds the
// initial roster, the env var is ignored.

const FALLBACK_FIXED_LISTS = (process.env.SENDER_FIXED_LISTS || 'Alejandra,Faith,Luiza,Maria')
  .split(',').map(s => s.trim()).filter(Boolean);
const ROTATING_LIST_NAME = (process.env.SENDER_ROTATING_LIST_NAME || 'Rotating List').trim();

// Load the current set of fixed-list names from the DB. Falls back to the
// env var if nothing is flagged yet (first-run / pre-migration case).
async function loadFixedListNames(sb) {
  const { data, error } = await sb
    .from('sender_clients_lists')
    .select('name')
    .eq('is_fixed', true);
  if (error) throw new Error(`Could not load fixed lists: ${error.message}`);
  const names = (data || []).map(r => r.name).filter(Boolean);
  return names.length ? names : FALLBACK_FIXED_LISTS;
}

// Match a ClickUp assignee.username/email against an account-manager list
// name. We match if the list name appears anywhere in the assignee's display
// name OR email local-part — case-insensitive substring. So "Luiza" matches
// "luiza@goconstellation.com" AND "Luiza Feijo" AND "Luiza F."
function assigneeMatchesList(assignee, listName) {
  if (!assignee || !listName) return false;
  const target = String(listName).toLowerCase();
  const candidates = [
    String(assignee.name  || '').toLowerCase(),
    String(assignee.email || '').toLowerCase(),
  ];
  return candidates.some(c => c.includes(target));
}

/**
 * Ensure the manager lists (those with is_fixed=true) and the Rotating List
 * exist in sender_clients_lists. Idempotent — safe to call before every sync.
 * Returns an object keyed by list name with the {id, ...} row.
 *
 * `fixedNames` is loaded from the DB in the sync handler — this function
 * just makes sure any name in that list has a corresponding row (creates one
 * if missing, e.g. when the env fallback kicks in on a fresh install).
 */
async function ensureFixedLists(sb, fixedNames) {
  const wanted = [...fixedNames, ROTATING_LIST_NAME];
  const { data: existing } = await sb
    .from('sender_clients_lists')
    .select('id, name, owner, description, is_fixed')
    .in('name', wanted);
  const byName = Object.fromEntries((existing || []).map(l => [l.name, l]));

  const toCreate = wanted.filter(n => !byName[n]).map(n => ({
    name: n,
    owner: n === ROTATING_LIST_NAME ? null : n,
    is_fixed: n !== ROTATING_LIST_NAME,
    description: n === ROTATING_LIST_NAME
      ? 'Clients manually rotated off their default manager list. Move-back returns them to wherever they came from.'
      : `Auto-populated from ClickUp by assignee match on "${n}".`,
  }));
  if (toCreate.length) {
    const { data: created, error } = await sb
      .from('sender_clients_lists')
      .insert(toCreate)
      .select('id, name, owner, description, is_fixed');
    if (error) throw new Error(`Could not seed fixed lists: ${error.message}`);
    for (const row of (created || [])) byName[row.name] = row;
  }
  return byName;
}

// POST /api/clients-sync — pulls active+onboarding clients from ClickUp,
// upserts them into sender_clients_recipients (by email), and re-assigns
// list memberships based on assignees. Existing Rotating List memberships
// are preserved — a sync doesn't yank someone back from the rotation.
router.post('/clients-sync', wrap(async (_req, res) => {
  const sb = getSupabase();
  const fixedNames = await loadFixedListNames(sb);
  const lists = await ensureFixedLists(sb, fixedNames);   // {name → list row}
  const rotatingId = lists[ROTATING_LIST_NAME]?.id;

  let clients;
  try {
    clients = await fetchActiveClients();
  } catch (e) {
    return bad(res, 502, `ClickUp fetch failed: ${e.message}`);
  }

  // Look up which recipients are currently sitting in the Rotating List so
  // we can skip the manager-list reassignment for them (rotation is sticky).
  const { data: rotatingMembers } = rotatingId
    ? await sb.from('sender_clients_list_members').select('recipient_id').eq('list_id', rotatingId)
    : { data: [] };
  const stickyIds = new Set((rotatingMembers || []).map(m => m.recipient_id));

  let synced = 0, skipped = 0;
  // Reset the error buffer for this run so the response only shows errors
  // from THIS sync attempt, not stale ones from a previous run.
  global.__lastSyncErrors = [];

  // Collect every ClickUp task ID we saw this run so we can flag anything
  // else as orphaned at the end. Stored as strings to match the DB column.
  const seenClickupTaskIds = new Set();

  // Existing rows' emails keyed by clickup_task_id — used by the email-
  // downgrade guard below (2026-09-22, Dressie incident): a client whose
  // ClickUp email field goes empty must NOT have their working address
  // silently replaced with a "(no-email-clickup-…)" placeholder.
  const { data: existingRows } = await sb
    .from('sender_clients_recipients')
    .select('clickup_task_id, email');
  const existingEmailByTask = new Map(
    (existingRows || [])
      .filter(r => r.clickup_task_id)
      .map(r => [String(r.clickup_task_id), String(r.email || '')])
  );
  const isPlaceholderEmail = (e) => /^\(no-email-clickup-/.test(String(e || ''));

  for (const c of clients) {
    // Upsert the recipient row by clickup_task_id. See migration
    // sql/2026-08-26_recipient_clickup_task_id.sql for the "why":
    // email was the old key and it created a new row every time a
    // task's email was blank (synthetic placeholder), then never
    // reconciled — result was duplicate firms in All Clients.
    const clickupTaskId = String(c.id);
    seenClickupTaskIds.add(clickupTaskId);

    const accountManagerName = (c.assignees || [])
      .map(a => a.name || a.email || '')
      .filter(Boolean)
      .join(', ');
    const row = {
      clickup_task_id: clickupTaskId,
      name:            c.name,
      email:           c.email,
      firm:            c.firm || null,
      account_manager: accountManagerName || null,
      // first_name is extracted from a ClickUp custom field (see
      // FIRST_NAME_FIELD_NEEDLES in lib/crm.js). If the ClickUp task
      // doesn't have one populated yet, we leave the column NULL so
      // buildMergeRow falls back to firstWord(name) — the old behavior.
      // Overwriting each sync means a manual edit in Supabase would
      // get reverted; that's intentional — ClickUp is the source of truth.
      first_name:      c.first_name || null,
      // Preserve the real ClickUp status — was hardcoded to 'active' before,
      // which masked Onboarding clients in the UI (they all looked Active).
      status:          c.status || 'active',
      // Row is currently active in ClickUp — clear any stale orphan flag.
      orphaned_at:     null,
    };

    // Email-downgrade guard (2026-09-22): ClickUp stays the source of truth
    // for email — a CHANGED address still syncs through — but an EMPTY
    // ClickUp field (which arrives here as the synthetic placeholder) never
    // overwrites an existing real address. This is how Dressie's send-to
    // emails vanished: their ClickUp contact-email field went empty and the
    // next sync faithfully wiped the working address. Keep the old one and
    // log it loudly instead.
    if (isPlaceholderEmail(row.email)) {
      const existing = existingEmailByTask.get(clickupTaskId);
      if (existing && !isPlaceholderEmail(existing)) {
        row.email = existing;
        console.warn(`[clients-sync] ClickUp email is EMPTY for "${c.name}" — kept existing address ${existing} (fix the ClickUp field)`);
      }
    }

    // Heal legacy rows before upsert: any pre-migration row still
    // keyed only by email needs its clickup_task_id populated FIRST,
    // otherwise the onConflict:'clickup_task_id' upsert can't match it
    // and would insert a duplicate. The placeholder-email pattern is
    // covered by matching on email (real address) AND, for placeholder
    // rows, matching the "(no-email-clickup-<id>)" pattern.
    if (c.email) {
      await sb.from('sender_clients_recipients')
        .update({ clickup_task_id: clickupTaskId })
        .eq('email', c.email)
        .is('clickup_task_id', null);
    }
    // The placeholder-email variant: "(no-email-clickup-<task_id>)".
    // Same task id → same row we should be pointing at.
    await sb.from('sender_clients_recipients')
      .update({ clickup_task_id: clickupTaskId })
      .eq('email', `(no-email-clickup-${clickupTaskId})`)
      .is('clickup_task_id', null);

    const { data: upserted, error: upErr } = await sb
      .from('sender_clients_recipients')
      .upsert(row, { onConflict: 'clickup_task_id' })
      .select('id, email, original_list_id')
      .single();
    if (upErr) {
      // Surface a sample of upsert errors back to the caller. Previously
      // these were just silently skipped, which hid the real reason the
      // status field wasn't sticking — Postgres CHECK constraints on the
      // `status` column reject 'onboarding'/'live' if the constraint only
      // allows 'active' (etc.), and the row falls back to whatever it had
      // before. We keep the first 5 errors so the UI can show them.
      skipped++;
      if (!global.__lastSyncErrors) global.__lastSyncErrors = [];
      if (global.__lastSyncErrors.length < 5) {
        global.__lastSyncErrors.push({ email: row.email, error: upErr.message });
      }
      console.error('[clients-sync] upsert failed:', row.email, upErr.message);
      continue;
    }

    // If this recipient is in the Rotating List right now, don't touch their
    // manager-list memberships at all — rotation overrides auto-routing.
    if (stickyIds.has(upserted.id)) { synced++; continue; }

    // Figure out which manager list(s) this client belongs in.
    const matchedListIds = [];
    for (const managerName of fixedNames) {
      const listRow = lists[managerName];
      if (!listRow) continue;
      if ((c.assignees || []).some(a => assigneeMatchesList(a, managerName))) {
        matchedListIds.push(listRow.id);
      }
    }

    // Wipe existing manager-list memberships (but keep Rotating intact —
    // already filtered above) and re-write them from the match set.
    const managerListIds = fixedNames.map(n => lists[n]?.id).filter(Boolean);
    if (managerListIds.length) {
      await sb.from('sender_clients_list_members')
        .delete()
        .eq('recipient_id', upserted.id)
        .in('list_id', managerListIds);
    }
    if (matchedListIds.length) {
      await sb.from('sender_clients_list_members').insert(
        matchedListIds.map(list_id => ({ list_id, recipient_id: upserted.id }))
      );
    }
    synced++;
  }

  // Orphan sweep — any row that has a clickup_task_id but wasn't in this
  // sync's active set represents a task that was deleted, archived, or
  // filtered out of the active statuses in ClickUp. Flag it with
  // orphaned_at so it's visible for cleanup. Rows that never got a
  // clickup_task_id (untagged legacy) are left alone; they'll be healed
  // on subsequent syncs when their ClickUp task shows up in the pull.
  let orphaned = 0;
  if (seenClickupTaskIds.size) {
    // PostgREST doesn't accept an unbounded IN list well; batch to 500.
    // Any row NOT in the batch AND with a non-null clickup_task_id AND
    // not already flagged gets orphaned_at set to now(). We compute this
    // as a single query using the negation of the seen set.
    const seenList = [...seenClickupTaskIds]
      .map(id => `"${String(id).replace(/"/g, '\\"')}"`)
      .join(',');
    const { error: orphanErr, count } = await sb
      .from('sender_clients_recipients')
      .update({ orphaned_at: new Date().toISOString() }, { count: 'exact' })
      .not('clickup_task_id', 'is', null)
      .not('clickup_task_id', 'in', `(${seenList})`)
      .is('orphaned_at', null);
    if (orphanErr) {
      console.warn('[clients-sync] orphan sweep failed:', orphanErr.message);
    } else {
      orphaned = count || 0;
    }
  }

  res.json({
    ok:       true,
    synced,
    skipped,
    orphaned,
    errors:   global.__lastSyncErrors || [],
    lists:    Object.values(lists).map(l => ({ id: l.id, name: l.name })),
  });
}));

// POST /api/recipients/:id/move-to-rotating — remove from all manager lists,
// remember which one they came from on the recipient row, add to Rotating.
router.post('/recipients/:id/move-to-rotating', wrap(async (req, res) => {
  const sb = getSupabase();
  const recipientId = req.params.id;
  const fixedNames = await loadFixedListNames(sb);
  const lists = await ensureFixedLists(sb, fixedNames);
  const rotatingId = lists[ROTATING_LIST_NAME]?.id;
  if (!rotatingId) return bad(res, 500, 'Rotating List not configured');

  // Find current manager-list memberships so we can remember the "original"
  // before yanking them. If the client is in multiple manager lists (rare —
  // happens when someone is assigned to two managers in ClickUp), pick the
  // first one alphabetically — predictable, easy to reverse.
  const managerListIds = fixedNames.map(n => lists[n]?.id).filter(Boolean);
  const { data: currentMemberships } = await sb
    .from('sender_clients_list_members')
    .select('list_id')
    .eq('recipient_id', recipientId)
    .in('list_id', managerListIds);

  let originalId = null;
  if ((currentMemberships || []).length) {
    const candidates = currentMemberships.map(m => m.list_id);
    // sort by the fixedNames order, so "first alphabetically" really means
    // first in our configured fixed-list order.
    originalId = managerListIds.find(id => candidates.includes(id)) || candidates[0];
  }

  if (originalId) {
    await sb.from('sender_clients_recipients')
      .update({ original_list_id: originalId })
      .eq('id', recipientId);
  }

  // Remove from manager lists, then add to Rotating.
  if (managerListIds.length) {
    await sb.from('sender_clients_list_members')
      .delete()
      .eq('recipient_id', recipientId)
      .in('list_id', managerListIds);
  }
  // Idempotent insert (don't error if already in Rotating).
  await sb.from('sender_clients_list_members')
    .delete()
    .eq('recipient_id', recipientId)
    .eq('list_id', rotatingId);
  await sb.from('sender_clients_list_members').insert({
    list_id:      rotatingId,
    recipient_id: recipientId,
  });

  res.json({ ok: true, original_list_id: originalId });
}));

// POST /api/recipients/:id/move-back — inverse of move-to-rotating. Removes
// from Rotating, restores membership in the previously-stored original list,
// clears the original_list_id column.
router.post('/recipients/:id/move-back', wrap(async (req, res) => {
  const sb = getSupabase();
  const recipientId = req.params.id;
  const fixedNames = await loadFixedListNames(sb);
  const lists = await ensureFixedLists(sb, fixedNames);
  const rotatingId = lists[ROTATING_LIST_NAME]?.id;

  const { data: rec, error: recErr } = await sb
    .from('sender_clients_recipients')
    .select('id, original_list_id')
    .eq('id', recipientId)
    .single();
  if (recErr || !rec) return bad(res, 404, 'Recipient not found');

  const targetListId = rec.original_list_id;
  if (!targetListId) {
    return bad(res, 400, 'No original list recorded — was this client ever in the Rotating List? Run Sync from ClickUp to re-assign automatically.');
  }

  // Remove from Rotating.
  if (rotatingId) {
    await sb.from('sender_clients_list_members')
      .delete()
      .eq('recipient_id', recipientId)
      .eq('list_id', rotatingId);
  }
  // Add back to the original list (idempotent).
  await sb.from('sender_clients_list_members')
    .delete()
    .eq('recipient_id', recipientId)
    .eq('list_id', targetListId);
  await sb.from('sender_clients_list_members').insert({
    list_id:      targetListId,
    recipient_id: recipientId,
  });
  // Clear the original_list_id pointer now that they're back.
  await sb.from('sender_clients_recipients')
    .update({ original_list_id: null })
    .eq('id', recipientId);

  res.json({ ok: true, restored_to_list_id: targetListId });
}));

// POST /api/sync-assignees — trigger the CRM assignee reconciliation.
// Also called every N minutes by the timer in server.js. Idempotent.
router.post('/sync-assignees', async (_req, res, next) => {
  try {
    const result = await runAssigneeSync();
    res.json(result);
  } catch (e) { next(e); }
});

// ── Delete log rows ───────────────────────────────────────────────────────
// POST /api/logs/delete with body { log_ids: [uuid, uuid, ...] }
// Bulk-removes rows from sender_logs_events. Useful for clearing out
// spammy retry noise or old failures once they're resolved. Does NOT
// touch the underlying sender_sends_emails rows — those are the batch's
// permanent record; only the log-feed decoration goes away.
router.post('/logs/delete', wrap(async (req, res) => {
  const sb = getSupabase();
  const logIds = Array.isArray(req.body?.log_ids) ? req.body.log_ids : [];
  if (!logIds.length) return bad(res, 400, 'log_ids required');
  if (logIds.length > 500) return bad(res, 400, 'max 500 rows per delete');
  const { error } = await sb.from('sender_logs_events').delete().in('id', logIds);
  if (error) return bad(res, 500, error.message);
  return res.json({ ok: true, deleted: logIds.length });
}));

// ── Retry failed sends ────────────────────────────────────────────────────
// POST /api/logs/retry with body { log_ids: [uuid, uuid, ...] }
//
// Called from the Email Logs page after Omar picks which failed rows to
// resend (e.g. after fixing DMARC / lifting a Mailgun cap). For each log
// row:
//   1. Load the log event → get its send_email_id
//   2. Load the sender_sends_emails row → get batch_id + recipient_id
//   3. Load the batch and its template
//   4. Resolve the recipient (either the recipient_id row or a fallback
//      to the recipient_email column for ad-hoc test rows)
//   5. Rebuild the full 22-key mergeRow via buildMergeRow (same helper
//      the real send loop uses), apply merge vars to subject + html,
//      call sendOne() to Mailgun.
//   6. Write a new sender_logs_events row — type=sent or type=failed
//      (with a "(retry)" prefix in meta so the log clearly shows this
//      was a re-send, not the original).
//
// Best-effort per row: one failure doesn't abort the batch.
router.post('/logs/retry', wrap(async (req, res) => {
  const sb = getSupabase();
  ensureMailgun();

  const logIds = Array.isArray(req.body?.log_ids) ? req.body.log_ids : [];
  if (!logIds.length) return bad(res, 400, 'log_ids required');
  if (logIds.length > 200) return bad(res, 400, 'max 200 rows per retry');

  const { data: rawLogs, error: logsErr } = await sb
    .from('sender_logs_events')
    .select('id, send_email_id, batch_id, type, recipient_email, occurred_at')
    .in('id', logIds);
  if (logsErr) return bad(res, 500, `logs fetch: ${logsErr.message}`);
  if (!rawLogs?.length) return bad(res, 404, 'no matching log rows');

  // Dedupe by recipient_email so we never retry the same address twice
  // in a single call — the pile-up in Email Logs was partly caused by
  // Omar selecting duplicate rows and each attempt hitting Mailgun. Keep
  // the NEWEST log per recipient (highest occurred_at) so we operate on
  // the latest attempt. Duplicate log rows themselves get deleted below
  // as a cleanup pass so the UI stops showing stale copies.
  const byRecipient = new Map();
  const duplicateIds = [];
  for (const l of rawLogs) {
    const key = (l.recipient_email || '').toLowerCase();
    const prev = byRecipient.get(key);
    if (!prev || new Date(l.occurred_at) > new Date(prev.occurred_at)) {
      if (prev) duplicateIds.push(prev.id);
      byRecipient.set(key, l);
    } else {
      duplicateIds.push(l.id);
    }
  }
  if (duplicateIds.length) {
    // Delete the older duplicate log rows in the background — no need
    // to await, this is just log hygiene.
    sb.from('sender_logs_events').delete().in('id', duplicateIds)
      .then(() => {}, (err) => console.warn('duplicate log cleanup:', err?.message));
  }
  const logs = [...byRecipient.values()];

  // Cache per (batch, send_email) so we don't re-query for repeat lookups.
  const batchCache    = new Map(); // id → { batch, template }
  const sendCache     = new Map(); // id → sender_sends_emails row
  const recipientCache = new Map(); // id → sender_clients_recipients row

  async function loadBatch(id) {
    if (batchCache.has(id)) return batchCache.get(id);
    const [{ data: b }, ] = await Promise.all([
      sb.from('sender_sends_batches').select('*').eq('id', id).single(),
    ]);
    let t = null;
    if (b?.template_id) {
      const { data } = await sb
        .from('sender_templates_emails').select('*').eq('id', b.template_id).single();
      t = data;
    }
    const pair = { batch: b, template: t };
    batchCache.set(id, pair);
    return pair;
  }
  async function loadSend(id) {
    if (!id) return null;
    if (sendCache.has(id)) return sendCache.get(id);
    const { data } = await sb
      .from('sender_sends_emails').select('*').eq('id', id).single();
    sendCache.set(id, data);
    return data;
  }
  async function loadRecipient(id) {
    if (!id) return null;
    if (recipientCache.has(id)) return recipientCache.get(id);
    const { data } = await sb
      .from('sender_clients_recipients')
      .select('id, name, first_name, email, reporting_email, firm, account_manager, status, client_hub, tags, clickup_task_id')
      .eq('id', id).single();
    recipientCache.set(id, data);
    return data;
  }

  const results = [];
  for (const log of logs) {
    const outcome = { log_id: log.id, recipient_email: log.recipient_email, ok: false };
    try {
      // For test-send rows (send_email_id null) we can't reliably reconstruct
      // the original body — surface as skipped instead of silently failing.
      if (!log.send_email_id) {
        outcome.skipped = 'test-send row — no template context to rebuild';
        results.push(outcome);
        continue;
      }
      const send = await loadSend(log.send_email_id);
      if (!send) { outcome.error = 'send row not found'; results.push(outcome); continue; }
      const { batch, template } = await loadBatch(send.batch_id);
      if (!batch || !template) {
        outcome.error = 'batch or template missing';
        results.push(outcome);
        continue;
      }
      // Try to load the saved recipient row for full merge fidelity. Fall
      // back to a minimal shim built from recipient_email if the row is
      // gone (ad-hoc send, deleted client, etc.).
      let recipient = send.recipient_id
        ? await loadRecipient(send.recipient_id)
        : null;
      if (!recipient) {
        recipient = {
          name:  '',
          email: log.recipient_email,
          firm:  '',
          account_manager: '',
          status: 'live',
          client_hub: '',
        };
      }
      const crmClient = await fetchCrmClientForRecipient(sb, recipient);
      const sender    = await lookupSenderProfile(sb, batch.owner);
      const mergeRow  = buildMergeRow({
        recipient,
        batch,
        sender,
        crmClient,
        overrides: { email: log.recipient_email }, // send to the exact original addr
      });
      const subject = applyMergeVars(template.subject || batch.name, mergeRow);
      const html    = applyMergeVars(template.body_html || '', mergeRow);

      // Retried sends get the same tracking + reconciliation tags as the
      // original so their opens/clicks and delivery still attribute correctly.
      await sendOne({
        to: log.recipient_email, subject, html, replyTo: mergeRow.sender_email || '',
        vars: {
          send_email_id: send.id,
          batch_id: batch.id,
          recipient_id: send.recipient_id || '',
          clickup_task_id: recipient.clickup_task_id || '',
          client_name: recipient.name || '',
          report_month: mergeRow.report_month_year || '',
        },
        tags: ['monthly-report'],
      });
      outcome.ok = true;
      // Insert a fresh "sent" log for the retry so the outcome shows up
      // in All. Then delete the ORIGINAL failed log row so the Failed
      // tab clears — Omar's UX ask: "removed and moved to all".
      await sb.from('sender_logs_events').insert({
        send_email_id: send.id,
        batch_id: batch.id,
        type: 'sent',
        recipient_email: log.recipient_email,
        meta: `(retry) resent successfully`,
      });
      await sb.from('sender_logs_events').delete().eq('id', log.id);
      // Also flip the queue row back to delivered if it was failed.
      if (send.status === 'failed') {
        await sb.from('sender_sends_emails').update({
          status: 'delivered',
          sent_at: new Date().toISOString(),
          error_message: null,
        }).eq('id', send.id);
      }
    } catch (err) {
      outcome.error = String(err?.message || err).slice(0, 500);
      // Replace the original failed log with a fresh one reflecting this
      // retry attempt — otherwise every retry piles on a duplicate row
      // and the Failed count goes UP instead of staying flat / declining.
      // Net effect per row: exactly one failed entry, meta shows the
      // latest attempt's error.
      try {
        await sb.from('sender_logs_events').delete().eq('id', log.id);
        await sb.from('sender_logs_events').insert({
          send_email_id: log.send_email_id,
          batch_id: log.batch_id,
          type: 'failed',
          recipient_email: log.recipient_email,
          meta: `(retry) failed: ${outcome.error.slice(0, 200)}`,
        });
      } catch { /* keep going */ }
    }
    results.push(outcome);
  }
  const okCount   = results.filter(r => r.ok).length;
  const failCount = results.filter(r => !r.ok && !r.skipped).length;
  const skipCount = results.filter(r => r.skipped).length;
  return res.json({
    ok: failCount === 0,
    retried:  okCount,
    failed:   failCount,
    skipped:  skipCount,
    results,
  });
}));

module.exports = router;
