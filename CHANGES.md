# Bridge v77 — three fixes

Cumulative. **7 files**, same repo paths. Cache-buster `?v=77`.
`index.html` · `public/js/01-supabase-sync.js` · `06-crm.js` · `15-questions-escalation.js` · `19-okr-roles-acl.js` · `04-nav-shell.js` · `src/styles/main.css`

---

## 1. "No button to add users on a channel" — there was one, but it was invisible in plain sight

The button existed and rendered fine at 360/390px. The real problem: it was a white `👥 1` chip, and the **board members** button sitting right below the tabs is *also* a white `👥 1` chip. Two identical controls meaning different things — so you tapped one, got board members, and concluded the channel one didn't exist.

Now:

- The **channel** control is a solid dark pill — `👥 Channel 1` — clearly the odd one out in a row of white buttons.
- The **board** control reads `👥 Board 1`.
- (The word is hidden on very narrow screens; the dark/white contrast still separates them.)
- A **channel-people icon now also sits on every hub row in the drawer**, which is where you naturally look on a phone to manage a channel.

Both are permission-gated and have 44px tap targets.

> Side note: while tracing this I found your design layer rewrites *any* button with inline `background:#10262E` into a gradient — and a later rule turns that gradient orange. My first attempt at a dark button silently came out orange because of it. The channel pill now uses a hex that isn't intercepted. Worth knowing if a "dark" button ever turns orange on you elsewhere.

## 2. Workspace notifications now open the actual chat/ticket

Added a nullable `link` column to `notifications` (migration `notifications_deep_link`, applied — additive, nothing else touched). New Workspace alerts carry `crm:<conversationId>`, and clicking one opens **that conversation**, on the right board and hub, marked read and scrolled to the latest message.

Your **existing** notifications predate that column, so they'd have no link — those fall back to matching the quoted title in the message (*"… tagged you in "Return""* → opens Return). Both paths are tested. If the conversation was deleted or isn't yours to see, you land on the Workspace with a quiet note rather than a dead end.

## 3. Add/remove no longer applies before you press Save

Both dialogs — channel **and** board — are now staged edits:

- Adding or removing only changes the list *in the dialog*.
- **Save changes** applies everything in one go: local state, database and everyone else's live screen.
- **Cancel**, the X, or tapping the backdrop discards the lot.
- The confirm prompt for removing *your own* channel access now fires at Save, not mid-edit.
- One toast summarising what happened ("2 added, 1 removed") instead of silent per-click writes.

Adding a whole people-group to a board is staged the same way.

---

## Verification
22 new tests covering all three (button visible/distinct/tappable at 390 **and** 360, drawer entry point, deep link with and without `link`, deleted-conversation fallback, permission check, and staged add/remove/cancel/save for both dialogs) — **22/22 pass**.

Everything prior still green: 13 notification, 17 access-control, 19 live/sticky, 19 mobile tap, 12 progress, 0 missing handlers, 0 horizontal overflow.

## Still open (your call)
- **`optional-rls-hardening.sql`** — included, not applied. Access is still app-enforced only.
- **Assign your people** — only 6 of 40 users have real Workspace assignments.
