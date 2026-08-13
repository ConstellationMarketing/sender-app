'use strict';

// Assignee auto-sync — reconciles Sender's strategist-list memberships
// against the OS CRM (ClickUp Client Information list). Also maintains
// the "All Clients" newsletter-only audience list.
//
// Scope: manages 5 sync-owned lists — 4 strategist lists (Luiza,
// Alejandra, Faith, Maria) plus 1 newsletter-only "All Clients" list.
// Any OTHER list is left completely untouched.
//
// TWO STATUS RULES (Aug-14 change, refined):
//   • STRATEGIST_STATUSES (live/onboarding) — the 4 CS strategist lists
//     are for monthly-report sends, which only go to L+O clients.
//     Hosting recipients are excluded even if a strategist is assigned.
//   • NEWSLETTER_STATUSES (live/onboarding/hosting-variants) — the
//     "All Clients" list is used ONLY for the monthly newsletter, which
//     also goes to Hosting clients. sender_clients_lists.newsletter_only
//     column is true on this list so the Monthly Reports modal hides it.
//   Recipients whose status is in neither set are removed from every
//   sync-owned list.
//
// Sync logic per tick:
//   1. Fetch active + onboarding CRM clients (via lib/crm.js).
//   2. Match to a sender_clients_recipients row by normalized name.
//   3. Strategist lists — if recipient status in STRATEGIST_STATUSES and
//      an assignee matches a strategist token, ensure recipient is in
//      that strategist's list; remove from the other three. Else remove
//      from all 4 strategist lists.
//   4. All Clients list — if recipient status in NEWSLETTER_STATUSES,
//      ensure they're in the All Clients list. Else remove them.

const { fetchActiveClients } = require('./crm');
const { getSupabaseAdmin }   = require('./supabase');

const STRATEGISTS = ['Luiza', 'Alejandra', 'Faith', 'Maria'];
const STRATEGIST_TOKENS = STRATEGISTS.map(s => s.toLowerCase());

// Statuses eligible for the STRATEGIST lists (monthly reports only —
// live and onboarding). Hosting recipients are excluded here.
const STRATEGIST_STATUSES = new Set([
  'live',
  'onboarding',
]);

// Statuses eligible for the ALL CLIENTS newsletter list — live,
// onboarding, and every hosting-shaped variant we've seen in the
// recipients table.
const NEWSLETTER_STATUSES = new Set([
  'live',
  'onboarding',
  'hosting',
  'hosting-only',
]);

// Both "All Clients" lists share a display name — the dropdowns filter
// by report_only / newsletter_only so each modal shows exactly one row
// labelled "All Clients":
//   • Monthly Reports  → report_only=true row  (Live + Onboarding)
//   • Newsletter       → newsletter_only=true row (Live + Onboarding + Hosting)
const ALL_CLIENTS_LIST_NAME = 'All Clients';

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function strategistFromAssignees(assignees) {
  if (!Array.isArray(assignees)) return null;
  for (const a of assignees) {
    const hay = `${a.name || ''} ${a.email || ''}`.toLowerCase();
    for (let i = 0; i < STRATEGIST_TOKENS.length; i++) {
      if (hay.includes(STRATEGIST_TOKENS[i])) return STRATEGISTS[i];
    }
  }
  return null;
}

async function runAssigneeSync() {
  const sb = getSupabaseAdmin();
  const startedAt = Date.now();

  // Fetch strategist lists and BOTH "All Clients" rows (there are two —
  // one report_only=true, one newsletter_only=true).
  const [clients, listsRes, recipientsRes, membersRes] = await Promise.all([
    fetchActiveClients(),
    sb.from('sender_clients_lists').select('id, name, report_only, newsletter_only'),
    sb.from('sender_clients_recipients').select('id, name, status'),
    sb.from('sender_clients_list_members').select('recipient_id, list_id'),
  ]);
  if (listsRes.error)      throw new Error(`lists fetch: ${listsRes.error.message}`);
  if (recipientsRes.error) throw new Error(`recipients fetch: ${recipientsRes.error.message}`);
  if (membersRes.error)    throw new Error(`members fetch: ${membersRes.error.message}`);

  // Strategist lists resolve by name (unique). The two "All Clients"
  // lists resolve by flag.
  const listByName        = new Map();
  let allClientsReportRow = null;
  let allClientsNewsRow   = null;
  for (const l of (listsRes.data || [])) {
    if (STRATEGISTS.includes(l.name)) listByName.set(l.name, l.id);
    if (l.name === ALL_CLIENTS_LIST_NAME && l.report_only)     allClientsReportRow = l;
    if (l.name === ALL_CLIENTS_LIST_NAME && l.newsletter_only) allClientsNewsRow   = l;
  }

  // Ensure every sync-owned list exists (auto-bootstrap on fresh DBs).
  for (const name of STRATEGISTS) {
    if (!listByName.has(name)) {
      const ins = await sb
        .from('sender_clients_lists')
        .insert({ name, is_fixed: true, report_only: false, newsletter_only: false })
        .select('id, name')
        .single();
      if (ins.error) throw new Error(`create list ${name}: ${ins.error.message}`);
      listByName.set(ins.data.name, ins.data.id);
    }
  }
  if (!allClientsReportRow) {
    const ins = await sb
      .from('sender_clients_lists')
      .insert({ name: ALL_CLIENTS_LIST_NAME, is_fixed: true, report_only: true, newsletter_only: false })
      .select('id')
      .single();
    if (ins.error) throw new Error(`create list All Clients (report): ${ins.error.message}`);
    allClientsReportRow = { id: ins.data.id };
  }
  if (!allClientsNewsRow) {
    const ins = await sb
      .from('sender_clients_lists')
      .insert({ name: ALL_CLIENTS_LIST_NAME, is_fixed: true, report_only: false, newsletter_only: true })
      .select('id')
      .single();
    if (ins.error) throw new Error(`create list All Clients (newsletter): ${ins.error.message}`);
    allClientsNewsRow = { id: ins.data.id };
  }

  const strategistListIds = new Set(STRATEGISTS.map(n => listByName.get(n)));
  const allClientsReportListId = allClientsReportRow.id;
  const allClientsNewsListId   = allClientsNewsRow.id;
  const allSyncedListIds = new Set([
    ...strategistListIds,
    allClientsReportListId,
    allClientsNewsListId,
  ]);

  // Index recipients by normalized name (for CRM matching) AND by id
  // (for the All Clients pass, which needs to iterate every recipient
  // regardless of whether they appear in CRM).
  const recipientByKey = new Map();
  const recipientsById = new Map();
  for (const r of (recipientsRes.data || [])) {
    const normalized = {
      id:     r.id,
      name:   r.name,
      status: String(r.status || '').toLowerCase().replace(/[_\s-]+/g, '-'),
    };
    recipientByKey.set(normName(r.name), normalized);
    recipientsById.set(r.id, normalized);
  }

  // Current memberships restricted to sync-owned lists.
  //   key: recipient_id -> Set<list_id>
  const currentByRecipient = new Map();
  for (const m of (membersRes.data || [])) {
    if (!allSyncedListIds.has(m.list_id)) continue;
    if (!currentByRecipient.has(m.recipient_id)) currentByRecipient.set(m.recipient_id, new Set());
    currentByRecipient.get(m.recipient_id).add(m.list_id);
  }

  const toAdd = [];    // { recipient_id, list_id }
  const toRemove = []; // { recipient_id, list_id }
  const counters = {
    crm_clients: clients.length,
    matched_recipient: 0,
    strategist_resolved: 0,
    strategist_missing: 0,
    unmatched_recipient: 0,
    ineligible_status: 0,       // for strategist lists only
    all_clients_added: 0,
    all_clients_removed: 0,
    added: 0,
    removed: 0,
  };
  const unmatchedNames = [];

  // ── Pass 1: strategist lists (live/onboarding only) ─────────────
  for (const c of clients) {
    const key = normName(c.name);
    const rec = recipientByKey.get(key);
    if (!rec) {
      counters.unmatched_recipient++;
      if (unmatchedNames.length < 20) unmatchedNames.push(c.name);
      continue;
    }
    counters.matched_recipient++;

    // Not live/onboarding → remove from every strategist list. All
    // Clients membership is handled in pass 2 (which allows hosting).
    if (!STRATEGIST_STATUSES.has(rec.status)) {
      counters.ineligible_status++;
      const current = currentByRecipient.get(rec.id) || new Set();
      for (const lid of current) {
        if (strategistListIds.has(lid)) {
          toRemove.push({ recipient_id: rec.id, list_id: lid });
        }
      }
      continue;
    }

    const strat = strategistFromAssignees(c.assignees);
    if (!strat) {
      counters.strategist_missing++;
      continue;
    }
    counters.strategist_resolved++;

    const targetListId = listByName.get(strat);
    const current = currentByRecipient.get(rec.id) || new Set();

    if (!current.has(targetListId)) {
      toAdd.push({ recipient_id: rec.id, list_id: targetListId });
    }
    for (const name of STRATEGISTS) {
      if (name === strat) continue;
      const lid = listByName.get(name);
      if (current.has(lid)) {
        toRemove.push({ recipient_id: rec.id, list_id: lid });
      }
    }
  }

  // ── Pass 2: two "All Clients" lists ─────────────────────────────
  //
  // Same display name in the UI, different scope:
  //   • report_only=true row  → Live + Onboarding (Monthly Reports)
  //   • newsletter_only=true row → Live + Onboarding + Hosting (Newsletter)
  //
  // Iterates EVERY recipient (not just CRM-matched ones) so hosting
  // clients who aren't in fetchActiveClients() still land in the
  // newsletter list.
  for (const rec of recipientsById.values()) {
    const current = currentByRecipient.get(rec.id) || new Set();

    // Report list: live/onboarding only.
    const inReport   = current.has(allClientsReportListId);
    const reportOk   = STRATEGIST_STATUSES.has(rec.status);
    if (reportOk && !inReport) {
      toAdd.push({ recipient_id: rec.id, list_id: allClientsReportListId });
      counters.all_clients_added++;
    } else if (!reportOk && inReport) {
      toRemove.push({ recipient_id: rec.id, list_id: allClientsReportListId });
      counters.all_clients_removed++;
    }

    // Newsletter list: live/onboarding/hosting.
    const inNews     = current.has(allClientsNewsListId);
    const newsOk     = NEWSLETTER_STATUSES.has(rec.status);
    if (newsOk && !inNews) {
      toAdd.push({ recipient_id: rec.id, list_id: allClientsNewsListId });
      counters.all_clients_added++;
    } else if (!newsOk && inNews) {
      toRemove.push({ recipient_id: rec.id, list_id: allClientsNewsListId });
      counters.all_clients_removed++;
    }
  }

  // Apply diff.
  if (toAdd.length) {
    // Chunk so no single insert is too big.
    for (let i = 0; i < toAdd.length; i += 100) {
      const chunk = toAdd.slice(i, i + 100);
      const r = await sb.from('sender_clients_list_members').insert(chunk);
      if (r.error) throw new Error(`insert members: ${r.error.message}`);
    }
    counters.added = toAdd.length;
  }
  for (const m of toRemove) {
    const r = await sb
      .from('sender_clients_list_members')
      .delete()
      .eq('recipient_id', m.recipient_id)
      .eq('list_id', m.list_id);
    if (r.error) throw new Error(`delete member ${m.recipient_id}/${m.list_id}: ${r.error.message}`);
  }
  counters.removed = toRemove.length;

  return {
    ok: true,
    ms: Date.now() - startedAt,
    targets: [...STRATEGISTS, ALL_CLIENTS_LIST_NAME],
    counters,
    unmatched_recipient_names_sample: unmatchedNames,
  };
}

module.exports = { runAssigneeSync };
