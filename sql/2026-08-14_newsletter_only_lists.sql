-- Sender: sender_clients_lists.newsletter_only
--
-- Adds a per-list flag that hides the list from the Monthly Reports
-- audience dropdown while keeping it visible in the Newsletter modal.
--
-- The immediate use case is the auto-synced "All Clients (Live +
-- Onboarding + Hosting)" list that the newsletter goes to. Hosting
-- clients get the newsletter but NOT the monthly performance report.
--
-- Also seeds the row (if the auto-sync hasn't created it yet) so the
-- dropdown has something to show as soon as the migration lands.
--
-- Idempotent: safe to re-run.

ALTER TABLE public.sender_clients_lists
  ADD COLUMN IF NOT EXISTS newsletter_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.sender_clients_lists.newsletter_only IS
  'When true, this list is only shown in the Newsletter audience-list dropdown, not in Monthly Reports. Used for the auto-synced All Clients list which includes Hosting clients.';

INSERT INTO public.sender_clients_lists (name, is_fixed, newsletter_only)
SELECT 'All Clients (Live + Onboarding + Hosting)', true, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.sender_clients_lists
  WHERE name = 'All Clients (Live + Onboarding + Hosting)'
);
