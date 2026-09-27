import type { Citizen, Guild } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { nextNumber, transact, type Db, type Tx } from "../core/db";
import { fail } from "../core/errors";
import type { DomainEvent } from "../core/events";
import { roleTag } from "../core/text";
import { DAY } from "../core/time";
import { effectivePenalty } from "./court-rules";
import { publish } from "./gazette";
import { getGuild } from "./guild";
import { describeEnded, endAllPositions, endPosition } from "./positions";
import type { Actor, Identity } from "./types";

export async function findCitizen(db: Db, guildId: string, discordId: string): Promise<Citizen | null> {
  return db.citizen.findUnique({ where: { guildId_discordId: { guildId, discordId } } });
}

export async function requireCitizen(db: Db, guildId: string, discordId: string): Promise<Citizen> {
  const citizen = await findCitizen(db, guildId, discordId);
  if (!citizen || !citizen.active) fail("市民登録が必要です。`/citizen register` で登録してください。");
  return citizen;
}

export async function requireTargetCitizen(db: Db, guildId: string, discordId: string, role = "対象者"): Promise<Citizen> {
  const citizen = await findCitizen(db, guildId, discordId);
  if (!citizen || !citizen.active) fail(`${role}（<@${discordId}>）は市民登録されていません。`);
  return citizen;
}

export interface RegistrationInput extends Identity {
  accountCreatedAt: Date;
  joinedAt: Date | null;
}

export type RegistrationProblem =
  | { code: "REVOKED"; reason: string | null }
  | { code: "REGISTERED"; number: number }
  | { code: "ACCOUNT_AGE"; days: number }
  | { code: "MEMBERSHIP"; days: number };

/**
 * Why this person may not register. The account-age and membership requirements (against sub-accounts) can be
 * waived by an admin; a revocation cannot.
 */
export function registrationProblem(
  guild: Guild,
  existing: Citizen | null,
  input: RegistrationInput,
  now: Date,
  waiveRequirements = false,
): RegistrationProblem | null {
  if (existing?.revokedAt) return { code: "REVOKED", reason: existing.revokedReason };
  if (existing?.active) return { code: "REGISTERED", number: existing.number };
  if (waiveRequirements) return null;
  const accountAgeDays = (now.getTime() - input.accountCreatedAt.getTime()) / DAY;
  if (accountAgeDays < guild.minAccountAgeDays) return { code: "ACCOUNT_AGE", days: guild.minAccountAgeDays };
  if (guild.minMembershipDays > 0) {
    const memberDays = input.joinedAt ? (now.getTime() - input.joinedAt.getTime()) / DAY : 0;
    if (memberDays < guild.minMembershipDays) return { code: "MEMBERSHIP", days: guild.minMembershipDays };
  }
  return null;
}

export async function registerCitizen(guildId: string, input: RegistrationInput, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const guild = await getGuild(tx, guildId);
    const existing = await findCitizen(tx, guildId, input.discordId);
    const problem = registrationProblem(guild, existing, input, now);
    switch (problem?.code) {
      case "REVOKED":
        fail(`市民権が停止されています（理由: ${problem.reason ?? "記載なし"}）。管理者にお問い合わせください。`);
      case "REGISTERED":
        fail(`すでに市民番号 ${problem.number} として登録済みです。`);
      case "ACCOUNT_AGE":
        fail(`市民登録には Discord アカウントの作成から ${problem.days} 日以上が必要です。`);
      case "MEMBERSHIP":
        fail(`市民登録にはサーバーへの参加から ${problem.days} 日以上が必要です。`);
    }
    const citizen = await activateCitizen(tx, events, guildId, input, existing, now);
    return { citizen, reactivated: existing !== null };
  });
}

/** Creates the citizen record, or reactivates one that left, and gives them the {市民} role. */
export async function activateCitizen(tx: Tx, events: DomainEvent[], guildId: string, identity: Identity, existing: Citizen | null, now: Date) {
  const citizen = existing
    ? await tx.citizen.update({
        where: { id: existing.id },
        data: { active: true, displayName: identity.displayName, avatarUrl: identity.avatarUrl, registeredAt: now },
      })
    : await tx.citizen.create({
        data: {
          guildId,
          discordId: identity.discordId,
          number: await nextNumber(tx, guildId, "citizen"),
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
          registeredAt: now,
        },
      });
  events.push({ type: "rolesChanged", guildId, discordIds: [identity.discordId] });
  return citizen;
}

/** Admin appointments may enrol the appointee directly (e.g. the server owner as 元首). */
export async function ensureCitizen(tx: Tx, events: DomainEvent[], guildId: string, identity: Identity, now: Date): Promise<Citizen> {
  const existing = await findCitizen(tx, guildId, identity.discordId);
  if (existing?.revokedAt) fail(`${existing.displayName} さんは市民権が停止されています。`);
  if (existing?.active) return existing;
  return activateCitizen(tx, events, guildId, identity, existing, now);
}

export async function touchCitizen(guildId: string, identity: Identity): Promise<void> {
  const citizen = await findCitizen(prisma, guildId, identity.discordId);
  if (!citizen) return;
  if (citizen.displayName === identity.displayName && citizen.avatarUrl === identity.avatarUrl) return;
  await prisma.citizen.update({
    where: { id: citizen.id },
    data: { displayName: identity.displayName, avatarUrl: identity.avatarUrl },
  });
}

export type Departure = "SELF" | "LEFT_SERVER" | "REVOKED";

const DEPARTURE_REASON: Record<Departure, string> = {
  SELF: "市民登録の抹消",
  LEFT_SERVER: "サーバーからの退去",
  REVOKED: "市民権の停止",
};

/** Ends citizenship: every office, candidacy and parliamentary vote of the citizen lapses. */
export async function removeCitizenship(
  guildId: string,
  target: Identity,
  departure: Departure,
  options: { reason?: string; actorName?: string } = {},
  now: Date = new Date(),
) {
  return transact(async (tx, events) => {
    let citizen = await findCitizen(tx, guildId, target.discordId);
    if (departure === "REVOKED" && citizen?.revokedAt) fail(`${citizen.displayName} さんの市民権はすでに停止されています。`);
    if (!citizen) {
      if (departure !== "REVOKED") return null;
      // Revoking someone who never registered blocks them from registering later.
      citizen = await tx.citizen.create({
        data: {
          guildId,
          discordId: target.discordId,
          number: await nextNumber(tx, guildId, "citizen"),
          displayName: target.displayName,
          avatarUrl: target.avatarUrl,
          active: false,
          registeredAt: now,
        },
      });
    }
    if (!citizen.active && departure !== "REVOKED") return null;

    const why = DEPARTURE_REASON[departure];
    const ended = await endAllPositions(tx, events, guildId, citizen.id, why, now);
    const withdrawn = await tx.candidate.updateMany({
      where: { citizenId: citizen.id, withdrawnAt: null, election: { status: { in: ["REGISTRATION", "VOTING"] } } },
      data: { withdrawnAt: now },
    });
    await tx.officeVote.deleteMany({ where: { guildId, OR: [{ voterId: citizen.id }, { candidateId: citizen.id }] } });
    await tx.citizen.update({
      where: { id: citizen.id },
      data: {
        active: false,
        ...(departure === "REVOKED" ? { revokedAt: now, revokedReason: options.reason ?? null } : {}),
      },
    });
    events.push({ type: "rolesChanged", guildId, discordIds: [target.discordId] });

    if (departure === "REVOKED" || ended.length > 0 || withdrawn.count > 0) {
      const lines = [
        departure === "REVOKED"
          ? `管理者 ${options.actorName ?? ""} が ${citizen.displayName} さんの市民権を停止しました。${options.reason ? `\n理由: ${options.reason}` : ""}`
          : `${citizen.displayName} さんが${why}により市民でなくなりました。`,
        ended.length > 0 ? `失職:\n${describeEnded(ended)}` : null,
        withdrawn.count > 0 ? "進行中の選挙への立候補は取り下げとなりました。" : null,
      ];
      await publish(tx, events, guildId, {
        category: departure === "REVOKED" ? "ADMIN" : "CITIZEN",
        title: departure === "REVOKED" ? `市民権の停止: ${citizen.displayName}` : `市民の離脱: ${citizen.displayName}`,
        body: lines.filter(Boolean).join("\n"),
      });
    }
    return { citizen, ended, withdrawnCandidacies: withdrawn.count };
  });
}

export async function restoreCitizenship(actor: Actor, targetDiscordId: string) {
  if (!actor.isAdmin) fail("市民権の回復は管理者のみ行えます。");
  return transact(async (tx, events) => {
    const citizen = await findCitizen(tx, actor.guildId, targetDiscordId);
    if (!citizen?.revokedAt) fail("この方の市民権は停止されていません。");
    await tx.citizen.update({ where: { id: citizen.id }, data: { revokedAt: null, revokedReason: null } });
    await publish(tx, events, actor.guildId, {
      category: "ADMIN",
      title: `市民権停止の解除: ${citizen.displayName}`,
      body: `管理者 ${actor.displayName} が ${citizen.displayName} さんの市民権停止を解除しました。本人が /citizen register で再登録できます。`,
    });
    return citizen;
  });
}

export async function resignPosition(actor: Actor, positionId: string, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const citizen = await requireCitizen(tx, actor.guildId, actor.discordId);
    const position = await tx.position.findUnique({ where: { id: positionId } });
    if (!position || position.citizenId !== citizen.id || position.endedAt) fail("在任中のあなたの役職ではありません。");
    const [, ...cascaded] = await endPosition(tx, events, position.id, "辞職", now);
    await publish(tx, events, actor.guildId, {
      category: "PERSONNEL",
      title: `辞職: ${citizen.displayName}（${position.title}）`,
      body: [`${citizen.displayName} が ${roleTag(position.title)} を辞職しました。`, cascaded.length > 0 ? describeEnded(cascaded) : null]
        .filter(Boolean)
        .join("\n"),
    });
    return position;
  });
}

export async function citizenProfile(guildId: string, discordId: string) {
  const citizen = await findCitizen(prisma, guildId, discordId);
  if (!citizen) return null;
  const [positions, electedCount, candidacyCount, billsProposed, casesAgainst] = await Promise.all([
    prisma.position.findMany({ where: { citizenId: citizen.id }, orderBy: { startedAt: "desc" } }),
    prisma.candidate.count({ where: { citizenId: citizen.id, elected: true } }),
    prisma.candidate.count({ where: { citizenId: citizen.id, withdrawnAt: null, election: { status: "COMPLETED" } } }),
    prisma.bill.count({ where: { proposerId: citizen.id } }),
    prisma.courtCase.findMany({ where: { defendantId: citizen.id, status: "FINAL" } }),
  ]);
  const sanctions = casesAgainst.filter((c) => {
    const penalty = effectivePenalty(c);
    return penalty !== null && penalty !== "NONE";
  }).length;
  return {
    citizen,
    current: positions.filter((p) => !p.endedAt),
    history: positions.filter((p) => p.endedAt).slice(0, 8),
    electedCount,
    candidacyCount,
    billsProposed,
    sanctions,
  };
}

export async function citizenGuilds(discordId: string) {
  return prisma.citizen.findMany({
    where: { discordId, active: true },
    include: { guild: { select: { id: true, name: true } } },
    orderBy: { registeredAt: "asc" },
  });
}
