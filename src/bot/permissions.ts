import { PermissionFlagsBits } from "discord.js";

/**
 * What the bot needs: managing roles and timing out members, creating channels (/admin autosetup),
 * posting to channels and threads, plus every permission it grants to the roles it creates
 * (Discord only lets a bot grant what it has).
 */
export const REQUIRED_BOT_PERMISSIONS = [
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.PrioritySpeaker,
  PermissionFlagsBits.MentionEveryone,
];

export function inviteUrl(clientId: string): string {
  const permissions = REQUIRED_BOT_PERMISSIONS.reduce((all, bit) => all | bit, 0n);
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${permissions}`;
}
