'use strict';

// DEPRECATED. The Sender bot used to fetch active clients from ClickUp's
// REST API directly, but the OS CRM (the master Supabase `client` table)
// is the source of truth that ClickUp itself syncs into. We now read from
// Supabase instead — see ./crm.js. No new env vars needed.
//
// This file is kept only so a stale `require('./clickup')` somewhere fails
// with a clear error instead of silently returning bogus data. Safe to
// delete in a follow-up commit once the team confirms nothing imports it.

throw new Error(
  "lib/clickup.js is deprecated. Use require('./crm') and fetchActiveClients() instead."
);
