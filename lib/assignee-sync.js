'use strict';

// Assignee auto-sync — reconciles Sender's strategist-list memberships
// against the OS CRM (ClickUp Client Information list).
//
// Scope: this only manages the 4 fixed strategist lists — Luiza,
// Alejandra, Faith, Maria (Maria added Aug-14, 2026). Any other list
// (custom, per-team, per-campaign) is left completely untouched. That's
// on purpose so this sync can't clobber lists it doesn't own.
//
// STATUS FILTER (Aug-14 change):
//   Only recipients whose status is 'live' or 'onboarding' are eligible
//   for the strategist lists. Hosting/hosting-only/churned/etc. clients
//   are excluded even if their CRM record has a strategist assigned.
//   This fixed a Faith-list bug where Hosting clients were appearing
//   because the CS strategist was still listed as the ClickUp assignee.
//   If a recipient with the wrong status is currently on a strategist
//   list, this sync REMOVES them (data-loss on purpose — the list
//   should never contain a non-live/onboarding client).
//
// Match logic:
//   1. Fetch active + onboarding CRM clients (via lib/crm.js).
//   2. Match to a sender_clients_recipients row by normalized name;
//      also pull the recipient's status (needed for the filter above).
//   3. Determine strategist by scanning assignees[].name /
//      assignees[].email for the tokens "luiza", "alejandra", "faith",
//      "maria" (case-insensitive substring). First match wins.
//   4. If recipient status is NOT live/onboarding → remove them from all
//      4 target lists and skip.
//   5. Otherwise ensure recipient is in the resolved strategist's list;
//      remove from the other three if present.
//   6. If NO assignee matched, leave memberships alone (except for the
//      status-removal in step 4).

const { fetchActiveClients } = require('./crm');
const { getSupabaseAdmin }   = require('./supabase');

const TARGETS = ['Luiza', 'Alejandra', 'Faith', 'Maria'];
const TARGET_TOKENS = TARGETS.map(s => s.toLowerCase());

// Statuses a recipient must have to be eligible for the strategist lists.
// Everything else (hosting, hosting-only, churned, paused, etc.) is
// excluded — even if the CRM record has a strategist assigned.
const ELIGIBLE_STATUSES = new Set([
  'live',
  'onboarding',
]);

function normName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function strategistFromAssignees(assignees) {
  if (!Array.isArray(assignees)) return null;
  for (const a of assignees) {
    const hay = `${a.name || ''} ${a.email || ''}`.toLowerCase();
    for (let i = 0; i < TARGET_TOKENS.length; i++) {
      if (hay.includes(TARGET_TOKENS[i])) return TARGETS[i];
    }
  }
  return null;
}

async function runAssigneeSync() {
  const sb = getSupabaseAdmin();
  const startedAt = Date.now();

  const [clients, listsRes, recipientsRes, membersRes] = await Promise.all([
    fetchActiveClients(),
    sb.from('sender_clients_lists').select('id, name').in('name', TARGETS),
    // status is now consulted (see ELIGIBLE_STATUSES) — Hosting etc.
    // recipients are excluded from the strategist lists.
    sb.from('sender_clients_recipients').select('id, name, status'),
    sb.from('sender_clients_list_members').select('recipient_id, list_id'),
  ]);
  if (listsRes.error)      throw new Error(`lists fetch: ${listsRes.error.message}`);
  if (recipientsRes.error) throw new Error(`recipients fetch: ${recipientsRes.error.message}`);
  if (membersRes.error)    throw new Error(`members fetch: ${membersRes.error.message}`);

  const listByName = new Map();
  for (const l of (listsRes.data || [])) listByName.set(l.name, l.id);
  const targetListIds = new Set([...listByName.values()]);

  // Ensure the 3 lists exist (create missing ones on the fly so a
  // brand-new environment can bootstrap without SQL).
  for (const name of TARGETS) {
    if (!listByName.has(name)) {
      const ins = await sb
        .from('sender_clients_lists')
        .insert({ name, is_fixed: true })
        .select('id, name')
        .single();
      if (ins.error) throw new Error(`create list ${name}: ${ins.error.message}`);
      listByName.set(ins.data.name, ins.data.id);
      targetListIds.add(ins.data.id);
    }
  }

  // Index recipients by normalized name for fast CRM -> recipient match.
  // Also stash status so we can gate on live/onboarding.
  const recipientByKey = new Map();
  for (const r of (recipientsRes.data || [])) {
    recipientByKey.set(normName(r.name), {
      id:     r.id,
      name:   r.name,
      status: String(r.status || '').toLowerCase().replace(/[_\s-]+/g, '-'),
    });
  }

  // Current memberships restricted to the 3 target lists.
  //   key: recipient_id -> Set<list_id>
  const currentByRecipient = new Map();
  for (const m of (membersRes.data || [])) {
    if (!targetListIds.has(m.list_id)) continue;
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
    ineligible_status: 0,   // NEW: recipient not live/onboarding
    added: 0,
    removed: 0,
  };
  const unmatchedNames = [];

  for (const c of clients) {
    const key = normName(c.name);
    const rec = recipientByKey.get(key);
    if (!rec) {
      counters.unmatched_recipient++;
      if (unmatchedNames.length < 20) unmatchedNames.push(c.name);
      continue;
    }
    counters.matched_recipient++;

    // Status gate — Hosting / hosting-only / churned / paused / etc.
    // recipients are excluded even if a strategist is assigned. If they
    // happen to currently be on any of the 4 strategist lists, remove
    // them so the list matches the eligibility rule.
    if (!ELIGIBLE_STATUSES.has(rec.status)) {
      counters.ineligible_status++;
      const current = currentByRecipient.get(rec.id) || new Set();
      for (const lid of current) {
        if (targetListIds.has(lid)) {
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

    // Add to target list if missing.
    if (!current.has(targetListId)) {
      toAdd.push({ recipient_id: rec.id, list_id: targetListId });
    }
    // Remove from the OTHER strategist lists if present.
    for (const [name, lid] of listByName.entries()) {
      if (name === strat) continue;
      if (current.has(lid)) {
        toRemove.push({ recipient_id: rec.id, list_id: lid });
      }
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
    targets: TARGETS,
    counters,
    unmatched_recipient_names_sample: unmatchedNames,
  };
}

module.exports = { runAssigneeSync };
