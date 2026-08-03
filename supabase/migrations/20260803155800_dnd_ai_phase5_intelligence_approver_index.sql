begin;

create index if not exists dnd_sessions_intelligence_approved_by_idx
  on public.dnd_sessions (intelligence_approved_by)
  where intelligence_approved_by is not null;

commit;
