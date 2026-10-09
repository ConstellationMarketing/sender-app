-- ============================================================================
-- Remove hosting clients from reporting lists (Faith + all strategist lists)
-- 2026-10-10  — Maggie report: hosting clients showing up in Faith's list.
--
-- Reporting lists = the 4 strategist lists (Luiza, Alejandra, Faith, Maria)
-- plus the "All Clients" REPORT row (report_only = true). Hosting clients must
-- NOT be on any of these. They ARE allowed on the "All Clients" NEWSLETTER row
-- (newsletter_only = true) — leave that one alone.
--
-- Status in sender_clients_recipients is stored raw ("Hosting", "Hosting Only",
-- etc.). We normalize the same way the app does: lower-case, collapse spaces/
-- underscores/dashes to a single dash → 'hosting' | 'hosting-only'.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────
-- STEP 1 — DIAGNOSTIC (read-only). Run this first.
-- Shows every hosting recipient currently sitting on a reporting list, grouped
-- by list. This answers both "how bad is Faith's list" and "did it happen to
-- anyone else" (Maggie items #1 and #3).
-- ─────────────────────────────────────────────────────────────────────────
SELECT l.name                                  AS list_name,
       r.status                                AS recipient_status,
       r.name                                  AS client_name
FROM   public.sender_clients_list_members m
JOIN   public.sender_clients_lists      l ON l.id = m.list_id
JOIN   public.sender_clients_recipients r ON r.id = m.recipient_id
WHERE  (
         l.name IN ('Luiza','Alejandra','Faith','Maria')          -- strategist reporting lists
         OR (l.name = 'All Clients' AND l.report_only IS TRUE)     -- All Clients (report) row
       )
  AND  lower(regexp_replace(r.status, '[_\s-]+', '-', 'g')) IN ('hosting','hosting-only')
ORDER  BY l.name, r.name;


-- ─────────────────────────────────────────────────────────────────────────
-- STEP 1b — WIDER CHECK (read-only, optional). Anything on a reporting list
-- that is NOT live/onboarding (catches paused/cancelled/active-only too, not
-- just hosting). Use this to confirm nothing else slipped in.
-- ─────────────────────────────────────────────────────────────────────────
SELECT l.name AS list_name, r.status AS recipient_status, r.name AS client_name
FROM   public.sender_clients_list_members m
JOIN   public.sender_clients_lists      l ON l.id = m.list_id
JOIN   public.sender_clients_recipients r ON r.id = m.recipient_id
WHERE  (
         l.name IN ('Luiza','Alejandra','Faith','Maria')
         OR (l.name = 'All Clients' AND l.report_only IS TRUE)
       )
  AND  lower(regexp_replace(r.status, '[_\s-]+', '-', 'g')) NOT IN ('live','onboarding')
ORDER  BY l.name, r.name;


-- ─────────────────────────────────────────────────────────────────────────
-- STEP 2 — FIX (writes). Removes hosting recipients from every reporting list
-- (all 4 strategist lists + All Clients report). Leaves the newsletter list
-- untouched. Re-run STEP 1 afterward — it should return 0 rows.
-- ─────────────────────────────────────────────────────────────────────────
DELETE FROM public.sender_clients_list_members m
USING  public.sender_clients_lists      l,
       public.sender_clients_recipients r
WHERE  m.list_id      = l.id
  AND  m.recipient_id = r.id
  AND  (
         l.name IN ('Luiza','Alejandra','Faith','Maria')
         OR (l.name = 'All Clients' AND l.report_only IS TRUE)
       )
  AND  lower(regexp_replace(r.status, '[_\s-]+', '-', 'g')) IN ('hosting','hosting-only');
