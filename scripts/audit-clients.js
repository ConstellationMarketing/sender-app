#!/usr/bin/env node
'use strict';

// Walks every task in the ClickUp Client Information list and reports:
//   • how many per status (raw — what ClickUp actually returns)
//   • how many per status that pass the sender's email + status filter
//   • the names of the ones that get dropped, so we can see whether the
//     drops are intentional (no email = no send target) or a bug
//
// Run on the VPS:
//   export CLICKUP_API_KEY=$(grep -E '^CLICKUP_API_KEY=' /opt/sender-app/.env | cut -d= -f2-)
//   node scripts/audit-clients.js

const CLICKUP_BASE  = 'https://api.clickup.com/api/v2';
const LIST_ID       = process.env.CRM_CLICKUP_LIST_ID || '901703957188';
const WANT_STATUSES = new Set([
  'active', 'onboarding', 'live',
  'hosting only', 'hosting-only', 'hosting_only', 'hosting',
]);
const EMAIL_FIELD_NEEDLES = ['primary contact email', 'contact email', 'email'];

function getKey() {
  const k = process.env.CLICKUP_API_KEY;
  if (!k) { console.error('CLICKUP_API_KEY not set'); process.exit(2); }
  return k;
}

async function cuFetch(path) {
  const r = await fetch(`${CLICKUP_BASE}${path}`, {
    headers: { Authorization: getKey(), Accept: 'application/json' },
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`ClickUp ${r.status}: ${(json && (json.err || json.error)) || text}`);
  return json;
}

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

(async () => {
  const all = [];
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      page: String(page),
      archived: 'false',
      subtasks: 'false',
      include_closed: 'true',
    });
    const data = await cuFetch(`/list/${LIST_ID}/task?${params}`);
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
    all.push(...tasks);
    if (tasks.length < 100) break;
  }

  const byStatus = new Map();
  const droppedNoEmail = new Map();   // status → list of names dropped because no email
  const droppedBadStatus = new Map(); // status → list of names dropped because status not in whitelist
  let passed = 0;

  for (const t of all) {
    const rawStatus = String(t?.status?.status || '').toLowerCase();
    const counts = byStatus.get(rawStatus) || { total: 0, withEmail: 0, withoutEmail: 0 };
    counts.total++;
    const email = findCustomField(t, EMAIL_FIELD_NEEDLES);
    if (email) counts.withEmail++; else counts.withoutEmail++;
    byStatus.set(rawStatus, counts);

    if (!WANT_STATUSES.has(rawStatus)) {
      const list = droppedBadStatus.get(rawStatus) || [];
      if (list.length < 10) list.push(t.name);
      droppedBadStatus.set(rawStatus, list);
      continue;
    }
    if (!email) {
      const list = droppedNoEmail.get(rawStatus) || [];
      if (list.length < 30) list.push(t.name);
      droppedNoEmail.set(rawStatus, list);
      continue;
    }
    passed++;
  }

  console.log(`Total tasks in list ${LIST_ID}: ${all.length}`);
  console.log(`Passed sender filter: ${passed}`);
  console.log('');
  console.log('━━━ STATUS BREAKDOWN ━━━');
  for (const [status, counts] of [...byStatus.entries()].sort()) {
    const ok = WANT_STATUSES.has(status) ? '✓ in whitelist' : '✗ filtered out';
    console.log(`  "${status}": ${counts.total} total · ${counts.withEmail} with email · ${counts.withoutEmail} without · ${ok}`);
  }
  console.log('');
  console.log('━━━ DROPPED FOR NO EMAIL (in-whitelist statuses) ━━━');
  for (const [status, names] of droppedNoEmail) {
    console.log(`  ${status} (${names.length}+ dropped):`);
    for (const n of names) console.log(`    - ${n}`);
  }
  if (droppedBadStatus.size) {
    console.log('');
    console.log('━━━ DROPPED FOR STATUS NOT IN WHITELIST ━━━');
    for (const [status, names] of droppedBadStatus) {
      console.log(`  ${status}: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' …' : ''}`);
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
