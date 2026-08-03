-- Khaos Nexus AI Phase 1: indexes and policy hardening.
-- All API access remains caller-scoped through authenticated user JWTs.

begin;

create index if not exists dnd_campaign_members_active_user_idx
  on public.dnd_campaign_members (campaign_id, user_id)
  where active;
create index if not exists dnd_campaigns_owner_tenant_idx
  on public.dnd_campaigns (owner_user_id, tenant_id);
create index if not exists dnd_characters_campaign_owner_idx
  on public.dnd_characters (campaign_id, owner_user_id);
create index if not exists dnd_npcs_campaign_revealed_idx
  on public.dnd_npcs (campaign_id, revealed);
create index if not exists dnd_locations_campaign_revealed_idx
  on public.dnd_locations (campaign_id, revealed);
create index if not exists dnd_factions_campaign_revealed_idx
  on public.dnd_factions (campaign_id, revealed);
create index if not exists dnd_quests_campaign_visible_idx
  on public.dnd_quests (campaign_id, visible_to_players);
create index if not exists dnd_homebrew_campaign_status_idx
  on public.dnd_homebrew (campaign_id, status, author_user_id);
create index if not exists dnd_encounter_combatants_campaign_encounter_idx
  on public.dnd_encounter_combatants (campaign_id, encounter_id);

-- The old predicate compared c.campaign_id to itself. Require the character,
-- encounter, and proposed combatant to belong to the same campaign.
drop policy if exists combatants_insert on public.dnd_encounter_combatants;
create policy combatants_insert
on public.dnd_encounter_combatants
for insert
to authenticated
with check (
  public.dnd_can_manage_campaign(dnd_encounter_combatants.campaign_id)
  or (
    dnd_encounter_combatants.character_id is not null
    and exists (
      select 1
      from public.dnd_characters c
      join public.dnd_encounters e
        on e.id = dnd_encounter_combatants.encounter_id
       and e.campaign_id = dnd_encounter_combatants.campaign_id
      where c.id = dnd_encounter_combatants.character_id
        and c.campaign_id = dnd_encounter_combatants.campaign_id
        and c.owner_user_id = (select auth.uid())
    )
  )
);

-- Authors may edit drafts/submissions. Only campaign managers can approve or
-- attach approval metadata.
drop policy if exists homebrew_update on public.dnd_homebrew;
create policy homebrew_update
on public.dnd_homebrew
for update
to authenticated
using (
  public.dnd_can_manage_campaign(dnd_homebrew.campaign_id)
  or (
    dnd_homebrew.author_user_id = (select auth.uid())
    and dnd_homebrew.status in ('draft', 'submitted')
  )
)
with check (
  public.dnd_can_manage_campaign(dnd_homebrew.campaign_id)
  or (
    dnd_homebrew.author_user_id = (select auth.uid())
    and dnd_homebrew.status in ('draft', 'submitted')
    and dnd_homebrew.approved_by is null
    and dnd_homebrew.approved_at is null
  )
);

commit;
