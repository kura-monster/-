import { prisma } from "../../lib/prisma";
import { POSITION_TYPES } from "../../lib/constants";

export async function getGovernment(guildId: string) {
  const positions = await prisma.position.findMany({
    where: { guildId, isActive: true },
    include: { citizen: true },
    orderBy: { appointedAt: "desc" },
  });

  const representatives = positions.filter((p) => p.type === POSITION_TYPES.REPRESENTATIVE);
  const ministers = positions.filter((p) => p.type === POSITION_TYPES.MINISTER);
  const aides = positions.filter((p) => p.type === POSITION_TYPES.AIDE);
  const judges = positions.filter((p) => p.type === POSITION_TYPES.JUDGE);

  return { representatives, ministers, aides, judges };
}

export async function appointPosition(
  guildId: string,
  citizenId: string,
  type: string,
  title: string,
  appointedById: string
) {
  return prisma.position.create({
    data: {
      type,
      title,
      citizenId,
      guildId,
      appointedById,
    },
  });
}

export async function dismissPosition(positionId: string) {
  return prisma.position.update({
    where: { id: positionId },
    data: { isActive: false },
  });
}

export async function hasPosition(citizenId: string, guildId: string, type?: string) {
  const where: Record<string, unknown> = { citizenId, guildId, isActive: true };
  if (type) where.type = type;
  const position = await prisma.position.findFirst({ where });
  return !!position;
}

export async function expirePositions() {
  const now = new Date();
  await prisma.position.updateMany({
    where: {
      isActive: true,
      expiresAt: { lte: now },
    },
    data: { isActive: false },
  });
}
