-- 2026-08-22 — Contact first name + sender calendar URL
--
-- Two additive columns, no data movement:
--
--   sender_clients_recipients.first_name  text — the contact person's real
--     first name (e.g. "Andrew" for "Andrew Taylor Trial Attorneys"),
--     pulled from a ClickUp custom field on the Client Information task
--     during /api/clients-sync. Was previously derived from firstWord(name),
--     which grabbed the firm name — Camila reported that emails for KC
--     Immigration greeted the client as "KC", Thomas Loftin as "Thomas",
--     etc. Left NULLABLE so buildMergeRow can still fall back to
--     firstWord(name) when the ClickUp field is empty.
--
--   users_profiles.calendar_url           text — the sender's calendar
--     (Calendly, Cal.com, etc.) URL. Exposed to templates as the
--     {{calendar_url}} merge var so writers can drop a "Book a call"
--     link into any newsletter/report without editing per-batch data.
--
-- Both columns are nullable — existing rows are untouched.

BEGIN;

ALTER TABLE public.sender_clients_recipients
  ADD COLUMN IF NOT EXISTS first_name text;

COMMENT ON COLUMN public.sender_clients_recipients.first_name IS
  'Contact person''s real first name, pulled from ClickUp Client Information custom field (see lib/crm.js FIRST_NAME_FIELD_NEEDLES). Nullable — falls back to firstWord(name) in buildMergeRow when empty.';

ALTER TABLE public.users_profiles
  ADD COLUMN IF NOT EXISTS calendar_url text;

COMMENT ON COLUMN public.users_profiles.calendar_url IS
  'Sender''s scheduling link (Calendly, Cal.com, etc.). Rendered as the {{calendar_url}} merge var by lib/mailgun.js buildMergeRow when the batch owner matches this user. Nullable — empty in template if unset.';

COMMIT;
