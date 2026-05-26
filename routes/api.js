'use strict';

// Sender API. Read endpoints + CRUD for every entity + batch sending + CSV import.
// Every async handler is wrapped with `wrap()` so thrown errors become a
// clean 500 instead of crashing the Node process.

const express = require('express');
const { getSupabase } = require('../lib/supabase');
const { sendOne, applyMergeVars, ensureEnv: ensureMailgun } = require('../lib/mailgun');
const { parseCsv } = require('../lib/csv');

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
router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
    env: {
      SUPABASE_URL:              !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      MAILGUN_API_KEY:           !!process.env.MAILGUN_API_KEY,
      MAILGUN_DOMAIN:            !!process.env.MAILGUN_DOMAIN,
      MAILGUN_FROM:              !!process.env.MAILGUN_FROM,
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
    sb.from('sender_clients_recipients').select('*').order('name'),
    sb.from('sender_clients_lists').select('*').order('name'),
    sb.from('sender_clients_list_members').select('list_id, recipient_id'),
    sb.from('sender_templates_emails').select('*').order('updated_at', { ascending: false }),
    sb.from('sender_sends_batches').select('*').order('created_at', { ascending: false }),
    sb.from('sender_sends_emails').select('*').order('created_at', { ascending: false }).limit(200),
    sb.from('sender_logs_events').select('*').order('occurred_at', { ascending: false }).limit(200),
    sb.from('users_profiles').select('id, full_name, email, role').order('full_name', { ascending: true, nullsFirst: false }),
    sb.from('sender_clients_recipients').select('id', { count: 'exact', head: true }).eq('status', 'active'),
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
  const row = clean(req.body || {}, ['name','email','firm','account_manager','status','tags']);
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
  const row = clean(req.body || {}, ['name','email','firm','account_manager','status','tags']);
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
  const row = clean(req.body || {}, ['name','description','owner']);
  if (!row.name) return bad(res, 400, 'name is required');
  const { data, error } = await sb.from('sender_clients_lists').insert(row).select().single();
  if (error) return bad(res, 400, error.message);
  res.status(201).json(data);
}));

router.patch('/lists/:id', wrap(async (req, res) => {
  const sb = getSupabase();
  const row = clean(req.body || {}, ['name','description','owner']);
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
  const row = clean(req.body || {}, ['name','type','audience_list_id','template_id','status','scheduled_at','owner']);
  if (!row.name) return bad(res, 400, 'name is required');
  if (!row.type) return bad(res, 400, 'type is required (newsletter | report | broadcast)');
  row.status = row.status || 'draft';
  const { data, error } = await sb.from('sender_sends_batches').insert(row).select().single();
  if (error) return bad(res, 400, error.message);
  res.status(201).json(data);
}));

router.patch('/batches/:id', wrap(async (req, res) => {
  const sb = getSupabase();
  const row = clean(req.body || {}, ['name','type','audience_list_id','template_id','status','scheduled_at','owner']);
  const { data, error } = await sb.from('sender_sends_batches').update(row).eq('id', req.params.id).select().single();
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

// ─── SEND a batch ──────────────────────────────────────────────────────────
router.post('/batches/:id/send', wrap(async (req, res) => {
  const sb = getSupabase();
  ensureMailgun();   // throws → caught by wrap → 500 with message

  const { data: batch, error: batchErr } = await sb
    .from('sender_sends_batches').select('*').eq('id', req.params.id).single();
  if (batchErr || !batch) return bad(res, 404, batchErr?.message || 'Batch not found');

  if (!batch.template_id)      return bad(res, 400, 'Batch has no template');
  if (!batch.audience_list_id) return bad(res, 400, 'Batch has no audience list');

  const { data: tpl, error: tplErr } = await sb
    .from('sender_templates_emails').select('*').eq('id', batch.template_id).single();
  if (tplErr || !tpl) return bad(res, 400, 'Template not found');

  const { data: members, error: memErr } = await sb
    .from('sender_clients_list_members')
    .select('recipient:sender_clients_recipients(*)')
    .eq('list_id', batch.audience_list_id);
  if (memErr) return bad(res, 400, memErr.message);

  const recipients = (members || [])
    .map(m => m.recipient)
    .filter(r => r && r.email && r.status === 'active');

  if (!recipients.length) return bad(res, 400, 'No active recipients in this list');

  await sb.from('sender_sends_batches').update({
    status: 'sending',
    recipients_count: recipients.length,
  }).eq('id', batch.id);

  const queueRows = recipients.map(r => ({
    batch_id: batch.id,
    recipient_id: r.id,
    recipient_email: r.email,
    status: 'queued',
  }));
  const { data: queued, error: qErr } = await sb
    .from('sender_sends_emails').insert(queueRows).select();
  if (qErr) return bad(res, 500, qErr.message);

  let delivered = 0, failed = 0;
  // Track per-recipient failures so the UI can show the actual Mailgun error
  // instead of just a "N failed" count. Without this, debugging required
  // opening Email Logs and reading each row by hand.
  const failures = [];

  for (const qi of queued) {
    const recipient = recipients.find(r => r.id === qi.recipient_id) || {};
    const mergeRow = {
      name: recipient.name,
      client_name: recipient.name,
      email: recipient.email,
      firm: recipient.firm,
      account_manager: recipient.account_manager,
    };
    const subject = applyMergeVars(tpl.subject || batch.name, mergeRow);
    const html    = applyMergeVars(tpl.body_html, mergeRow);

    try {
      await sendOne({ to: recipient.email, subject, html });
      delivered++;
      await sb.from('sender_sends_emails').update({
        status: 'delivered',
        sent_at: new Date().toISOString(),
      }).eq('id', qi.id);
      await sb.from('sender_logs_events').insert({
        send_email_id: qi.id, batch_id: batch.id,
        type: 'sent', recipient_email: recipient.email,
      });
      await sb.from('sender_clients_recipients')
        .update({ last_emailed_at: new Date().toISOString() })
        .eq('id', recipient.id);
    } catch (err) {
      failed++;
      const reason = String(err.message || err).slice(0, 500);
      failures.push({ email: recipient.email, reason });
      await sb.from('sender_sends_emails').update({
        status: 'failed',
        error_message: reason,
      }).eq('id', qi.id);
      await sb.from('sender_logs_events').insert({
        send_email_id: qi.id, batch_id: batch.id,
        type: 'failed', recipient_email: recipient.email,
        meta: reason,
      });
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

module.exports = router;
