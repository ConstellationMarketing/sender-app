-- Sender: Mailgun delivery/open/click tracking events
--
-- Phase 2 of the Oct 2026 monthly-reporting observability work. Phase 1 made
-- every real report send carry Mailgun open/click tracking plus custom
-- variables (clickup_task_id, send_email_id, batch_id, report_month, …). This
-- table is where the results land: Mailgun POSTs a webhook for every event
-- (delivered / opened / clicked / failed / complained / unsubscribed), and the
-- /api/mailgun-events endpoint writes one row here per event.
--
-- Downstream:
--   - Phase 3 (summary view) reads this to show Received / Opened / Clicked
--     per client per cycle.
--   - Phase 4 (reconciliation) uses the 'delivered' rows as the "actually
--     sent" set to diff against the master client list.
--
-- Keyed for attribution by the custom variables echoed back on each event, so
-- we never have to re-parse the recipient address. clickup_task_id is the
-- stable client key (maps to client.clickup_ticket_id, immune to name drift).
--
-- Idempotent: safe to re-run. Dedupe on mailgun_event_id (Mailgun may deliver
-- the same event more than once).

CREATE TABLE IF NOT EXISTS public.sender_tracking_events (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Mailgun's own event id — unique per event, used to dedupe retried webhooks.
  mailgun_event_id  text,
  -- The message this event belongs to (Mailgun 'message-id' header).
  mailgun_message_id text,

  -- delivered | opened | clicked | failed | permanent_fail | temporary_fail |
  -- complained | unsubscribed | accepted  (whatever Mailgun sends in 'event').
  event             text NOT NULL,

  recipient_email   text,

  -- Custom variables stamped at send time (lib/mailgun.js sendOne vars).
  send_email_id     bigint,      -- sender_sends_emails.id
  batch_id          bigint,      -- sender_sends_batches.id
  recipient_id      bigint,      -- sender_clients_recipients.id
  clickup_task_id   text,        -- stable client key (client.clickup_ticket_id)
  client_name       text,
  report_month      text,        -- e.g. "September 2026"

  -- For 'clicked' events: the URL that was clicked.
  url               text,

  -- Mailgun's event timestamp (seconds since epoch, as a timestamptz).
  event_ts          timestamptz,
  -- When our webhook recorded it.
  received_at       timestamptz NOT NULL DEFAULT now(),

  -- Full event-data payload, for debugging / fields we don't model yet.
  raw               jsonb
);

COMMENT ON TABLE public.sender_tracking_events IS
  'One row per Mailgun webhook event (delivered/opened/clicked/failed/…) for Sender report emails. Written by /api/mailgun-events. Attribution via the custom vars stamped at send time; clickup_task_id is the stable client key.';

-- Dedupe: ignore a repeat delivery of the same Mailgun event. Must be a FULL
-- unique index (not partial) — Postgres ON CONFLICT (used by the webhook's
-- upsert) cannot target a partial index. A full unique index still permits
-- multiple NULL mailgun_event_id rows (NULLs are distinct in Postgres).
CREATE UNIQUE INDEX IF NOT EXISTS sender_tracking_events_mailgun_event_id_uniq
  ON public.sender_tracking_events (mailgun_event_id);

-- Query paths: per-client, per-batch, per-cycle, per-event-type.
CREATE INDEX IF NOT EXISTS sender_tracking_events_clickup_task_id_idx
  ON public.sender_tracking_events (clickup_task_id);
CREATE INDEX IF NOT EXISTS sender_tracking_events_batch_id_idx
  ON public.sender_tracking_events (batch_id);
CREATE INDEX IF NOT EXISTS sender_tracking_events_report_month_idx
  ON public.sender_tracking_events (report_month);
CREATE INDEX IF NOT EXISTS sender_tracking_events_event_idx
  ON public.sender_tracking_events (event);
CREATE INDEX IF NOT EXISTS sender_tracking_events_send_email_id_idx
  ON public.sender_tracking_events (send_email_id);
