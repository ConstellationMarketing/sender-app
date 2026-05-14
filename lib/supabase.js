'use strict';

// Shared Supabase service-role client. Pinned to the Master DB project where
// the sender_* tables live.

const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getSupabase() {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('SUPABASE_URL not set');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY not set');
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

module.exports = { getSupabase };
