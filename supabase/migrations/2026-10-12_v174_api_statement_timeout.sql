-- v174 — API statement timeout for signed-in users: 8s → 60s (data imports send ~1.5 MB batches that
-- exceed 8s on a small compute instance). anon stays at 3s. PostgREST re-reads role settings on reload.
alter role authenticated set statement_timeout = '60s';
notify pgrst, 'reload config';
