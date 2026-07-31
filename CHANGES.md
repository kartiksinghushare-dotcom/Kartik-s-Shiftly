# Bridge v74 — sticky Workspace position + live chat

**Deploy all 5 files.** They are cumulative: everything from v71–v73 (mobile UI, OKR accuracy) is included, because none of it is live on your Vercel site yet.

| File | Why |
|---|---|
| `index.html` | cache-buster `?v=74` |
| `public/js/06-crm.js` | sticky position + live chat + all mobile fixes |
| `public/js/19-okr-roles-acl.js` | OKR filters/banners + progress accuracy |
| `public/js/04-nav-shell.js` | logout clears the remembered board + closes the live socket |
| `src/styles/main.css` | mobile layout rules |

---

## 1. Refresh keeps you where you were

The Workspace now remembers your **hub, board, filtered view and open conversation**, so a refresh (or closing and reopening the tab) puts you back on the same board instead of bouncing to the first one.

- Stored per browser and **stamped with your user id** — on a shared device the next person to sign in never inherits your position.
- If the remembered board was deleted or your access was removed, it falls back to the first board you can see rather than showing an error.
- Cleared on sign-out.

## 2. Messages arrive by themselves

No more reloading to see new messages.

- **Supabase Realtime push** — I enabled it on your project (see below). New messages, edits, deletions and brand-new conversations all appear instantly.
- **Polling safety net** — a small "anything newer than what I have?" query runs as backup, so a dropped socket or a phone waking from sleep still catches up. It only asks for rows newer than what's already loaded, so it stays tiny (it does *not* re-download the workspace).
- **It never interrupts you.** A message landing mid-typing preserves your draft text, cursor position and focus; pending image attachments stay attached; if you've scrolled up to read history you stay there, and if you were at the bottom you stay pinned to the newest message. A message you're editing is never yanked out from under you.
- Your own messages don't duplicate when the server echoes them back.

### Database change I made (approved)
Migration `enable_realtime_for_workspace_chat` on project `bxuhmyxfzoqvmukausjd`:

```sql
alter publication supabase_realtime add table public.crm_messages;
alter publication supabase_realtime add table public.crm_conversations;
alter table public.crm_messages replica identity full;
alter table public.crm_conversations replica identity full;
```

Additive and reversible. No schema, no data, no RLS policy changed — verified afterwards (5 messages / 1 conversation intact). `REPLICA IDENTITY FULL` only affects what the write-ahead log carries, which is what lets live edits and deletes work.

To undo: `alter publication supabase_realtime drop table public.crm_messages, public.crm_conversations;` (the app falls back to polling automatically).

**Note on visibility:** your `crm_messages` / `crm_conversations` policies are `ALL … using (true)` for authenticated users, so realtime delivers to any signed-in user and board-level scoping stays client-side — exactly as it already worked before this change. Nothing new is exposed, but if you ever want board membership enforced in the database, that's a separate (worthwhile) piece of work.

---

## Verification
- 19 live/sticky tests (reload persistence, another user's position ignored, deleted board fallback, incoming message, duplicate echo, draft preserved, focus kept, scroll pinned, live edit, live delete, new conversation, polling fallback, edit-in-progress protection) — **19/19 pass**
- 19 mobile tap tests — **19/19 pass**
- 12 progress-accuracy cases — **12/12 pass**
- Every `onclick` checked against real functions — **0 missing**
- 0 horizontal overflow at iPhone 390px and Android 360px
