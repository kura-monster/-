import { prisma } from "../../lib/prisma";
import { Guild as DiscordGuild } from "discord.js";

export async function ensureGuild(discordGuild: DiscordGuild) {
  return prisma.guild.upsert({
    where: { id: discordGuild.id },
    update: { name: discordGuild.name },
    create: {
      id: discordGuild.id,
      name: discordGuild.name,
    },
  });
}

export async function registerCitizen(discordId: string, guildId: string) {
  return prisma.citizen.upsert({
    where: { discordId_guildId: { discordId, guildId } },
    update: {},
    create: { discordId, guildId },
  });
}

export async function getCitizen(discordId: string, guildId: string) {
  return prisma.citizen.findUnique({
    where: { discordId_guildId: { discordId, guildId } },
    include: { positions: { where: { isActive: true } } },
  });
}

export async function getCitizenOrThrow(discordId: string, guildId: string) {
  const citizen = await getCitizen(discordId, guildId);
  if (!citizen) throw new Error("市民登録が必要です。`/citizen register` で登録してください。");
  return citizen;
}
