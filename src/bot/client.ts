import { Client, Events, GatewayIntentBits, MessageFlags, Partials, PermissionFlagsBits, type Interaction } from "discord.js";
import { DomainError } from "../core/errors";
import { removeCitizenship, touchCitizen } from "../services/citizen";
import { ensureGuild } from "../services/guild";
import { COMMANDS } from "./commands";
import type { BotCommand } from "./commands/types";
import { identityOf } from "./context";
import { inviteUrl } from "./permissions";
import { replyError } from "./ui";

const commands = new Map<string, BotCommand>(COMMANDS.map((command) => [command.data.name, command]));

export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isAutocomplete()) {
    if (!interaction.inCachedGuild()) return;
    try {
      await commands.get(interaction.commandName)?.autocomplete?.(interaction);
    } catch (error) {
      console.error(`[autocomplete:${interaction.commandName}]`, error);
      if (!interaction.responded) await interaction.respond([]).catch(() => undefined);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: "サーバー内で使用してください。", flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return;
  }
  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    // Server owners can re-expose /admin to other roles in Integrations settings; the admin faction is still Discord admins only.
    if (command.audience === "admin" && !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
      await replyError(interaction, "このコマンドは管理者専用です。");
      return;
    }
    await command.execute(interaction);
  } catch (error) {
    if (!(error instanceof DomainError)) console.error(`[command:${interaction.commandName}]`, error);
    const message = error instanceof DomainError ? error.message : "予期しないエラーが発生しました。時間をおいて再度お試しください。";
    await replyError(interaction, message).catch((replyFailure) => console.error("[reply]", replyFailure));
  }
}

export function createBot(onReady?: (client: Client<true>) => void): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    // Without the GuildMember partial, departures of members that were never cached would go unnoticed.
    partials: [Partials.GuildMember],
    allowedMentions: { parse: [] },
  });

  client.once(Events.ClientReady, (ready) => {
    console.log(`🏛️ 民主主義Bot 起動: ${ready.user.tag}（${ready.guilds.cache.size}サーバー）`);
    console.log(`🔗 招待URL: ${inviteUrl(ready.user.id)}`);
    for (const guild of ready.guilds.cache.values()) {
      ensureGuild(guild.id, guild.name).catch((error) => console.error("[guild]", error));
    }
    onReady?.(ready);
  });
  client.on(Events.GuildCreate, (guild) => {
    ensureGuild(guild.id, guild.name).catch((error) => console.error("[guild]", error));
  });
  client.on(Events.GuildMemberRemove, (member) => {
    const identity = { discordId: member.id, displayName: member.user?.username ?? member.id, avatarUrl: null };
    removeCitizenship(member.guild.id, identity, "LEFT_SERVER").catch((error) => console.error("[member remove]", error));
  });
  client.on(Events.GuildMemberUpdate, (_, member) => {
    touchCitizen(member.guild.id, identityOf(member.user, member)).catch((error) => console.error("[member update]", error));
  });
  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction);
  });
  return client;
}
