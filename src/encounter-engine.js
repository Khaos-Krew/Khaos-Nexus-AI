import { randomUUID } from "node:crypto";

function clone(value) {
  return structuredClone(value);
}

function orderCombatants(encounter) {
  return [...encounter.combatants.values()]
    .filter((combatant) => combatant.active)
    .sort((a, b) =>
      b.initiative - a.initiative ||
      b.dexterity - a.dexterity ||
      a.joinedAt.localeCompare(b.joinedAt) ||
      a.id.localeCompare(b.id),
    );
}

function state(encounter) {
  if (!encounter) return null;
  return {
    canManage: true,
    encounter: {
      id: encounter.id,
      campaignId: encounter.campaignId,
      sessionId: encounter.sessionId,
      name: encounter.name,
      status: encounter.status,
      round: encounter.round,
      currentTurnIndex: encounter.currentTurnIndex,
      metadata: clone(encounter.metadata),
      createdAt: encounter.createdAt,
      updatedAt: encounter.updatedAt,
    },
    combatants: orderCombatants(encounter).map(clone),
  };
}

export class LocalEncounterEngine {
  constructor() {
    this.campaigns = new Map();
  }

  campaign(id) {
    if (!this.campaigns.has(id)) this.campaigns.set(id, new Map());
    return this.campaigns.get(id);
  }

  getState(campaignId, encounterId) {
    return state(this.campaign(campaignId).get(encounterId));
  }

  execute(campaignId, tool, args) {
    const encounters = this.campaign(campaignId);
    const now = () => new Date().toISOString();
    let encounter;
    let combatant;

    const getEncounter = (id) => {
      const result = encounters.get(id);
      if (!result) throw new Error("Encounter not found");
      return result;
    };

    const getCombatant = (id) => {
      for (const result of encounters.values()) {
        const member = result.combatants.get(id);
        if (member) return [result, member];
      }
      throw new Error("Combatant not found");
    };

    switch (tool) {
      case "create_encounter": {
        const timestamp = now();
        encounter = {
          id: randomUUID(),
          campaignId,
          sessionId: args.sessionId,
          name: args.name,
          status: args.status,
          round: 1,
          currentTurnIndex: 0,
          metadata: args.metadata,
          createdAt: timestamp,
          updatedAt: timestamp,
          combatants: new Map(),
        };
        encounters.set(encounter.id, encounter);
        return { tool, encounterId: encounter.id, result: state(encounter) };
      }
      case "set_encounter_status":
        encounter = getEncounter(args.encounterId);
        if (args.status === "active" && orderCombatants(encounter).length === 0) {
          throw new Error("Cannot start an encounter without active combatants");
        }
        encounter.status = args.status;
        if (args.status === "active") {
          encounter.round = 1;
          encounter.currentTurnIndex = 0;
        }
        break;
      case "add_combatant": {
        encounter = getEncounter(args.encounterId);
        const timestamp = now();
        combatant = {
          id: randomUUID(),
          characterId: args.characterId,
          npcId: args.npcId,
          name: args.name || "Combatant",
          initiative: args.initiative,
          dexterity: args.dexterity,
          hp: Object.hasOwn(args, "hp") ? args.hp : null,
          maxHp: Object.hasOwn(args, "maxHp") ? args.maxHp : null,
          tempHp: args.tempHp,
          armorClass: Object.hasOwn(args, "armorClass") ? args.armorClass : null,
          conditions: [],
          conditionDetails: {},
          concentration: {},
          reactionAvailable: true,
          deathSaveSuccesses: 0,
          deathSaveFailures: 0,
          legendaryActionsMax: args.legendaryActionsMax,
          legendaryActionsRemaining: args.legendaryActionsMax,
          isLairActor: args.isLairActor,
          hidden: args.hidden,
          active: true,
          metadata: { ...args.metadata, team: args.team },
          revision: 1,
          joinedAt: timestamp,
          updatedAt: timestamp,
        };
        encounter.combatants.set(combatant.id, combatant);
        encounter.updatedAt = timestamp;
        return { tool, encounterId: encounter.id, result: clone(combatant) };
      }
      case "set_initiative":
        [encounter, combatant] = getCombatant(args.combatantId);
        combatant.initiative = args.initiative;
        combatant.dexterity = args.dexterity;
        break;
      case "advance_turn":
      case "rewind_turn": {
        encounter = getEncounter(args.encounterId);
        const ordered = orderCombatants(encounter);
        if (!ordered.length) throw new Error("Encounter has no active combatants");
        let next = encounter.currentTurnIndex + (tool === "advance_turn" ? 1 : -1);
        if (next >= ordered.length) {
          next = 0;
          encounter.round += 1;
        }
        if (next < 0) {
          next = ordered.length - 1;
          encounter.round = Math.max(1, encounter.round - 1);
        }
        encounter.currentTurnIndex = next;
        ordered[next].reactionAvailable = true;
        ordered[next].legendaryActionsRemaining = ordered[next].legendaryActionsMax;
        ordered[next].revision += 1;
        ordered[next].updatedAt = now();
        encounter.updatedAt = now();
        return { tool, encounterId: encounter.id, result: state(encounter) };
      }
      case "apply_damage": {
        [encounter, combatant] = getCombatant(args.combatantId);
        if (combatant.hp === null) throw new Error("Combatant does not track HP");
        const absorbed = Math.min(combatant.tempHp, args.amount);
        combatant.tempHp -= absorbed;
        combatant.hp = Math.max(0, combatant.hp - (args.amount - absorbed));
        combatant.absorbedByTempHp = absorbed;
        break;
      }
      case "heal":
        [encounter, combatant] = getCombatant(args.combatantId);
        if (combatant.hp === null) throw new Error("Combatant does not track HP");
        combatant.hp = combatant.maxHp === null
          ? combatant.hp + args.amount
          : Math.min(combatant.maxHp, combatant.hp + args.amount);
        break;
      case "set_combatant_stats":
        [encounter, combatant] = getCombatant(args.combatantId);
        for (const key of ["hp", "maxHp", "tempHp", "armorClass"]) {
          if (Object.hasOwn(args, key)) combatant[key] = args[key];
        }
        break;
      case "add_condition":
        [encounter, combatant] = getCombatant(args.combatantId);
        if (!combatant.conditions.includes(args.condition)) combatant.conditions.push(args.condition);
        combatant.conditions.sort();
        combatant.conditionDetails[args.condition] = args.details;
        break;
      case "remove_condition":
        [encounter, combatant] = getCombatant(args.combatantId);
        combatant.conditions = combatant.conditions.filter((item) => item !== args.condition);
        delete combatant.conditionDetails[args.condition];
        break;
      case "set_concentration":
        [encounter, combatant] = getCombatant(args.combatantId);
        combatant.concentration = args.active
          ? { active: true, effect: args.effect, source: args.source, startedAt: now() }
          : {};
        break;
      case "set_reaction":
        [encounter, combatant] = getCombatant(args.combatantId);
        combatant.reactionAvailable = args.available;
        break;
      case "record_death_save":
        [encounter, combatant] = getCombatant(args.combatantId);
        if (args.outcome === "reset") {
          combatant.deathSaveSuccesses = 0;
          combatant.deathSaveFailures = 0;
        } else if (args.outcome === "success") {
          combatant.deathSaveSuccesses = Math.min(3, combatant.deathSaveSuccesses + 1);
        } else if (args.outcome === "failure") {
          combatant.deathSaveFailures = Math.min(3, combatant.deathSaveFailures + 1);
        } else if (args.outcome === "natural-1") {
          combatant.deathSaveFailures = Math.min(3, combatant.deathSaveFailures + 2);
        } else {
          combatant.deathSaveSuccesses = 0;
          combatant.deathSaveFailures = 0;
          combatant.hp = Math.max(1, combatant.hp ?? 0);
        }
        break;
      case "set_legendary_actions":
        [encounter, combatant] = getCombatant(args.combatantId);
        combatant.legendaryActionsMax = args.maximum;
        combatant.legendaryActionsRemaining = args.remaining;
        break;
      case "set_combatant_visibility":
        [encounter, combatant] = getCombatant(args.combatantId);
        combatant.hidden = args.hidden;
        combatant.active = args.active;
        break;
      default:
        throw new Error(`Unsupported encounter tool: ${tool}`);
    }

    const timestamp = now();
    if (combatant) {
      combatant.revision += 1;
      combatant.updatedAt = timestamp;
    }
    if (encounter) encounter.updatedAt = timestamp;
    return {
      tool,
      encounterId: encounter?.id,
      result: combatant ? clone(combatant) : state(encounter),
    };
  }
}
