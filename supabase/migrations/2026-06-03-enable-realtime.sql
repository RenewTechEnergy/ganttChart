-- Enable Postgres realtime replication for the board tables so edits made by
-- one signed-in user propagate to others' open boards (applyRemoteTaskChange /
-- applyRemotePredChange / applyRemoteShareChange in index.html). Without this,
-- each browser only learns a row's `version` from its own writes, so every
-- cross-user edit silently loses the optimistic-concurrency race.
--
-- REPLICA IDENTITY FULL makes UPDATE/DELETE realtime payloads carry the full
-- old row (not just the PK), which the client relies on for echo suppression
-- and delete handling.
--
-- Idempotent: safe to re-run (skips tables already in the publication).

DO $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  FOREACH t IN ARRAY ARRAY['tasks', 'task_predecessors', 'project_shares'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
    EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', t);
  END LOOP;
END $$;
