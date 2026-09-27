import type { Citizen } from "@prisma/client";
import { transact } from "../core/db";
import { roleTag } from "../core/text";
import { fail } from "../core/errors";
import type { GazetteCategory } from "../core/constants";
import { POSITIONS, type PositionKey } from "../core/positions";
import {
  activateCitizen,
  ensureCitizen,
  findCitizen,
  registrationProblem,
  removeCitizenship,
  requireTargetCitizen,
  type RegistrationInput,
  type RegistrationProblem,
} from "./citizen";
import { createElection } from "./election";
import { publish } from "./gazette";
import { getGuild } from "./guild";
import { findBill, lapsePendingBills } from "./parliament";
import { appoint, describeEnded, endPosition, holderOf } from "./positions";
import type { Actor, Identity } from "./types";

export const ADMIN_APPOINTABLE = [
  "SOVEREIGN",
  "ADMINISTRATOR",
  "CHIEF_JUSTICE",
  "ELECTION_COMMISSIONER",
  "ELECTION_COMMISSION_MEMBER",
] as const;
export type AdminAppointable = (typeof ADMIN_APPOINTABLE)[number];

function assertAdmin(actor: Actor): void {
  if (!actor.isAdmin) fail("この操作は管理者専用です。");
}

export interface BulkRegistration {
  registered: Citizen[];
  alreadyRegistered: number;
  skipped: { displayName: string; reason: string; waivable: boolean }[];
}

function skipReason(problem: Exclude<RegistrationProblem, { code: "REGISTERED" }>): string {
  switch (problem.code) {
    case "REVOKED":
      return "市民権停止中";
    case "ACCOUNT_AGE":
      return `アカウント作成から${problem.days}日未満`;
    case "MEMBERSHIP":
      return `サーバー参加から${problem.days}日未満`;
  }
}

/**
 * Registers everyone holding a Discord role (the caller passes the members). The usual requirements apply unless
 * waived, revoked citizens stay revoked, and the gazette gets one entry instead of one per person.
 */
export async function registerRoleMembers(
  actor: Actor,
  roleName: string,
  members: RegistrationInput[],
  options: { waiveRequirements?: boolean } = {},
  now: Date = new Date(),
): Promise<BulkRegistration> {
  assertAdmin(actor);
  return transact(async (tx, events) => {
    const guild = await getGuild(tx, actor.guildId);
    const result: BulkRegistration = { registered: [], alreadyRegistered: 0, skipped: [] };
    for (const member of members) {
      const existing = await findCitizen(tx, actor.guildId, member.discordId);
      const problem = registrationProblem(guild, existing, member, now, options.waiveRequirements);
      if (problem?.code === "REGISTERED") {
        result.alreadyRegistered++;
      } else if (problem) {
        result.skipped.push({ displayName: member.displayName, reason: skipReason(problem), waivable: problem.code !== "REVOKED" });
      } else {
        result.registered.push(await activateCitizen(tx, events, actor.guildId, member, existing, now));
      }
    }
    if (result.registered.length > 0) {
      const LISTED = 50;
      const names = result.registered.slice(0, LISTED).map((c) => `市民番号 ${c.number}　${c.displayName}`);
      const rest = result.registered.length - names.length;
      await publish(tx, events, actor.guildId, {
        category: "ADMIN",
        title: `市民の一括登録（${result.registered.length}名）`,
        body: [
          `管理者 ${actor.displayName} が、ロール「${roleName}」を持つメンバーを市民登録しました${options.waiveRequirements ? "（アカウント年齢・在籍期間の条件を適用せず）" : ""}。`,
          ...names,
          rest > 0 ? `ほか${rest}名` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      });
    }
    return result;
  });
}

const APPOINTMENT_CATEGORY: Record<AdminAppointable, GazetteCategory> = {
  SOVEREIGN: "ADMIN",
  ADMINISTRATOR: "ADMIN",
  CHIEF_JUSTICE: "JUDICIARY",
  ELECTION_COMMISSIONER: "ELECTION",
  ELECTION_COMMISSION_MEMBER: "ELECTION",
};

export async function adminAppoint(
  actor: Actor,
  key: AdminAppointable,
  target: Identity & { isDiscordAdmin: boolean },
  now: Date = new Date(),
) {
  assertAdmin(actor);
  if (!ADMIN_APPOINTABLE.includes(key)) fail("管理者が任命できる役職ではありません。");
  return transact(async (tx, events) => {
    const appointer = await findCitizen(tx, actor.guildId, actor.discordId);
    const citizen = await ensureCitizen(tx, events, actor.guildId, target, now);
    const position = await appoint(tx, events, {
      guildId: actor.guildId,
      citizenId: citizen.id,
      key,
      source: "APPOINTMENT",
      appointedById: appointer?.active ? appointer.id : null,
      targetIsDiscordAdmin: target.isDiscordAdmin,
      now,
    });
    await publish(tx, events, actor.guildId, {
      category: APPOINTMENT_CATEGORY[key],
      title: `${POSITIONS[key].label}の任命: ${citizen.displayName}`,
      body: `管理者 ${actor.displayName} が ${citizen.displayName} を ${roleTag(POSITIONS[key].label)} に任命しました。`,
      linkPath: `/g/${actor.guildId}`,
    });
    return position;
  });
}

/** Emergency removal from any office. Always recorded in the gazette so the admin faction stays accountable. */
export async function adminDismiss(actor: Actor, targetDiscordId: string, key: PositionKey, reason: string, now: Date = new Date()) {
  assertAdmin(actor);
  return transact(async (tx, events) => {
    const citizen = await requireTargetCitizen(tx, actor.guildId, targetDiscordId);
    const position = await tx.position.findFirst({ where: { guildId: actor.guildId, citizenId: citizen.id, key, endedAt: null } });
    if (!position) fail(`${citizen.displayName} さんは${POSITIONS[key].label}に在任していません。`);
    const ended = await endPosition(tx, events, position.id, `管理者による罷免（${reason}）`, now);
    await publish(tx, events, actor.guildId, {
      category: "ADMIN",
      title: `管理者権限による罷免: ${citizen.displayName}`,
      body: `管理者 ${actor.displayName} が ${citizen.displayName} を ${roleTag(position.title)} から罷免しました。\n理由: ${reason}\n${describeEnded(ended)}`,
    });
    return ended;
  });
}

export async function sanctionBill(actor: Actor, number: number, now: Date = new Date()) {
  assertAdmin(actor);
  return transact(async (tx, events) => {
    const bill = await findBill(tx, actor.guildId, number);
    if (bill.status !== "PASSED" || bill.kind !== "ORDINARY") fail("裁可できるのは可決済みで裁可待ちの法律案のみです。");
    const updated = await tx.bill.update({ where: { id: bill.id }, data: { status: "ENACTED", decidedAt: now, outcomeNote: "裁可により成立" } });
    await publish(tx, events, actor.guildId, {
      category: "LEGISLATION",
      title: `第${number}号「${bill.title}」成立`,
      body: `管理者 ${actor.displayName} が裁可し、法律として成立しました。内閣は /cabinet implement で施行を記録できます。`,
      threadId: bill.threadId,
      linkPath: `/g/${actor.guildId}/parliament`,
    });
    return updated;
  });
}

export async function vetoBill(actor: Actor, number: number, reason: string, now: Date = new Date()) {
  assertAdmin(actor);
  return transact(async (tx, events) => {
    const bill = await findBill(tx, actor.guildId, number);
    if (bill.status !== "PASSED" || bill.kind !== "ORDINARY") fail("拒否権を行使できるのは可決済みで裁可待ちの法律案のみです。");
    if (bill.round !== 1) fail("再議決で成立した法律案には拒否権を行使できません。");
    const updated = await tx.bill.update({ where: { id: bill.id }, data: { status: "VETOED", decidedAt: now, vetoReason: reason } });
    await publish(tx, events, actor.guildId, {
      category: "LEGISLATION",
      title: `第${number}号「${bill.title}」拒否権行使`,
      body: `管理者 ${actor.displayName} が拒否権を行使しました。\n理由: ${reason}\n国会は /parliament bill override で再議決（出席議員の3分の2以上）を発議できます。`,
      threadId: bill.threadId,
      linkPath: `/g/${actor.guildId}/parliament`,
    });
    return updated;
  });
}

/** Scheduler: a passed bill the admin faction neither sanctioned nor vetoed in time becomes law. */
export async function enactAfterSanctionDeadline(billId: string, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const bill = await tx.bill.findUnique({ where: { id: billId } });
    if (!bill || bill.status !== "PASSED" || bill.kind !== "ORDINARY" || !bill.sanctionDeadline || bill.sanctionDeadline > now) return null;
    const updated = await tx.bill.update({
      where: { id: bill.id },
      data: { status: "ENACTED", decidedAt: now, outcomeNote: "裁可期限の経過により自動成立" },
    });
    await publish(tx, events, bill.guildId, {
      category: "LEGISLATION",
      title: `第${bill.number}号「${bill.title}」成立（裁可期限経過）`,
      body: "管理者派閥が期限内に裁可・拒否権のいずれも行使しなかったため、法律として成立しました。",
      threadId: bill.threadId,
      linkPath: `/g/${bill.guildId}/parliament`,
    });
    return updated;
  });
}

/**
 * 解散: every seat ends at once and a general election is called immediately.
 * The cabinet stays on as a caretaker until the new parliament convenes (it resigns when the election is decided).
 */
export async function dissolveParliament(actor: Actor, reason: string, now: Date = new Date()) {
  assertAdmin(actor);
  return transact(async (tx, events) => {
    const running = await tx.election.findFirst({ where: { guildId: actor.guildId, status: { in: ["REGISTRATION", "VOTING"] } } });
    if (running) fail(`選挙（${running.title}）が進行中のため解散できません。`);
    const seats = await tx.position.findMany({ where: { guildId: actor.guildId, key: "REPRESENTATIVE", endedAt: null } });
    if (seats.length === 0) fail("在任中の議員がいないため解散できません。");
    const visited = new Set<string>();
    const ended = [];
    for (const seat of seats) ended.push(...(await endPosition(tx, events, seat.id, "議会の解散", now, visited)));
    await tx.officeVote.deleteMany({ where: { guildId: actor.guildId } });
    const pm = await holderOf(tx, actor.guildId, "PRIME_MINISTER");
    await publish(tx, events, actor.guildId, {
      category: "ADMIN",
      title: "議会の解散",
      body: [
        `管理者 ${actor.displayName} が議会を解散しました。`,
        `理由: ${reason}`,
        `失職: ${ended.length}名`,
        pm ? `${pm.citizen.displayName}内閣は新しい国会が構成されるまで職務を継続します。` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    });
    await lapsePendingBills(tx, events, actor.guildId, "議会の解散により", now);
    return createElection(tx, events, actor.guildId, { kind: "GENERAL", description: "議会解散に伴う総選挙" }, now, `管理者 ${actor.displayName}`);
  });
}

export async function revokeCitizenship(actor: Actor, target: Identity, reason: string) {
  assertAdmin(actor);
  const result = await removeCitizenship(actor.guildId, target, "REVOKED", { reason, actorName: actor.displayName });
  if (!result) fail("市民権を停止できませんでした。");
  return result;
}
