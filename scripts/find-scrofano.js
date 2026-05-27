#!/usr/bin/env node
'use strict';

// Diagnostic for the Scrofano Law PC "Client Information" 404. Three passes:
//   1. Hit /view/{id} directly with the embed's view_id from the URL —
//      ClickUp returns the embed's target settings, which tells us which
//      task the view is pointing at.
//   2. Walk every space → every folder → every list in the team and find
//      the "Scrofano Law PC" folder + its lists.
//   3. List tasks in each Scrofano sublist (live + archived) so we can see
//      whether a "client information" task exists there or was deleted.
//
// Run on the VPS:
//   export CLICKUP_API_KEY=$(grep -E '^CLICKUP_API_KEY=' /opt/sender-app/.env | cut -d= -f2-)
//   node scripts/find-scrofano.js

const CLICKUP_BASE = 'https://api.clickup.com/api/v2';
const TEAM_ID      = '2368165';                       // from the broken URL
const VIEW_ID      = '288n5-244897';                  // the embed's view_id

function getKey() {
  const k = process.env.CLICKUP_API_KEY;
  if (!k) { console.error('CLICKUP_API_KEY not set'); process.exit(2); }
  return k;
}

async function cu(path) {
  const r = await fetch(`${CLICKUP_BASE}${path}`, {
    headers: { Authorization: getKey(), Accept: 'application/json' },
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const err = new Error(`ClickUp ${r.status} ${path}: ${(json && (json.err || json.error)) || text}`);
    err.status = r.status;
    err.body   = json;
    throw err;
  }
  return json;
}

(async () => {
  // ───────────────────────────────────────────────────────────────────────
  // 1. View → embedded task target
  // ───────────────────────────────────────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`STEP 1: probe the embed view ${VIEW_ID}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const v = await cu(`/view/${VIEW_ID}`);
    console.log(JSON.stringify(v, null, 2).slice(0, 4000));
  } catch (e) {
    console.log(`view fetch failed: ${e.message}`);
  }

  // ───────────────────────────────────────────────────────────────────────
  // 2. Find the Scrofano Law PC folder
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`STEP 2: find Scrofano Law PC folder in team ${TEAM_ID}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let scrofanoFolder = null;
  const { spaces = [] } = await cu(`/team/${TEAM_ID}/space?archived=false`);
  for (const space of spaces) {
    const { folders = [] } = await cu(`/space/${space.id}/folder?archived=false`);
    for (const f of folders) {
      if (String(f.name || '').toLowerCase().includes('scrofano')) {
        scrofanoFolder = { ...f, _space: space.name };
        console.log(`Found: ${space.name} → ${f.name}  (folder id: ${f.id})`);
      }
    }
  }
  if (!scrofanoFolder) {
    console.log('No folder name matched "scrofano" in any space.');
    return;
  }

  // ───────────────────────────────────────────────────────────────────────
  // 3. Walk every list under the Scrofano folder, print tasks (live+arch)
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`STEP 3: tasks in every Scrofano sublist`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const lists = scrofanoFolder.lists || [];
  for (const list of lists) {
    console.log(`\n── LIST: ${list.name} (id ${list.id})`);
    for (const archived of ['false', 'true']) {
      const params = new URLSearchParams({
        page: '0',
        archived,
        subtasks: 'true',
        include_closed: 'true',
      });
      try {
        const data = await cu(`/list/${list.id}/task?${params}`);
        const tasks = data?.tasks || [];
        const label = archived === 'true' ? '  [archived]' : '  [live]    ';
        if (!tasks.length) {
          console.log(`${label} (no tasks)`);
          continue;
        }
        for (const t of tasks) {
          const ci = String(t.name || '').toLowerCase().includes('client info') ||
                     String(t.name || '').toLowerCase().includes('information');
          console.log(`${label} ${ci ? '★' : ' '} ${t.name}   [id ${t.id}, status ${t?.status?.status || '?'}]`);
        }
      } catch (e) {
        console.log(`  fetch failed: ${e.message}`);
      }
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
