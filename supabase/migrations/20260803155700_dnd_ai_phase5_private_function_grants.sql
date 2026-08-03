begin;

revoke all on function private.dnd_ai_session_intelligence(uuid,uuid) from public, anon;
revoke all on function private.dnd_ai_save_session_intelligence(uuid,uuid,jsonb,integer) from public, anon;
revoke all on function private.dnd_ai_approve_session_intelligence(uuid,uuid,integer) from public, anon;
revoke all on function private.dnd_ai_public_session_intelligence(jsonb) from public, anon;

grant execute on function private.dnd_ai_session_intelligence(uuid,uuid) to authenticated;
grant execute on function private.dnd_ai_save_session_intelligence(uuid,uuid,jsonb,integer) to authenticated;
grant execute on function private.dnd_ai_approve_session_intelligence(uuid,uuid,integer) to authenticated;

commit;
