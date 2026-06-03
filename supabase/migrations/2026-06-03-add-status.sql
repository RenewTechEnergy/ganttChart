-- Add a first-class `status` column so the 4-state enum
-- (Not Started / In Progress / Delayed / Done) survives the cloud round-trip.
--
-- Previously status was only inferred from pct_done on load (Done=100, else 0),
-- which collapsed "In Progress" and "Delayed" to "Not Started" after any reload
-- or for other users. The client (index.html) now reads/writes this column
-- directly (nodeToDbRow / loadBoard / dbRowToNode / rowToServerSnapshot) while
-- still writing pct_done for back-compat.
--
-- Nullable on purpose: existing rows stay NULL until next upload; the client
-- backfills a sensible value from pct_done (migrateLegacyFields) on load.
--
-- IMPORTANT: apply this BEFORE shipping the matching index.html, otherwise the
-- client's inserts/updates (which now include a `status` key) will be rejected
-- by PostgREST with "Could not find the 'status' column" (PGRST204).

ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS status text;
