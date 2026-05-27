'use strict';

// Sender API. Read endpoints + CRUD for every entity + batch sending + CSV import.
// Every async handler is wrapped with `wrap()` so thrown errors become a
// clean 500 instead of crashing the Node process.

const express = require('express');
const { getSupabase } = require('../lib/supabase');
const { sendOne, applyMergeVars, ensureEnv: ensureMailgun } = require('../lib/mailgun');
const { parseCsv } = require('../lib/csv');
// fetchActiveClients now reads from the OS CRM's Supabase `client` table
// (the source of truth ClickUp itself feeds into), so no new env vars are
// needed beyond the Supabase keys the app already has.
const { fetchActiveClients } = require('../lib/crm');

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
    // Select * already brings original_list_id; explicit here so future
    // schema changes don't accidentally drop the column from the payload.
    sb.from('sender_clients_recipients').select('*').order('name'),
    sb.from('sender_clients_lists').select('*').order('name'),
    sb.from('sender_clients_list_members').select('list_id, recipient_id'),
    sb.from('sender_templates_emails').select('*').order('updated_at', { ascending: false }),
    sb.from('sender_sends_batches').select('*').order('created_at', { ascending: false }),
    sb.from('sender_sends_emails').select('*').order('created_at', { ascending: false }).limit(200),
    sb.from('sender_logs_events').select('*').order('occurred_at', { ascending: false }).limit(200),
    sb.from('users_profiles').select('id, full_name, email, role').order('full_name', { ascending: true, nullsFirst: false }),
    // KPI counts everyone who could plausibly receive an email — same set
    // the send loop uses (active / onboarding / live). Was just 'active'.
    sb.from('sender_clients_recipients').select('id', { count: 'exact', head: true }).in('status', ['active', 'onboarding', 'live']),
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

  const toEmail = String(req.body?.to || '').trim();
  if (!toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
    return bad(res, 400, 'A valid `to` email is required for the test send');
  }
  const sampleRecipientId = req.body?.sample_recipient_id || null;

  const { data: batch, error: batchErr } = await sb
    .from('sender_sends_batches').select('*').eq('id', req.params.id).single();
  if (batchErr || !batch)      return bad(res, 404, batchErr?.message || 'Batch not found');
  if (!batch.template_id)      return bad(res, 400, 'Batch has no template — assign one first');

  const { data: tpl, error: tplErr } = await sb
    .from('sender_templates_emails').select('*').eq('id', batch.template_id).single();
  if (tplErr || !tpl) return bad(res, 400, 'Template not found');

  // Pull merge-variable values from a sample recipient if one was given,
  // OR from the first recipient on the audience list if available, OR
  // fall back to clearly-labeled placeholders so the test obviously isn't
  // pretending to be a real client.
  let mergeRow = {
    name:            'Test Recipient',
    client_name:     'Test Recipient',
    email:           toEmail,
    firm:            'Test Firm LLP',
    account_manager: 'Test Manager',
  };
  if (sampleRecipientId) {
    const { data: sample } = await sb
      .from('sender_clients_recipients')
      .select('name, email, firm, account_manager')
      .eq('id', sampleRecipientId)
      .single();
    if (sample) {
      mergeRow = {
        name: sample.name, client_name: sample.name,
        email: toEmail,  // we still send to the test address, not the real one
        firm: sample.firm, account_manager: sample.account_manager,
      };
    }
  } else if (batch.audience_list_id) {
    // Grab the first active member of the audience list so the test email
    // shows what a real send to that list would look like.
    const { data: members } = await sb
      .from('sender_clients_list_members')
      .select('recipient:sender_clients_recipients(name, email, firm, account_manager, status)')
      .eq('list_id', batch.audience_list_id)
      .limit(5);
    const sample = (members || []).map(m => m.recipient).find(r => r && r.status === 'active' || r && r.status === 'live' || r && r.status === 'onboarding');
    if (sample) {
      mergeRow = {
        name: sample.name, client_name: sample.name,
        email: toEmail,
        firm: sample.firm, account_manager: sample.account_manager,
      };
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

  try {
    const result = await sendOne({ to: toEmail, subject, html });
    return res.json({
      ok: true,
      to: toEmail,
      mergedFrom: mergeRow.name,
      mailgun: result,
    });
  } catch (e) {
    return bad(res, 502, `Test send failed: ${e.message || e}`);
  }
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

  // Statuses we'll actually send to. Was just 'active' — now includes
  // 'onboarding' and 'live' because the ClickUp CRM uses both, and the
  // monthly reports need to reach onboarding clients too.
  const SENDABLE_STATUSES = new Set(['active', 'onboarding', 'live']);
  const recipients = (members || [])
    .map(m => m.recipient)
    .filter(r => r && r.email && SENDABLE_STATUSES.has(String(r.status || '').toLowerCase()));

  if (!recipients.length) return bad(res, 400, 'No sendable recipients in this list (statuses checked: active / onboarding / live)');

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
    const recipient = recipients.find(r => r.id === qi.recipient_id) || {};
    const addresses = splitEmails(recipient.email);
    if (!addresses.length) {
      // No valid email parsed — surface as a failure for this queue row.
      failed++;
      failures.push({ email: recipient.email || '(empty)', reason: 'No valid email address could be parsed from this row' });
      await sb.from('sender_sends_emails').update({
        status: 'failed',
        error_message: 'No valid email parsed',
      }).eq('id', qi.id);
      continue;
    }

    const mergeRow = {
      name: recipient.name,
      client_name: recipient.name,
      email: addresses[0],          // for {{email}} merge var — use the first one
      firm: recipient.firm,
      account_manager: recipient.account_manager,
    };
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
      await sb.from('sender_clients_recipients')
        .update({ last_emailed_at: new Date().toISOString() })
        .eq('id', recipient.id);
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
// Four lists are treated as "fixed" in the new UI: Luiza, Federico,
// Alejandra (account-manager lists, populated from ClickUp), and Rotating
// List (where users manually shuffle clients between managers). The list
// names are configurable via env, so a name change in the team doesn't
// require a code edit. Defaults match what the spec asked for.

const FIXED_LISTS = (process.env.SENDER_FIXED_LISTS || 'Luiza,Federico,Alejandra')
  .split(',').map(s => s.trim()).filter(Boolean);
const ROTATING_LIST_NAME = (process.env.SENDER_ROTATING_LIST_NAME || 'Rotating List').trim();

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
 * Ensure the four fixed lists (three managers + Rotating) exist in
 * sender_clients_lists. Idempotent — safe to call before every sync. Returns
 * an object keyed by list name with the {id, ...} row.
 */
async function ensureFixedLists(sb) {
  const wanted = [...FIXED_LISTS, ROTATING_LIST_NAME];
  const { data: existing } = await sb
    .from('sender_clients_lists')
    .select('id, name, owner, description')
    .in('name', wanted);
  const byName = Object.fromEntries((existing || []).map(l => [l.name, l]));

  const toCreate = wanted.filter(n => !byName[n]).map(n => ({
    name: n,
    owner: n === ROTATING_LIST_NAME ? null : n,
    description: n === ROTATING_LIST_NAME
      ? 'Clients manually rotated off their default manager list. Move-back returns them to wherever they came from.'
      : `Auto-populated from ClickUp by assignee match on "${n}".`,
  }));
  if (toCreate.length) {
    const { data: created, error } = await sb
      .from('sender_clients_lists')
      .insert(toCreate)
      .select('id, name, owner, description');
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
  const lists = await ensureFixedLists(sb);   // {name → list row}
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

  for (const c of clients) {
    // Upsert the recipient row by email.
    const accountManagerName = (c.assignees || [])
      .map(a => a.name || a.email || '')
      .filter(Boolean)
      .join(', ');
    const row = {
      name:            c.name,
      email:           c.email,
      firm:            c.firm || null,
      account_manager: accountManagerName || null,
      // Preserve the real ClickUp status — was hardcoded to 'active' before,
      // which masked Onboarding clients in the UI (they all looked Active).
      status:          c.status || 'active',
    };
    const { data: upserted, error: upErr } = await sb
      .from('sender_clients_recipients')
      .upsert(row, { onConflict: 'email' })
      .select('id, email, original_list_id')
      .single();
    if (upErr) { skipped++; continue; }

    // If this recipient is in the Rotating List right now, don't touch their
    // manager-list memberships at all — rotation overrides auto-routing.
    if (stickyIds.has(upserted.id)) { synced++; continue; }

    // Figure out which manager list(s) this client belongs in.
    const matchedListIds = [];
    for (const managerName of FIXED_LISTS) {
      const listRow = lists[managerName];
      if (!listRow) continue;
      if ((c.assignees || []).some(a => assigneeMatchesList(a, managerName))) {
        matchedListIds.push(listRow.id);
      }
    }

    // Wipe existing manager-list memberships (but keep Rotating intact —
    // already filtered above) and re-write them from the match set.
    const managerListIds = FIXED_LISTS.map(n => lists[n]?.id).filter(Boolean);
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

  res.json({
    ok:       true,
    synced,
    skipped,
    lists:    Object.values(lists).map(l => ({ id: l.id, name: l.name })),
  });
}));

// POST /api/recipients/:id/move-to-rotating — remove from all manager lists,
// remember which one they came from on the recipient row, add to Rotating.
router.post('/recipients/:id/move-to-rotating', wrap(async (req, res) => {
  const sb = getSupabase();
  const recipientId = req.params.id;
  const lists = await ensureFixedLists(sb);
  const rotatingId = lists[ROTATING_LIST_NAME]?.id;
  if (!rotatingId) return bad(res, 500, 'Rotating List not configured');

  // Find current manager-list memberships so we can remember the "original"
  // before yanking them. If the client is in multiple manager lists (rare —
  // happens when someone is assigned to two managers in ClickUp), pick the
  // first one alphabetically — predictable, easy to reverse.
  const managerListIds = FIXED_LISTS.map(n => lists[n]?.id).filter(Boolean);
  const { data: currentMemberships } = await sb
    .from('sender_clients_list_members')
    .select('list_id')
    .eq('recipient_id', recipientId)
    .in('list_id', managerListIds);

  let originalId = null;
  if ((currentMemberships || []).length) {
    const candidates = currentMemberships.map(m => m.list_id);
    // sort by the FIXED_LISTS order, so "first alphabetically" really means
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
  const lists = await ensureFixedLists(sb);
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

module.exports = router;
