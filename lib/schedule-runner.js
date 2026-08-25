'use strict';

// Scheduled-batch runner. Ticks every ~60s. Any batch with
// status='scheduled' and scheduled_at <= now() gets sent by hitting the
// same /api/batches/:id/send route the "Send immediately" button uses —
// so we don't have to duplicate the ~180-line send logic. The route
// updates the batch's status to 'sent' (or 'failed') on its own, which
// means we'll never re-pick the same row on the next tick.
//
// This runs in-process with the Express server (server.js starts it after
// listen). If the Node process dies mid-tick, the affected batches stay
// at status='scheduled' and get retried on the next tick after restart —
// PM2 auto-restarts on crash, so we're covered.
//
// Concurrency: we mark each row 'sending' the moment we pick it up, so a
// second tick (or a second replica, unlikely) can't double-send.

const { getSupabase } = require('./supabase');

const TICK_MS      = Number(process.env.SENDER_SCHEDULE_TICK_MS) || 60 * 1000;
const INTERNAL_URL = process.env.SENDER_INTERNAL_URL
                  || `http://127.0.0.1:${process.env.PORT || 3010}`;

// Small guard so the first tick doesn't race with app.listen() finishing.
const STARTUP_DELAY_MS = 20 * 1000;

async function claimAndFireDueBatches() {
  const sb = getSupabase();

  // Grab everything whose scheduled_at has passed. limit(10) is a safety cap
  // in case the runner was down for a while and a backlog accumulated —
  // we'd rather send them in staggered ticks than blast them all at once.
  const { data: due, error } = await sb
    .from('sender_sends_batches')
    .select('id, name, scheduled_at')
    .eq('status', 'scheduled')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(10);
  if (error) throw new Error(`schedule-runner query failed: ${error.message}`);
  if (!due?.length) return { fired: 0, results: [] };

  const results = [];
  for (const batch of due) {
    // Claim the row before firing so a concurrent tick can't pick the same
    // one. If the update returns 0 rows, another tick got there first.
    // Match on status='scheduled' so we don't clobber a manual 'sending'.
    const { data: claimed, error: claimErr } = await sb
      .from('sender_sends_batches')
      .update({ status: 'sending' })
      .eq('id', batch.id)
      .eq('status', 'scheduled')
      .select('id');
    if (claimErr) {
      results.push({ id: batch.id, ok: false, reason: `claim failed: ${claimErr.message}` });
      continue;
    }
    if (!claimed?.length) {
      // Someone else took it — silent skip.
      results.push({ id: batch.id, ok: false, reason: 'already claimed' });
      continue;
    }

    // Fire the actual send by reusing the exact same route the UI button
    // hits. The route resets status='sending' internally (idempotent) and
    // then flips to 'sent' or 'failed' at the end, so we don't need to
    // touch the row again on success.
    try {
      const r = await fetch(`${INTERNAL_URL}/api/batches/${batch.id}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const payload = await r.json().catch(() => null);
      if (!r.ok) {
        // Route already recorded 'failed' if it got that far; if the fetch
        // itself failed (500, network), we leave 'sending' to be picked up
        // manually via "Send immediately". Log loudly either way.
        console.error('[sender] schedule-runner send failed:', batch.id, batch.name, payload?.error || r.status);
        results.push({ id: batch.id, ok: false, reason: payload?.error || `HTTP ${r.status}` });
      } else {
        console.log(`[sender] schedule-runner fired batch "${batch.name}" (${batch.id}): ${payload?.delivered}/${payload?.attempted}`);
        results.push({ id: batch.id, ok: true, delivered: payload?.delivered, attempted: payload?.attempted });
      }
    } catch (e) {
      console.error('[sender] schedule-runner fetch threw:', batch.id, e.message);
      results.push({ id: batch.id, ok: false, reason: e.message });
    }
  }

  return { fired: results.length, results };
}

function startScheduleRunner() {
  const tick = () => {
    claimAndFireDueBatches()
      .then(r => { if (r.fired) console.log(`[sender] schedule-runner tick fired ${r.fired}`); })
      .catch(err => console.error('[sender] schedule-runner tick failed:', err.message));
  };
  setTimeout(tick, STARTUP_DELAY_MS);
  setInterval(tick, TICK_MS);
  console.log(`[sender] schedule-runner scheduled every ${TICK_MS / 1000}s`);
}

module.exports = { startScheduleRunner, claimAndFireDueBatches };
