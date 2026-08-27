-- Sender: per-client skip_autosend opt-out
--
-- Prior state: the ONLY way to keep a client off scheduled sends without
-- deleting them was to change their ClickUp status away from Live/
-- Onboarding/Hosting. That ripples across every other system that reads
-- ClickUp status (SPR-Dashboard, Meerkat, etc.) — a Sender-only exemption
-- had no clean expression.
--
-- This column is Sender-local. When TRUE:
--   - Every batch send filters the recipient out (see routes/api.js).
--   - The row stays on all lists so team can still see who's opted out.
--   - Test-sends still work on the row so the strategist can preview
--     the manual report they'll send outside the auto path.
--
-- Reversible: flip back to FALSE anytime and the recipient rejoins the
-- next auto-send.
--
-- Idempotent: safe to re-run.

ALTER TABLE public.sender_clients_recipients
  ADD COLUMN IF NOT EXISTS skip_autosend boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.sender_clients_recipients.skip_autosend IS
  'When TRUE, this recipient is excluded from every batch send. Sender-local opt-out (does not touch ClickUp status). Test-sends still work. Toggle from the client row 🚫 button or the list-picker modal.';

-- Index the flag so the send-filter query stays fast on large audiences.
CREATE INDEX IF NOT EXISTS sender_clients_recipients_skip_autosend_idx
  ON public.sender_clients_recipients (skip_autosend)
  WHERE skip_autosend = true;
