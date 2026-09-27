import type { Citizen, Guild, Position } from "@prisma/client";
import type { Db, Tx } from "../core/db";
import { DomainError, fail } from "../core/errors";
import type { DomainEvent } from "../core/events";
import {
  AIDES_PER_REPRESENTATIVE,
  byRank,
  incompatibilityReason,
  isPositionKey,
  POSITIONS,
  type PositionKey,
} from "../core/positions";
import { roleTag } from "../core/text";
import { getGuild } from "./guild";

export type PositionWithCitizen = Position & { citizen: Citizen };
export type PositionSource = "ELECTION" | "PARLIAMENT" | "APPOINTMENT" | "SYSTEM";

export async function activePositions(
  db: Db,
  guildId: string,
  filter: { keys?: PositionKey[]; citizenId?: string } = {},
): Promise<PositionWithCitizen[]> {
  const positions = await db.position.findMany({
    where: {
      guildId,
      endedAt: null,
      ...(filter.keys ? { key: { in: filter.keys } } : {}),
      ...(filter.citizenId ? { citizenId: filter.citizenId } : {}),
    },
    include: { citizen: true },
    orderBy: { startedAt: "asc" },
  });
  return positions.sort(byRank);
}

export async function holderOf(db: Db, guildId: string, key: PositionKey): Promise<PositionWithCitizen | null> {
  return db.position.findFirst({ where: { guildId, key, endedAt: null }, include: { citizen: true } });
}

export async function holds(db: Db, guildId: string, citizenId: string, keys: PositionKey | PositionKey[]): Promise<boolean> {
  const list = Array.isArray(keys) ? keys : [keys];
  const count = await db.position.count({ where: { guildId, citizenId, endedAt: null, key: { in: list } } });
  return count > 0;
}

export async function seatedRepresentativeIds(db: Db, guildId: string): Promise<Set<string>> {
  const reps = await db.position.findMany({ where: { guildId, key: "REPRESENTATIVE", endedAt: null }, select: { citizenId: true } });
  return new Set(reps.map((r) => r.citizenId));
}

/** Throws a DomainError explaining why `citizen` may not take `key`. */
export async function checkEligibility(
  db: Db,
  guild: Guild,
  citizen: Citizen,
  key: PositionKey,
  options: { ignoreKeys?: PositionKey[]; targetIsDiscordAdmin?: boolean } = {},
): Promise<void> {
  const current = await db.position.findMany({ where: { citizenId: citizen.id, endedAt: null } });
  for (const position of current) {
    if (!isPositionKey(position.key) || options.ignoreKeys?.includes(position.key)) continue;
    const reason = incompatibilityReason(position.key, key);
    if (reason) {
      fail(`${citizen.displayName} さんは「${position.title}」在任中のため「${POSITIONS[key].label}」に就けません（${reason}）。`);
    }
  }
  if (guild.allowAdminParticipation) return;
  const faction = POSITIONS[key].faction;
  if (faction === "REPRESENTATIVE") {
    if (options.targetIsDiscordAdmin) {
      fail(`管理者派閥（Discord管理者）の ${citizen.displayName} さんは国民代表派閥の役職に就けません（/admin settings の admin_participation で許可できます）。`);
    }
    if (current.some((p) => p.key === "ADMINISTRATOR")) {
      fail(`管理官の ${citizen.displayName} さんは国民代表派閥の役職に就けません。`);
    }
  }
  if (key === "ADMINISTRATOR" && current.some((p) => isPositionKey(p.key) && POSITIONS[p.key].faction === "REPRESENTATIVE")) {
    fail(`${citizen.displayName} さんは国民代表派閥の役職に就いているため管理官に就けません。`);
  }
}

export async function isEligible(db: Db, guild: Guild, citizen: Citizen, key: PositionKey, ignoreKeys: PositionKey[] = []): Promise<boolean> {
  try {
    await checkEligibility(db, guild, citizen, key, { ignoreKeys });
    return true;
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
}

export interface AppointInput {
  guildId: string;
  citizenId: string;
  key: PositionKey;
  title?: string;
  source: PositionSource;
  appointedById?: string | null;
  expiresAt?: Date | null;
  now?: Date;
  /** Discord admin status of the appointee when known (faction separation rule). */
  targetIsDiscordAdmin?: boolean;
}

export async function appoint(tx: Tx, events: DomainEvent[], input: AppointInput): Promise<Position> {
  const def = POSITIONS[input.key];
  const guild = await getGuild(tx, input.guildId);
  const citizen = await tx.citizen.findUnique({ where: { id: input.citizenId } });
  if (!citizen || !citizen.active || citizen.guildId !== input.guildId) fail("対象者は市民登録されていません。");

  await checkEligibility(tx, guild, citizen, input.key, { targetIsDiscordAdmin: input.targetIsDiscordAdmin });

  if (typeof def.capacity === "number") {
    const count = await tx.position.count({ where: { guildId: input.guildId, key: input.key, endedAt: null } });
    if (count >= def.capacity) {
      fail(def.capacity === 1 ? `「${def.label}」にはすでに在任者がいます。` : `「${def.label}」は定員（${def.capacity}名）に達しています。`);
    }
  } else if (def.capacity === "PER_REP") {
    if (!input.appointedById) throw new Error("AIDE appointments require appointedById");
    const count = await tx.position.count({
      where: { guildId: input.guildId, key: input.key, endedAt: null, appointedById: input.appointedById },
    });
    if (count >= AIDES_PER_REPRESENTATIVE) fail(`補佐官は議員1人につき${AIDES_PER_REPRESENTATIVE}名までです。`);
  }

  const title = input.title ?? def.label;
  if (input.key === "MINISTER") {
    const taken = await tx.position.findFirst({ where: { guildId: input.guildId, key: "MINISTER", title, endedAt: null } });
    if (taken) fail(`「${title}」にはすでに在任者がいます。`);
  }

  const position = await tx.position.create({
    data: {
      guildId: input.guildId,
      citizenId: citizen.id,
      key: input.key,
      title,
      source: input.source,
      appointedById: input.appointedById ?? null,
      expiresAt: input.expiresAt ?? null,
      startedAt: input.now ?? new Date(),
    },
  });
  events.push({ type: "rolesChanged", guildId: input.guildId, discordIds: [citizen.discordId] });
  return position;
}

/**
 * Ends a term of office and everything that depends on it:
 * a representative's seat carries the Speaker/Vice Speaker posts and their aides,
 * and the Prime Minister's office carries the whole cabinet (内閣総辞職).
 */
export async function endPosition(
  tx: Tx,
  events: DomainEvent[],
  positionId: string,
  reason: string,
  now: Date = new Date(),
  visited: Set<string> = new Set(),
): Promise<PositionWithCitizen[]> {
  if (visited.has(positionId)) return [];
  visited.add(positionId);
  const position = await tx.position.findUnique({ where: { id: positionId }, include: { citizen: true } });
  if (!position || position.endedAt) return [];

  await tx.position.update({ where: { id: positionId }, data: { endedAt: now, endReason: reason } });
  events.push({ type: "rolesChanged", guildId: position.guildId, discordIds: [position.citizen.discordId] });
  const ended: PositionWithCitizen[] = [{ ...position, endedAt: now, endReason: reason }];

  if (position.key === "REPRESENTATIVE") {
    const dependents = await tx.position.findMany({
      where: {
        guildId: position.guildId,
        endedAt: null,
        OR: [
          { citizenId: position.citizenId, key: { in: ["SPEAKER", "VICE_SPEAKER"] } },
          { key: "AIDE", appointedById: position.citizenId },
        ],
      },
    });
    for (const dependent of dependents) {
      const why = dependent.key === "AIDE" ? "任命した議員の失職に伴う退任" : "議員の失職に伴う退任";
      ended.push(...(await endPosition(tx, events, dependent.id, why, now, visited)));
    }
    await tx.officeVote.deleteMany({
      where: { guildId: position.guildId, OR: [{ voterId: position.citizenId }, { candidateId: position.citizenId }] },
    });
  }

  if (position.key === "PRIME_MINISTER") {
    const cabinet = await tx.position.findMany({
      where: { guildId: position.guildId, endedAt: null, key: { in: ["DEPUTY_PRIME_MINISTER", "CHIEF_CABINET_SECRETARY", "MINISTER"] } },
    });
    for (const member of cabinet) {
      ended.push(...(await endPosition(tx, events, member.id, "内閣総辞職", now, visited)));
    }
  }
  return ended;
}

export async function endAllPositions(
  tx: Tx,
  events: DomainEvent[],
  guildId: string,
  citizenId: string,
  reason: string,
  now: Date = new Date(),
  include: (key: string) => boolean = () => true,
): Promise<PositionWithCitizen[]> {
  const positions = await tx.position.findMany({ where: { guildId, citizenId, endedAt: null } });
  const visited = new Set<string>();
  const ended: PositionWithCitizen[] = [];
  for (const position of positions) {
    if (!include(position.key)) continue;
    ended.push(...(await endPosition(tx, events, position.id, reason, now, visited)));
  }
  return ended;
}

export function describeEnded(ended: PositionWithCitizen[]): string {
  return ended.map((p) => `・${p.citizen.displayName} ${roleTag(p.title)}: ${p.endReason ?? "退任"}`).join("\n");
}
