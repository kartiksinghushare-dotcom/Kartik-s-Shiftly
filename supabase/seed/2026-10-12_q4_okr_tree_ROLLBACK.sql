-- ═══ ROLLBACK for 2026-10-12_q4_okr_tree.sql — restores Bridge exactly as it was before 12 Oct ═══
begin;
-- 1. remove everything the Q4 import added
delete from public.okr_checkins where okr_id like 'okr_q4_%';
delete from public.okr_logs where okr_id like 'okr_q4_%';
delete from public.okrs where id like 'okr_q4_%';
-- 2. bring the 2 Oct seed back
update public.okrs set deleted_at = null, deleted_by = null, updated_at = now() where id like 'okr_r1k_%';
-- 3. put the 4 edited rows back from the snapshot
update public.okrs o set owner_id=b.owner_id, owners=b.owners, owner_tbd=b.owner_tbd, needs_decision=b.needs_decision, decision_note=b.decision_note, description=b.description, target_value=b.target_value, updated_at=now()
 from public.okrs_backup_2026_10_12 b where b.id=o.id and o.id in ('okr_fqqr7zd','okr_nwrkvpl','okr_ne2obtf','okr_kcwlg0a');
commit;
-- (the snapshot table public.okrs_backup_2026_10_12 is left in place on purpose)
