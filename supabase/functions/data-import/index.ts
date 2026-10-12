// Bridge — data-import (v176)
// Server-side bulk import for the DATA module. The browser uploads the file to Storage (bucket
// `data-files`), then calls this function in a loop; each call streams ONE byte-range chunk of a CSV
// straight from Storage into the folder's table with array-based (unnest) inserts — no JSON per row,
// no per-row API calls. Excel files are converted to one CSV per sheet in the browser first.
//
// Request (POST, user JWT):  { file_id, path, sheet, offset, state }
//   offset  byte offset into the CSV object (0 to start)
//   state   opaque object returned by the previous call (column map, delimiter, carry-over text)
// Response: { done, offset, size, rows, state }
//
// Each call is bounded (~6 MB of CSV, a few seconds of CPU) so it stays inside Edge Function limits;
// the browser keeps calling until `done`.
import { createClient } from "npm:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";
import Papa from "npm:papaparse@5.4.1";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DB_URL = Deno.env.get("SUPABASE_DB_URL")!;
const BUCKET = "data-files";
const CHUNK = 6 * 1024 * 1024;          // bytes of CSV per call
const INSERT_ROWS = 4000;               // rows per INSERT statement
const SAMPLE = 1000;                    // rows used to infer column types

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });

type Col = { name: string; label: string; type: "text" | "numeric" | "date" | "timestamptz" | "boolean"; dmy: boolean };
type State = { cols: Col[]; delimiter: string; carry: string; rowNo: number; headerDone: boolean };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // ── who is calling ──
  const authHeader = req.headers.get("Authorization") || "";
  const asUser = createClient(SB_URL, ANON, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: who } = await asUser.auth.getUser();
  if (!who?.user) return json({ error: "not authenticated" }, 401);

  let body: { file_id?: string; path?: string; sheet?: string; offset?: number; state?: State | null } = {};
  try { body = await req.json(); } catch { /* empty */ }
  const fileId = String(body.file_id || ""), path = String(body.path || ""), sheet = String(body.sheet || "Sheet1");
  let offset = Math.max(0, Number(body.offset || 0));
  if (!fileId || !path) return json({ error: "file_id and path are required" }, 400);

  const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });
  const { data: file } = await admin.from("data_files").select("id,folder_id,status").eq("id", fileId).maybeSingle();
  if (!file) return json({ error: "file record not found" }, 404);
  const { data: folder } = await admin.from("data_folders").select("id,table_name").eq("id", file.folder_id).maybeSingle();
  if (!folder) return json({ error: "folder not found" }, 404);

  // ── read one chunk of the object (Range request) ──
  const objUrl = `${SB_URL}/storage/v1/object/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const r = await fetch(objUrl, { headers: { Authorization: `Bearer ${SERVICE}`, apikey: SERVICE, Range: `bytes=${offset}-${offset + CHUNK - 1}` } });
  if (!(r.status === 200 || r.status === 206)) return json({ error: `storage read failed (${r.status})` }, 502);
  const buf = new Uint8Array(await r.arrayBuffer());
  const total = sizeFrom(r.headers.get("content-range")) ?? (r.status === 200 ? buf.length : null);
  const last = total === null ? buf.length < CHUNK : offset + buf.length >= total;

  // Cut on BYTES at the last newline that is not inside a quoted field (quote parity from the chunk
  // start, which is always a row boundary). ASCII bytes never occur inside UTF-8 multi-byte sequences,
  // so this never splits a character or a row; the next call starts exactly there.
  let cut = buf.length;
  if (!last) {
    cut = safeCutBytes(buf);
    if (cut === 0) return json({ error: "a single row is larger than 6 MB — cannot import this file" }, 400);
  }
  let text = new TextDecoder("utf-8").decode(buf.subarray(0, cut));
  if (offset === 0 && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const state: State = body.state && body.state.cols ? body.state : { cols: [], delimiter: "", carry: "", rowNo: 0, headerDone: false };

  const parsed = Papa.parse<string[]>(text, { delimiter: state.delimiter || undefined, skipEmptyLines: "greedy", header: false });
  if (!state.delimiter) state.delimiter = parsed.meta.delimiter || ",";
  let rows: string[][] = parsed.data || [];

  const sql = postgres(DB_URL, { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 15 });
  let inserted = 0;
  try {
    // ── header + types (first call only) ──
    if (!state.headerDone) {
      while (rows.length && isBlank(rows[0])) rows.shift();
      if (!rows.length) { if (last) return done(sql, fileId, offset + cut, total, 0, state); await sql.end({ timeout: 2 }).catch(() => {}); return json({ done: false, offset: offset + cut, size: total, rows: 0, state }); }
      const header = rows.shift()!;
      state.rowNo = 1;
      const sample = rows.slice(0, SAMPLE);
      state.cols = buildCols(header, sample);
      state.headerDone = true;
      await sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: who.user!.id, role: "authenticated" })}, true)`;
        // sql.json(): typed jsonb parameter (a bare array would be read as a VALUES helper, a string double-encoded)
        await tx`select public.data_ensure_columns(${folder.id}, ${sql.json(state.cols.map((c) => ({ name: c.name, label: c.label, type: c.type })))})`;
      });
    }
    // a retried chunk must not duplicate rows: drop anything this sheet already wrote past the resume point
    await sql`delete from ${sql("data." + folder.table_name)} where _file_id = ${fileId} and _sheet = ${sheet} and _row_no > ${body.state && body.state.headerDone ? body.state.rowNo : 0}`;
    // the registry may have widened a type since (earlier file) — always insert with the registry's types
    const reg = await sql<{ col_name: string; col_type: string }[]>`select col_name, col_type from public.data_columns where folder_id = ${folder.id}`;
    const regType: Record<string, string> = {};
    for (const x of reg) regType[x.col_name] = x.col_type;

    // ── insert in batches: one statement per INSERT_ROWS rows, columns as arrays ──
    const cols = state.cols;
    const n = cols.length;
    for (let i = 0; i < rows.length; i += INSERT_ROWS) {
      const batch = rows.slice(i, i + INSERT_ROWS).filter((r) => !isBlank(r));
      if (!batch.length) continue;
      const rowNos: number[] = [];
      const arrays: (string | null)[][] = Array.from({ length: n }, () => []);
      for (const r of batch) {
        state.rowNo++;
        rowNos.push(state.rowNo);
        for (let c = 0; c < n; c++) {
          const t = (regType[cols[c].name] || cols[c].type) as Col["type"];
          arrays[c].push(norm(r[c], t, cols[c].dmy));
        }
      }
      const selects = cols.map((c, idx) => castExpr(sql, (regType[c.name] || c.type) as Col["type"], arrays[idx]));
      // identifiers one by one: after the word "insert" the driver would read an array as a VALUES helper
      const colList = (cols.map((c) => sql(c.name)) as any[]).reduce((acc: any, id: any) => sql`${acc}, ${id}`);
      await sql`insert into ${sql("data." + folder.table_name)} (_file_id, _sheet, _row_no, ${colList})
                select ${fileId}, ${sheet}, unnest(${sql.array(rowNos)}::int[]), ${selects.reduce((acc, s, idx) => idx === 0 ? s : sql`${acc}, ${s}`)}`;
      inserted += batch.length;
    }
    if (inserted) await sql`update public.data_files set rows = rows + ${inserted}, updated_at = now() where id = ${fileId}`;
  } catch (e) {
    console.error("[data-import]", fileId, sheet, offset, String((e as Error)?.message || e));
    await sql.end({ timeout: 2 }).catch(() => {});
    return json({ error: String((e as Error)?.message || e) }, 500);
  }

  const nextOffset = offset + cut;
  if (last) return done(sql, fileId, nextOffset, total, inserted, state);
  await sql.end({ timeout: 2 }).catch(() => {});
  return json({ done: false, offset: nextOffset, size: total, rows: inserted, state });
});

async function done(sql: ReturnType<typeof postgres>, _fileId: string, offset: number, size: number | null, rows: number, state: State) {
  await sql.end({ timeout: 2 }).catch(() => {});
  return json({ done: true, offset, size, rows, state: { ...state, carry: "" } });
}

/* ───────── helpers ───────── */
function sizeFrom(cr: string | null): number | null { const m = cr && cr.match(/\/(\d+)\s*$/); return m ? Number(m[1]) : null; }
function isBlank(a: string[] | undefined) { if (!a) return true; for (const v of a) if (v !== null && v !== undefined && String(v).trim() !== "") return false; return true; }
function safeCutBytes(b: Uint8Array): number {
  // byte index just after the last '\n' preceded by an even number of '"' → not inside a quoted field
  let quotes = 0, cut = 0;
  for (let i = 0; i < b.length; i++) { const ch = b[i]; if (ch === 34) quotes++; else if (ch === 10 && (quotes & 1) === 0) cut = i + 1; }
  return cut;
}
function slug(s: string) { s = String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); if (!s) s = "col"; if (/^[0-9]/.test(s)) s = "c_" + s; return s.slice(0, 50); }
function buildCols(header: string[], sample: string[][]): Col[] {
  const seen: Record<string, 1> = {}; const out: Col[] = [];
  for (let i = 0; i < header.length; i++) {
    const raw = header[i]; const label = raw === null || raw === undefined || String(raw).trim() === "" ? `Column ${i + 1}` : String(raw).trim();
    let nm = slug(label); const base = nm; let k = 2; while (seen[nm]) { nm = base.slice(0, 46) + "_" + k; k++; } seen[nm] = 1;
    let num = 0, dat = 0, bool = 0, n = 0, hasTime = false, firstGt12 = false, secondGt12 = false;
    for (const r of sample) {
      const v = r[i]; if (v === null || v === undefined || String(v).trim() === "") continue; n++;
      const s = String(v).trim();
      if (isNumStr(s)) { num++; continue; }
      const d = dateParts(s); if (d) { dat++; if (d.time) hasTime = true; if (!d.iso) { if (d.a > 12) firstGt12 = true; if (d.b > 12) secondGt12 = true; } continue; }
      if (/^(true|false|yes|no|y|n)$/i.test(s)) { bool++; continue; }
    }
    let type: Col["type"] = "text";
    if (n > 0) { if (num === n) type = "numeric"; else if (dat === n) type = hasTime ? "timestamptz" : "date"; else if (bool === n) type = "boolean"; }
    out.push({ name: nm, label, type, dmy: firstGt12 ? true : secondGt12 ? false : true });
  }
  return out;
}
function isNumStr(s: string) { if (!/^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?$/.test(s)) return false; if (/^[-+]?0\d/.test(s)) return false; const d = s.replace(/[^0-9]/g, ""); return d.length > 0 && d.length <= 15; }
function dateParts(s: string) {
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*(Z|[+-]\d{2}:?\d{2})?)?$/);
  if (m) return { iso: true, y: +m[1], a: +m[2], b: +m[3], time: !!m[4], h: m[4], mi: m[5], se: m[6], tz: m[7], ap: undefined as string | undefined };
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/);
  if (m) return { iso: false, a: +m[1], b: +m[2], y: +m[3], time: !!m[4], h: m[4], mi: m[5], se: m[6], tz: undefined as string | undefined, ap: m[7] };
  return null;
}
const pad = (n: number | string) => String(n).padStart(2, "0");
function strDateToISO(s: string, dmy: boolean, withTime: boolean): string | null {
  const p = dateParts(s); if (!p) return null; let y: number, mo: number, da: number;
  if (p.iso) { y = p.y; mo = p.a; da = p.b; } else { y = p.y < 100 ? (p.y < 70 ? 2000 + p.y : 1900 + p.y) : p.y; if (dmy) { da = p.a; mo = p.b; } else { mo = p.a; da = p.b; } }
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  const chk = new Date(Date.UTC(y, mo - 1, da)); if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== da) return null;
  let out = `${y}-${pad(mo)}-${pad(da)}`;
  if (withTime) { let h = p.time ? +p.h! : 0; if (p.ap) { const ap = p.ap.toLowerCase(); if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0; } out += `T${pad(h)}:${p.time ? p.mi : "00"}:${p.time && p.se ? p.se : "00"}${p.tz || ""}`; }
  return out;
}
function norm(v: string | undefined, type: Col["type"], dmy: boolean): string | null {
  if (v === null || v === undefined) return null; const s = String(v).trim(); if (s === "") return null;
  if (type === "date") return strDateToISO(s, dmy, false);
  if (type === "timestamptz") return strDateToISO(s, dmy, true);
  if (type === "numeric") { const n = s.replace(/[,\s]/g, ""); return /^[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?$/.test(n) ? n : null; }
  if (type === "boolean") { const b = s.toLowerCase(); return /^(true|yes|y|1|t)$/.test(b) ? "true" : /^(false|no|n|0|f)$/.test(b) ? "false" : null; }
  return s;
}
// values are pre-validated by norm(), so plain casts are safe here. sql.array(): a bare JS array would be
// read by the driver as a VALUES/IN helper rather than an array parameter.
function castExpr(sql: ReturnType<typeof postgres>, type: Col["type"], arr: (string | null)[]) {
  switch (type) {
    case "numeric": return sql`unnest(${sql.array(arr)}::text[])::numeric`;
    case "date": return sql`unnest(${sql.array(arr)}::text[])::date`;
    case "timestamptz": return sql`unnest(${sql.array(arr)}::text[])::timestamptz`;
    case "boolean": return sql`unnest(${sql.array(arr)}::text[])::boolean`;
    default: return sql`unnest(${sql.array(arr)}::text[])`;
  }
}
