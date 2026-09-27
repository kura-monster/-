import { prisma } from "../lib/prisma";
import { OPEN_BILL_STATUSES } from "../core/constants";
import { getGuild } from "./guild";
import { activePositions } from "./positions";

export async function governmentOverview(guildId: string) {
  const guild = await getGuild(prisma, guildId);
  const [positions, citizens, openBills, openCases] = await Promise.all([
    activePositions(prisma, guildId),
    prisma.citizen.count({ where: { guildId, active: true } }),
    prisma.bill.count({ where: { guildId, status: { in: OPEN_BILL_STATUSES } } }),
    prisma.courtCase.count({ where: { guildId, status: { in: ["FILED", "IN_TRIAL", "VERDICT", "APPEALED"] } } }),
  ]);
  return { guild, positions, citizens, openBills, openCases };
}
