# Bridge v75 — Workspace access: channel-level vs board-level

## ⚠️ Read this first

Right now **34 of your 40 active users can see every board** — not because they were assigned, but because of the bug below. Once v75 is deployed those 34 see **nothing** until you assign them. That's the fix working, but it will feel abrupt if you're not expecting it.

Who genuinely has access today:

| Channel | Channel members | Boards |
|---|---|---|
| CS - OPs | Kartik Hushare | Chat, Complaints, Picture Request, Updates |
| Pro x Inventory | Kartik Hushare | Chat, Receiving Inventory (+ Anam Noor, Kartiksingh Hushare on that board) |

**Plan:** deploy → open each channel → **People** button in the header → add everyone who should see the whole channel. Anyone who should see just one board goes on that board's member list instead (the existing 👥 button).

---

## What was actually broken

Two separate leaks, both in the visibility rules:

1. **`created it` was a permanent grant.** Board visibility ended with `return b.createdBy === S.uid` — so removing somebody from a board they had created never took their access away. That's the "removed but can still see it" symptom.
2. **Permission to *create* revealed every channel.** Hub visibility began with `if (_crmSeeAll() || can('crm','create')) return true`, and your Basic Employee role grants `create`. So every ordinary employee saw every channel. Worse, the "heal a missing Chat board" routine then ran across *all* channels and quietly created a board with that person as a member — inside channels they'd never been given.

Both are gone.

## The new model

- **Channel (hub) member → sees every board in that channel.**
- **Board member → sees only that board** (the channel still appears so they can reach it).
- Neither → sees nothing.
- Creating something no longer grants access on its own; whoever creates a channel is added as a channel member, so nobody locks themselves out.

## It's driven by permissions, not hardcoded

Three new Workspace toggles appear in **Access Control → Workspace**:

| Permission | What it does |
|---|---|
| **Assign people (channel)** | May add/remove people at channel level |
| **Assign people (board)** | May add/remove people on a single board |
| **See every channel & board** | Bypasses membership entirely |

Defaults: Super Admin & Administrator get all three; Team Lead / Manager gets board-level assignment; Basic Employee gets none. Existing admin role profiles keep full visibility even before you re-save them (`isAdmin()` remains a fallback), so nothing breaks on upgrade. Any custom role can be given exactly the mix you want.

## New UI

A **People** button next to the channel name in the Workspace header opens a panel with three clear sections: who has channel-wide access, who is board-only (with the board names listed), and everyone you can add. Removing your own channel access asks for confirmation first.

Access changes apply **live** — revoke someone mid-session and the board disappears from their screen without a reload.

## Database (applied)

Migration `crm_hub_members_channel_level_access`: a new `crm_hub_members` table, indexed, RLS enabled, added to the realtime publication, plus a backfill making each hub's creator a channel member so no existing owner is locked out. Additive only — no existing table, column, policy or row was modified.

## Still app-enforced, not database-enforced

Your `crm_messages` / `crm_conversations` policies are still `using (true)` for any signed-in user. v75 fixes what the **UI** shows; a signed-in person who knows the API URL could in principle still query another channel's messages directly. `optional-rls-hardening.sql` (included, **not applied**) moves the same channel/board rule into the database. I left it for you to review because a mistake there locks out all 40 users — say the word and I'll apply and verify it.

## Verification
- 17 new access-control tests (channel member, board-only member, removed creator, unassigned employee, admin, search scope, auto-board spraying, each permission toggle, live revocation) — **17/17 pass**
- Previous suites all still green: 19 live/sticky, 19 mobile tap, 12 progress, 0 missing handlers, 0 horizontal overflow

## Deploy
All 5 files, same repo paths. Cache-buster is now `?v=75` — confirm the page source shows it.
