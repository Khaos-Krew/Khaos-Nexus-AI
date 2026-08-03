begin;

create index if not exists dnd_map_scenes_created_by_idx
  on public.dnd_map_scenes (created_by);

commit;
