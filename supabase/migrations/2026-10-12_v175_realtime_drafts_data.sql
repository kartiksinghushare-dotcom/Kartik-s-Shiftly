-- v175 — realtime for shared checklist drafts and the Data module (additive: adds tables to the existing publication)
alter publication supabase_realtime add table public.submission_drafts;
alter publication supabase_realtime add table public.data_files;
alter publication supabase_realtime add table public.data_folders;
