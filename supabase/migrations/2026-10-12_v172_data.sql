-- ============================================================================
-- Bridge v172 — DATA module
-- Folder = one Postgres table (schema `data`). Excel/CSV files uploaded into a
-- folder are parsed in the browser and appended to that folder's table; every
-- row remembers its source file so deleting a file removes exactly its rows.
-- PDFs/images/etc. live in Storage only (bucket `data-files`).
-- ============================================================================

create schema if not exists data;
grant usage on schema data to authenticated, service_role;

-- ── Registry ────────────────────────────────────────────────────────────────
create table if not exists public.data_folders (
  id          text primary key,
  name        text not null,
  parent_id   text references public.data_folders(id) on delete cascade,
  table_name  text not null unique,
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists data_folders_parent_idx on public.data_folders(parent_id);

create table if not exists public.data_files (
  id            text primary key,
  folder_id     text not null references public.data_folders(id) on delete cascade,
  name          text not null,
  storage_path  text,
  file_type     text,
  file_size     bigint,
  kind          text not null default 'file' check (kind in ('table','file')),
  status        text not null default 'ready',          -- uploading | importing | ready | error
  rows          bigint not null default 0,
  error         text,
  sheets        jsonb not null default '[]'::jsonb,
  uploaded_by   text,
  uploader_name text,
  uploaded_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists data_files_folder_idx on public.data_files(folder_id);

create table if not exists public.data_columns (
  folder_id  text not null references public.data_folders(id) on delete cascade,
  col_name   text not null,
  label      text not null,
  col_type   text not null check (col_type in ('text','numeric','date','timestamptz','boolean')),
  ordinal    integer not null default 0,
  primary key (folder_id, col_name)
);

alter table public.data_folders enable row level security;
alter table public.data_files   enable row level security;
alter table public.data_columns enable row level security;
drop policy if exists auth_data_folders on public.data_folders;
drop policy if exists auth_data_files   on public.data_files;
drop policy if exists auth_data_columns on public.data_columns;
create policy auth_data_folders on public.data_folders for all to authenticated using (true) with check (true);
create policy auth_data_files   on public.data_files   for all to authenticated using (true) with check (true);
create policy auth_data_columns on public.data_columns for all to authenticated using (true) with check (true);

-- ── Storage bucket (private; no per-bucket cap — the project-wide upload limit applies) ──
insert into storage.buckets (id, name, public, file_size_limit)
values ('data-files','data-files',false,null)
on conflict (id) do update set file_size_limit = null, public = false;
drop policy if exists auth_storage_data_files on storage.objects;
create policy auth_storage_data_files on storage.objects for all to authenticated
  using (bucket_id = 'data-files') with check (bucket_id = 'data-files');

-- ── Helpers ─────────────────────────────────────────────────────────────────
create or replace function data._slug(t text) returns text language sql immutable as $$
  select coalesce(nullif(trim(both '_' from regexp_replace(lower(coalesce(t,'')), '[^a-z0-9]+', '_', 'g')), ''), 'x')
$$;

create or replace function data._num(t text) returns numeric language plpgsql immutable as $$
begin
  if t is null or btrim(t) = '' then return null; end if;
  return regexp_replace(t, '[,\s]', '', 'g')::numeric;
exception when others then return null;
end $$;

create or replace function data._ts(t text) returns timestamptz language plpgsql immutable as $$
begin
  if t is null or btrim(t) = '' then return null; end if;
  return t::timestamptz;
exception when others then return null;
end $$;

create or replace function data._date(t text) returns date language plpgsql immutable as $$
begin
  if t is null or btrim(t) = '' then return null; end if;
  return left(t,10)::date;
exception when others then return null;
end $$;

create or replace function data._bool(t text) returns boolean language plpgsql immutable as $$
declare v text := lower(btrim(coalesce(t,'')));
begin
  if v in ('true','yes','y','1','t') then return true; end if;
  if v in ('false','no','n','0','f') then return false; end if;
  return null;
end $$;

create or replace function data._require_auth() returns void language plpgsql stable as $$
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
end $$;

-- ── Create folder (+ its table) ─────────────────────────────────────────────
create or replace function public.data_create_folder(p_id text, p_name text, p_parent_id text default null, p_created_by text default null)
returns text language plpgsql security definer set search_path = public, data as $$
declare base text; tn text; n int := 0; parent_tn text;
begin
  perform data._require_auth();
  if p_parent_id is not null then
    select table_name into parent_tn from public.data_folders where id = p_parent_id;
    if parent_tn is null then raise exception 'parent folder not found'; end if;
    base := left(parent_tn || '__' || data._slug(p_name), 55);
  else
    base := left(data._slug(p_name), 55);
  end if;
  tn := base;
  while exists (select 1 from public.data_folders where table_name = tn) loop
    n := n + 1; tn := base || '_' || n;
  end loop;
  insert into public.data_folders(id, name, parent_id, table_name, created_by) values (p_id, p_name, p_parent_id, tn, p_created_by);
  execute format('create table data.%I (_id bigserial primary key, _file_id text not null, _sheet text, _row_no integer, _imported_at timestamptz not null default now())', tn);
  execute format('create index %I on data.%I (_file_id)', tn || '_file_idx', tn);
  execute format('grant select on data.%I to authenticated', tn);
  return tn;
end $$;

-- ── Make sure the folder's table has these columns (adds new ones, widens to text when needed) ──
-- p_cols: [{"name":"order_id","label":"Order ID","type":"numeric"}, ...]
create or replace function public.data_ensure_columns(p_folder_id text, p_cols jsonb)
returns jsonb language plpgsql security definer set search_path = public, data as $$
declare tn text; c jsonb; cn text; cl text; ct text; cur text; maxord int; added int := 0; widened int := 0;
begin
  perform data._require_auth();
  select table_name into tn from public.data_folders where id = p_folder_id;
  if tn is null then raise exception 'folder not found'; end if;
  select coalesce(max(ordinal),0) into maxord from public.data_columns where folder_id = p_folder_id;
  for c in select * from jsonb_array_elements(coalesce(p_cols,'[]'::jsonb)) loop
    cn := c->>'name'; cl := coalesce(c->>'label', cn); ct := coalesce(c->>'type','text');
    if cn is null or cn = '' or cn like '\_%' then continue; end if;
    if ct not in ('text','numeric','date','timestamptz','boolean') then ct := 'text'; end if;
    select col_type into cur from public.data_columns where folder_id = p_folder_id and col_name = cn;
    if cur is null then
      maxord := maxord + 1;
      execute format('alter table data.%I add column if not exists %I %s', tn, cn, ct);
      insert into public.data_columns(folder_id, col_name, label, col_type, ordinal) values (p_folder_id, cn, cl, ct, maxord)
        on conflict (folder_id, col_name) do nothing;
      added := added + 1;
    elsif cur <> ct then
      -- widen: anything -> text; date -> timestamptz. Never narrow.
      if ct = 'text' then
        execute format('alter table data.%I alter column %I type text using %I::text', tn, cn, cn);
        update public.data_columns set col_type = 'text' where folder_id = p_folder_id and col_name = cn; widened := widened + 1;
      elsif cur = 'date' and ct = 'timestamptz' then
        execute format('alter table data.%I alter column %I type timestamptz using %I::timestamptz', tn, cn, cn);
        update public.data_columns set col_type = 'timestamptz' where folder_id = p_folder_id and col_name = cn; widened := widened + 1;
      elsif cur in ('numeric','boolean','timestamptz','date') and ct in ('numeric','boolean','timestamptz','date') then
        -- incompatible scalar types (e.g. numeric vs date): fall back to text
        execute format('alter table data.%I alter column %I type text using %I::text', tn, cn, cn);
        update public.data_columns set col_type = 'text' where folder_id = p_folder_id and col_name = cn; widened := widened + 1;
      end if;
    end if;
  end loop;
  return jsonb_build_object('added', added, 'widened', widened);
end $$;

-- ── Append a batch of rows to the folder's table ────────────────────────────
-- p_rows: [{"_row_no":2,"order_id":"1001","amount":"12.5",...}, ...]  (all values as strings or JSON scalars)
create or replace function public.data_ingest_rows(p_folder_id text, p_file_id text, p_sheet text, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public, data as $$
declare tn text; cols text := ''; vals text := ''; r record; n integer;
begin
  perform data._require_auth();
  select table_name into tn from public.data_folders where id = p_folder_id;
  if tn is null then raise exception 'folder not found'; end if;
  for r in select col_name, col_type from public.data_columns where folder_id = p_folder_id order by ordinal loop
    cols := cols || ', ' || format('%I', r.col_name);
    vals := vals || ', ' || case r.col_type
      when 'numeric'     then format('data._num(x->>%L)', r.col_name)
      when 'timestamptz' then format('data._ts(x->>%L)', r.col_name)
      when 'date'        then format('data._date(x->>%L)', r.col_name)
      when 'boolean'     then format('data._bool(x->>%L)', r.col_name)
      else                    format('nullif(x->>%L,'''')', r.col_name) end;
  end loop;
  execute format('insert into data.%I (_file_id, _sheet, _row_no%s) select %L, %L, (x->>''_row_no'')::int%s from jsonb_array_elements($1) x',
                 tn, cols, p_file_id, p_sheet, vals) using p_rows;
  get diagnostics n = row_count;
  update public.data_files set rows = rows + n, updated_at = now() where id = p_file_id;
  return n;
end $$;

-- ── Read rows back (viewer / CSV export) ────────────────────────────────────
create or replace function public.data_folder_rows(p_folder_id text, p_limit int default 100, p_offset int default 0,
                                                   p_order text default '_id', p_desc boolean default false, p_search text default null)
returns jsonb language plpgsql security definer set search_path = public, data as $$
declare tn text; ord text; res jsonb; where_sql text := '';
begin
  perform data._require_auth();
  select table_name into tn from public.data_folders where id = p_folder_id;
  if tn is null then raise exception 'folder not found'; end if;
  ord := coalesce(p_order, '_id');
  if ord not like '\_%' and not exists (select 1 from public.data_columns where folder_id = p_folder_id and col_name = ord) then ord := '_id'; end if;
  if ord like '\_%' and ord not in ('_id','_file_id','_sheet','_row_no','_imported_at') then ord := '_id'; end if;
  if p_search is not null and btrim(p_search) <> '' then where_sql := format(' where t::text ilike %L', '%' || p_search || '%'); end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from (select * from data.%I t%s order by %I %s nulls last limit %s offset %s) t',
                 tn, where_sql, ord, case when p_desc then 'desc' else 'asc' end, greatest(1, least(p_limit, 5000)), greatest(0, p_offset)) into res;
  return res;
end $$;

create or replace function public.data_folder_count(p_folder_id text, p_search text default null)
returns bigint language plpgsql security definer set search_path = public, data as $$
declare tn text; n bigint; where_sql text := '';
begin
  perform data._require_auth();
  select table_name into tn from public.data_folders where id = p_folder_id;
  if tn is null then return 0; end if;
  if p_search is not null and btrim(p_search) <> '' then where_sql := format(' where t::text ilike %L', '%' || p_search || '%'); end if;
  execute format('select count(*) from data.%I t%s', tn, where_sql) into n;
  return n;
end $$;

-- ── Deletes ─────────────────────────────────────────────────────────────────
create or replace function public.data_file_delete(p_file_id text)
returns text language plpgsql security definer set search_path = public, data as $$
declare tn text; sp text; fid text;
begin
  perform data._require_auth();
  select f.folder_id, f.storage_path into fid, sp from public.data_files f where f.id = p_file_id;
  if fid is null then return null; end if;
  select table_name into tn from public.data_folders where id = fid;
  if tn is not null then execute format('delete from data.%I where _file_id = %L', tn, p_file_id); end if;
  delete from public.data_files where id = p_file_id;
  return sp;
end $$;

-- clears a file's rows without removing the file record (re-import)
create or replace function public.data_file_clear_rows(p_file_id text)
returns void language plpgsql security definer set search_path = public, data as $$
declare tn text; fid text;
begin
  perform data._require_auth();
  select f.folder_id into fid from public.data_files f where f.id = p_file_id;
  select table_name into tn from public.data_folders where id = fid;
  if tn is not null then execute format('delete from data.%I where _file_id = %L', tn, p_file_id); end if;
  update public.data_files set rows = 0, updated_at = now() where id = p_file_id;
end $$;

-- drops the folder, every sub-folder, their tables; returns the storage paths the client must remove
create or replace function public.data_folder_delete(p_folder_id text)
returns text[] language plpgsql security definer set search_path = public, data as $$
declare ids text[]; tns text[]; paths text[]; t text;
begin
  perform data._require_auth();
  with recursive sub as (
    select id, table_name from public.data_folders where id = p_folder_id
    union all
    select f.id, f.table_name from public.data_folders f join sub on f.parent_id = sub.id)
  select array_agg(id), array_agg(table_name) into ids, tns from sub;
  if ids is null then return '{}'::text[]; end if;
  select coalesce(array_agg(storage_path) filter (where storage_path is not null), '{}') into paths
    from public.data_files where folder_id = any(ids);
  foreach t in array tns loop
    execute format('drop table if exists data.%I', t);
  end loop;
  delete from public.data_folders where id = p_folder_id;   -- cascades to sub-folders, files, columns
  return paths;
end $$;

-- ── Grants ──────────────────────────────────────────────────────────────────
revoke all on function public.data_create_folder(text,text,text,text) from public, anon;
revoke all on function public.data_ensure_columns(text,jsonb) from public, anon;
revoke all on function public.data_ingest_rows(text,text,text,jsonb) from public, anon;
revoke all on function public.data_folder_rows(text,int,int,text,boolean,text) from public, anon;
revoke all on function public.data_folder_count(text,text) from public, anon;
revoke all on function public.data_file_delete(text) from public, anon;
revoke all on function public.data_file_clear_rows(text) from public, anon;
revoke all on function public.data_folder_delete(text) from public, anon;
grant execute on function public.data_create_folder(text,text,text,text) to authenticated;
grant execute on function public.data_ensure_columns(text,jsonb) to authenticated;
grant execute on function public.data_ingest_rows(text,text,text,jsonb) to authenticated;
grant execute on function public.data_folder_rows(text,int,int,text,boolean,text) to authenticated;
grant execute on function public.data_folder_count(text,text) to authenticated;
grant execute on function public.data_file_delete(text) to authenticated;
grant execute on function public.data_file_clear_rows(text) to authenticated;
grant execute on function public.data_folder_delete(text) to authenticated;
