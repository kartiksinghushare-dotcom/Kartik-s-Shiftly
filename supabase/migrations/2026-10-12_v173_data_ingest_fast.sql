-- v173 — data_ingest_rows: fast path. The v172 version cast every cell through plpgsql helpers whose
-- EXCEPTION blocks open a sub-transaction per call (~10k per batch on a 70-column file → ~9 s/batch).
-- Now: one dynamic INSERT with regex-guarded plain casts (no sub-transactions). If a batch still raises
-- (e.g. a calendar-invalid date like 2025-02-30), that one batch is retried through the original safe
-- helpers, so nothing is ever lost or rejected. Additive: same signature, same behaviour.
create or replace function public.data_ingest_rows(p_folder_id text, p_file_id text, p_sheet text, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public, data as $$
declare tn text; cols text := ''; fast text := ''; safe text := ''; r record; n integer; v text;
begin
  perform data._require_auth();
  select table_name into tn from public.data_folders where id = p_folder_id;
  if tn is null then raise exception 'folder not found'; end if;
  for r in select col_name, col_type from public.data_columns where folder_id = p_folder_id order by ordinal loop
    cols := cols || ', ' || format('%I', r.col_name);
    v := format('(x->>%L)', r.col_name);
    fast := fast || ', ' || case r.col_type
      when 'numeric'     then format('case when %s ~ ''^[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$'' then %s::numeric end', v, v)
      when 'timestamptz' then format('case when %s ~ ''^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?)?[ ]?(Z|[+-][0-9]{2}:?[0-9]{2})?$'' then %s::timestamptz end', v, v)
      when 'date'        then format('case when %s ~ ''^[0-9]{4}-[0-9]{2}-[0-9]{2}'' then left(%s,10)::date end', v, v)
      when 'boolean'     then format('case lower(btrim(%s)) when ''true'' then true when ''yes'' then true when ''y'' then true when ''1'' then true when ''t'' then true when ''false'' then false when ''no'' then false when ''n'' then false when ''0'' then false when ''f'' then false else null end', v)
      else                    format('nullif(%s,'''')', v) end;
    safe := safe || ', ' || case r.col_type
      when 'numeric'     then format('data._num(%s)', v)
      when 'timestamptz' then format('data._ts(%s)', v)
      when 'date'        then format('data._date(%s)', v)
      when 'boolean'     then format('data._bool(%s)', v)
      else                    format('nullif(%s,'''')', v) end;
  end loop;
  begin
    execute format('insert into data.%I (_file_id, _sheet, _row_no%s) select %L, %L, (x->>''_row_no'')::int%s from jsonb_array_elements($1) x',
                   tn, cols, p_file_id, p_sheet, fast) using p_rows;
  exception when others then
    execute format('insert into data.%I (_file_id, _sheet, _row_no%s) select %L, %L, (x->>''_row_no'')::int%s from jsonb_array_elements($1) x',
                   tn, cols, p_file_id, p_sheet, safe) using p_rows;
  end;
  get diagnostics n = row_count;
  update public.data_files set rows = rows + n, updated_at = now() where id = p_file_id;
  return n;
end $$;
