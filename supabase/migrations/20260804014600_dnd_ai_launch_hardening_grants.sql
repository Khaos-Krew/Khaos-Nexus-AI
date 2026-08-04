begin;

revoke all on function private.dnd_ai_scope_tenant_explicit(uuid,uuid) from public,anon;
revoke all on function private.dnd_ai_generation_policy_v2(uuid,uuid,text,text,text,text,text,text) from public,anon;
revoke all on function private.dnd_ai_reserve_generation_core(uuid,uuid,uuid,text,text,text,text,text,text,bigint,bigint,text) from public,anon;
revoke all on function private.dnd_ai_reserve_generation_v2(uuid,uuid,uuid,text,text,text,text,text,text,bigint,bigint,text) from public,anon;

grant execute on function private.dnd_ai_scope_tenant_explicit(uuid,uuid) to authenticated;
grant execute on function private.dnd_ai_generation_policy_v2(uuid,uuid,text,text,text,text,text,text) to authenticated;
grant execute on function private.dnd_ai_reserve_generation_core(uuid,uuid,uuid,text,text,text,text,text,text,bigint,bigint,text) to authenticated;
grant execute on function private.dnd_ai_reserve_generation_v2(uuid,uuid,uuid,text,text,text,text,text,text,bigint,bigint,text) to authenticated;

commit;
