#!/usr/bin/env node
'use strict';

// One-off diagnostic. Lists tasks in the ClickUp "Client Information" list
// and prints anything whose name OR custom fields contain "scrofano". Also
// includes archived (trashed) tasks so we can tell whether the Scrofano
// Client Information task was deleted or moved.
//
// Run on the VPS (CLICKUP_API_KEY already in env):
//   node scripts/find-scrofano.js
// Or anywhere with the key:
//   CLICKUP_API_KEY=pk_... node scripts/find-scrofano.js
//
// Bumps the page size to include archived rows because the OS CRM sync only
// pulls non-archived ones — that's why the deleted task didn't show up in
// the Sender's client list either.

const CLICKUP_BASE = 'https://api.clickup.com/api/v2';
const LIST_ID      = process.env.CRM_CLICKUP_LIST_ID || '901703957188';
const NEEDLE       = (process.argv[2] || 'scrofano').toLowerCase();

function getKey() {
  const k = process.env.CLICKUP_API_KEY;
  if (!k) {
    console.error('CLICKUP_API_KEY not set. On the VPS, do:');
    console.error('  set -a; source /opt/sender-app/.env; set +a; node scripts/find-scrofano.js');
    process.exit(2);
  }
  return k;
}

async function cuFetch(path) {
  const r = await fetch(`${CLICKUP_BASE}${path}`, {
    headers: { Authorization: getKey(), Accept: 'application/json' },
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`ClickUp ${r.status} ${path}: ${(json && (json.err || json.error)) || text}`);
  return json;
}

function matches(t) {
  const name = String(t?.name || '').toLowerCase();
  if (name.includes(NEEDLE)) return true;
  for (const f of (t.custom_fields || [])) {
    const v = f.value;
    if (typeof v === 'string' && v.toLowerCase().includes(NEEDLE)) return true;
    if (v && typeof v === 'object') {
      const flat = JSON.stringify(v).toLowerCase();
      if (flat.includes(NEEDLE)) return true;
    }
  }
  return false;
}

(async () => {
  console.log(`Searching ClickUp list ${LIST_ID} for tasks matching "${NEEDLE}"...\n`);
  const hits = [];

  // Two passes: archived=false (live), then archived=true (trashed).
  for (const archived of ['false', 'true']) {
    let label = archived === 'true' ? 'ARCHIVED/TRASH' : 'LIVE';
    for (let page = 0; page < 30; page++) {
      const params = new URLSearchParams({
        page: String(page),
        archived,
        subtasks: 'true',
        include_closed: 'true',
      });
      const data = await cuFetch(`/list/${encodeURIComponent(LIST_ID)}/task?${params}`);
      const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
      if (!tasks.length) break;
      for (const t of tasks) {
        if (matches(t)) hits.push({ archived: label, t });
      }
      if (tasks.length < 100) break;
    }
  }

  if (!hits.length) {
    console.log(`No tasks matched "${NEEDLE}" in either live or archived sets.`);
    console.log('That means the task is either:');
    console.log('  (a) permanently deleted (past Trash retention), or');
    console.log('  (b) under a different parent list, or');
    console.log('  (c) renamed so the needle no longer matches.');
    return;
  }

  for (const { archived, t } of hits) {
    console.log(`[${archived}] ${t.name}`);
    console.log(`  id:      ${t.id}`);
    console.log(`  status:  ${t?.status?.status || '?'}`);
    console.log(`  url:     ${t.url}`);
    console.log(`  list:    ${t?.list?.name || ''} (${t?.list?.id || ''})`);
    console.log(`  parent:  ${t.parent || '(none)'}`);
    console.log(`  updated: ${t.date_updated ? new Date(Number(t.date_updated)).toISOString() : '?'}`);
    console.log('');
  }
})().catch(e => { console.error(e.message); process.exit(1); });
