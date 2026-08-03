begin;

drop policy if exists dnd_map_scenes_rpc_only on public.dnd_map_scenes;
create policy dnd_map_scenes_rpc_only
on public.dnd_map_scenes
for all
to authenticated
using (false)
with check (false);

commit;
