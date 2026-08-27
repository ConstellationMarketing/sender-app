-- Sender: dedupe recipients by ClickUp task ID
--
-- Problem: the ClickUp sync upserted sender_clients_recipients by EMAIL.
-- Any ClickUp task without an email got a synthetic placeholder like
-- "(no-email-clickup-<task-id>)" and became its own row. If that task
-- later got a real email (or was renamed / merged / deleted), the
-- placeholder row lingered forever — nothing ever reconciled it against
-- ClickUp's current state. Result: duplicate firms in All Clients
-- (e.g. two "Michael G. Murray, P.A." rows, one with the real email
-- and one with the placeholder).
--
-- Fix: use the ClickUp task ID as the sync key. Task IDs are stable
-- across renames and email edits, so upserting by them:
--   - never creates a second row for a task that already exists
--   - correctly renames rows when the ClickUp task's name/email changes
--
-- We also track orphaned_at so any row whose ClickUp task disappears
-- gets a visible flag on the next sync — the send filter already blocks
-- placeholder-email rows from actual sends via hasRealEmail(), but the
-- orphan flag lets the UI (and any future cleanup job) find and remove
-- them without hunting through Supabase manually.
--
-- Idempotent: safe to re-run.

-- 1) Add the ClickUp task ID column. Nullable during the transition —
--    the first sync after this migration ships heals every existing row
--    by looking up the ClickUp task by name/email and setting the ID.
ALTER TABLE public.sender_clients_recipients
  ADD COLUMN IF NOT EXISTS clickup_task_id text;

COMMENT ON COLUMN public.sender_clients_recipients.clickup_task_id IS
  'Stable ClickUp task ID from ClickUp CRM (Client Information list). Populated by the sync; used as the primary upsert key so email/name changes never create a second row.';

-- 2) Partial unique index — allow multiple NULLs (legacy rows in the
--    transition window) but forbid two rows with the same non-null ID.
--    This is what makes upsert-on-conflict work as the sync key and
--    prevents any new duplicate from ever landing.
CREATE UNIQUE INDEX IF NOT EXISTS sender_clients_recipients_clickup_task_id_unique
  ON public.sender_clients_recipients (clickup_task_id)
  WHERE clickup_task_id IS NOT NULL;

-- 3) Orphan flag. Set by the sync at the end of each run for any row
--    whose clickup_task_id is not in the current ClickUp active set.
--    NULL means the row is still linked to a real ClickUp task.
ALTER TABLE public.sender_clients_recipients
  ADD COLUMN IF NOT EXISTS orphaned_at timestamptz;

COMMENT ON COLUMN public.sender_clients_recipients.orphaned_at IS
  'When the ClickUp sync last observed this row had no matching ClickUp task. NULL means the row is still linked. Rows with orphaned_at set are candidates for manual cleanup — the send filter already excludes placeholder-email rows from delivery.';
