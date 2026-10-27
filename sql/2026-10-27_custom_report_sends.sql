-- Sender: custom-report "sent" tracking (per client, per monthly cycle)
--
-- Companion to sql/2026-10-09_custom_report_clients.sql. That migration added
-- the roster of clients who receive a hand-built custom monthly report
-- (sender_custom_report_clients). This one records, for each cycle month,
-- whether that client's custom report has been SENT — replacing the manual
-- "Sent" checkmark column CS kept in the Google doc.
--
-- Custom reports are sent BY HAND (from the CS person's own email), so there
-- is nothing to detect automatically: "sent" is a manual flag the strategist
-- toggles in the Sender "Custom Reports" tab. We keep sent_at + sent_by so
-- there's an audit trail the Google doc never gave us.
--
-- One row per (client, cycle_month). cycle_month is stored as the first day of
-- the month (e.g. 2026-10-01). Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS public.sender_custom_report_sends (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id   bigint NOT NULL
                REFERENCES public.sender_custom_report_clients (id) ON DELETE CASCADE,
  cycle_month date   NOT NULL,
  sent        boolean NOT NULL DEFAULT true,
  sent_at     timestamptz,
  sent_by     text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, cycle_month)
);

COMMENT ON TABLE public.sender_custom_report_sends IS
  'Per-cycle "sent" status for hand-built custom monthly reports. One row per (client, cycle_month). Toggled manually in the Sender "Custom Reports" tab; replaces the Google doc "Sent" checkmark.';

CREATE INDEX IF NOT EXISTS sender_custom_report_sends_month_idx
  ON public.sender_custom_report_sends (cycle_month);
