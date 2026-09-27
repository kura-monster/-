import { PermissionFlagsBits, type ChatInputCommandInteraction, type GuildMember, type User } from "discord.js";
import { touchCitizen } from "../services/citizen";
import { ensureGuild } from "../services/guild";
import type { Actor, Identity } from "../services/types";

export function identityOf(user: User, member?: GuildMember | null): Identity {
  return {
    discordId: user.id,
    displayName: member?.displayName ?? user.globalName ?? user.username,
    avatarUrl: (member ?? user).displayAvatarURL({ size: 128 }),
  };
}

export function isAdminMember(member: GuildMember | null | undefined): boolean {
  return member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
}

export async function actorFrom(interaction: ChatInputCommandInteraction<"cached">): Promise<Actor> {
  await ensureGuild(interaction.guild.id, interaction.guild.name);
  const identity = identityOf(interaction.user, interaction.member);
  await touchCitizen(interaction.guild.id, identity);
  return {
    guildId: interaction.guild.id,
    discordId: interaction.user.id,
    displayName: identity.displayName,
    isAdmin: interaction.memberPermissions.has(PermissionFlagsBits.Administrator),
  };
}

/** The target of a user option together with the facts services need about them. */
export function targetOf(interaction: ChatInputCommandInteraction<"cached">, option: string) {
  const user = interaction.options.getUser(option, true);
  const member = interaction.options.getMember(option);
  return { user, member, identity: identityOf(user, member), isDiscordAdmin: isAdminMember(member) };
}
