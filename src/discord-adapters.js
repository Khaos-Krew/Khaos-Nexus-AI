import { randomUUID } from "node:crypto";

function requireAuth(context) {
  if (!context?.token || !context?.user?.id) {
    const error = new Error("Authentication is required");
    error.status = 401;
    throw error;
  }
}

export class LocalDiscordBridge {
  constructor() {
    this.bindings = new Map();
  }

  campaignBindings(campaignId) {
    if (!this.bindings.has(campaignId)) this.bindings.set(campaignId, []);
    return this.bindings.get(campaignId);
  }

  async listBindings(campaignId) {
    return this.campaignBindings(campaignId).map((binding) => structuredClone(binding));
  }

  async upsertBinding(campaignId, input) {
    const bindings = this.campaignBindings(campaignId);
    let binding = input.bindingId
      ? bindings.find((item) => item.id === input.bindingId)
      : bindings.find(
          (item) =>
            item.registeredAppId === input.registeredAppId &&
            item.guildId === input.guildId &&
            item.resourceType === input.resourceType &&
            item.resourceId === input.resourceId &&
            item.purpose === input.purpose,
        );
    const now = new Date().toISOString();
    if (input.isPrimary && input.purpose === "main") {
      for (const item of bindings) {
        if (
          item.registeredAppId === input.registeredAppId &&
          item.guildId === input.guildId &&
          item.purpose === "main"
        ) item.isPrimary = false;
      }
    }
    if (!binding) {
      binding = {
        id: randomUUID(),
        campaignId,
        createdAt: now,
      };
      bindings.push(binding);
    }
    Object.assign(binding, {
      registeredAppId: input.registeredAppId,
      guildId: input.guildId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      parentChannelId: input.parentChannelId,
      displayName: input.displayName,
      purpose: input.purpose,
      isPrimary: input.isPrimary,
      active: input.active,
      verifiedAt: null,
      lastErrorCode: "",
      updatedAt: now,
    });
    return structuredClone(binding);
  }

  async verifyBinding(campaignId, bindingId, input) {
    const binding = this.campaignBindings(campaignId).find((item) => item.id === bindingId);
    if (!binding) return null;
    binding.verifiedAt = input.verified ? new Date().toISOString() : null;
    binding.lastErrorCode = input.verified ? "" : input.errorCode || "verification_failed";
    binding.updatedAt = new Date().toISOString();
    return structuredClone(binding);
  }

  async resolveContext(input) {
    const binding = [...this.bindings.values()]
      .flat()
      .filter(
        (item) =>
          item.registeredAppId === input.registeredAppId &&
          item.guildId === input.guildId &&
          item.resourceId === input.resourceId &&
          item.active &&
          item.verifiedAt,
      )
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))[0];
    if (!binding) {
      const error = new Error("No active verified campaign binding for this Discord resource");
      error.status = 404;
      throw error;
    }
    return {
      campaignId: binding.campaignId,
      tenantId: null,
      binding: structuredClone(binding),
      member: {
        id: "local-member",
        userId: "local-user",
        discordUserId: input.discordUserId,
        displayName: "Local DM",
        role: "dm",
        capabilities: ["campaign_manage"],
      },
      canManage: true,
    };
  }
}

export class SupabaseDiscordBridge {
  constructor(client) {
    if (!client) throw new Error("Supabase REST client is required");
    this.client = client;
  }

  async listBindings(campaignId, context) {
    requireAuth(context);
    const result = await this.client.rpc(
      "dnd_ai_discord_bindings",
      { p_campaign_id: campaignId },
      context.token,
    );
    return Array.isArray(result) ? result : result?.bindings ?? [];
  }

  async upsertBinding(campaignId, input, context) {
    requireAuth(context);
    return this.client.rpc(
      "dnd_ai_upsert_discord_binding",
      {
        p_campaign_id: campaignId,
        p_binding_id: input.bindingId,
        p_registered_app_id: input.registeredAppId,
        p_guild_id: input.guildId,
        p_resource_type: input.resourceType,
        p_resource_id: input.resourceId,
        p_parent_channel_id: input.parentChannelId,
        p_display_name: input.displayName,
        p_purpose: input.purpose,
        p_is_primary: input.isPrimary,
        p_active: input.active,
      },
      context.token,
    );
  }

  async verifyBinding(campaignId, bindingId, input, context) {
    requireAuth(context);
    return this.client.rpc(
      "dnd_ai_verify_discord_binding",
      {
        p_campaign_id: campaignId,
        p_binding_id: bindingId,
        p_verified: input.verified,
        p_error_code: input.errorCode,
      },
      context.token,
    );
  }

  async resolveContext(input, context) {
    requireAuth(context);
    return this.client.rpc(
      "dnd_ai_discord_context",
      {
        p_registered_app_id: input.registeredAppId,
        p_guild_id: input.guildId,
        p_resource_id: input.resourceId,
        p_discord_user_id: input.discordUserId,
      },
      context.token,
    );
  }
}
