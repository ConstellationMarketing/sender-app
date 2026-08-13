-- Sender: two auto-managed "All Clients" audience lists
--
-- Both lists show up in the UI as just "All Clients", but the two
-- modals filter by scope flags so each shows exactly one row:
--
--   Monthly Reports  → report_only=true row, populated Live + Onboarding
--   Newsletter       → newsletter_only=true row, populated Live + Onboarding + Hosting
--
-- The Newsletter dropdown will show the newsletter row; the Reports
-- dropdown will show the report row. Neither shows both.
--
-- Cleans up the prior "All Clients (Live + Onboarding + Hosting)" list
-- so we're not carrying legacy names in the dropdown.
--
-- Idempotent: safe to re-run.

-- 1) Ensure both scope columns exist.
ALTER TABLE public.sender_clients_lists
  ADD COLUMN IF NOT EXISTS newsletter_only boolean NOT NULL DEFAULT false;
ALTER TABLE public.sender_clients_lists
  ADD COLUMN IF NOT EXISTS report_only     boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.sender_clients_lists.newsletter_only IS
  'When true, the list is only shown in the Newsletter audience dropdown, not in Monthly Reports.';
COMMENT ON COLUMN public.sender_clients_lists.report_only IS
  'When true, the list is only shown in the Monthly Reports audience dropdown, not in Newsletters.';

-- 2) Retire the previously-seeded "All Clients (Live + Onboarding + Hosting)"
--    list — the auto-sync will now maintain a "newsletter_only=true" row
--    named just "All Clients" instead. Deleting is safe: the previous row
--    was only ever populated by the auto-sync, never referenced elsewhere.
DELETE FROM public.sender_clients_list_members
 WHERE list_id IN (
   SELECT id FROM public.sender_clients_lists
    WHERE name = 'All Clients (Live + Onboarding + Hosting)'
 );
DELETE FROM public.sender_clients_lists
 WHERE name = 'All Clients (Live + Onboarding + Hosting)';

-- 3) Seed the two auto-managed rows if they don't exist yet. The next
--    sync tick fills memberships.
INSERT INTO public.sender_clients_lists (name, is_fixed, report_only, newsletter_only)
SELECT 'All Clients', true, true, false
WHERE NOT EXISTS (
  SELECT 1 FROM public.sender_clients_lists
  WHERE name = 'All Clients' AND report_only = true
);

INSERT INTO public.sender_clients_lists (name, is_fixed, report_only, newsletter_only)
SELECT 'All Clients', true, false, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.sender_clients_lists
  WHERE name = 'All Clients' AND newsletter_only = true
);

-- 4) If there's a legacy manual "All Clients" list (both flags false) sitting
--    around from before this feature, mark it archived so it doesn't clash.
--    We rename rather than delete so any historical batch that referenced it
--    stays resolvable.
UPDATE public.sender_clients_lists
   SET name = 'All Clients (archived — replaced by auto-sync)'
 WHERE name = 'All Clients'
   AND report_only = false
   AND newsletter_only = false
   AND is_fixed IS NOT true;
