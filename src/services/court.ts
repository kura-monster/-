import type { Citizen, CourtCase } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { nextNumber, transact, type Db, type Tx } from "../core/db";
import { fail } from "../core/errors";
import type { DomainEvent } from "../core/events";
import {
  CASE_RESULT_LABEL,
  CASE_STATUS_LABEL,
  PENALTY_LABEL,
  type CaseResult,
  type CaseStatus,
  type Penalty,
  type PenaltyStatus,
} from "../core/constants";
import { JUDICIAL_KEYS } from "../core/positions";
import { addHours, timeToken } from "../core/time";
import { requireCitizen, requireTargetCitizen } from "./citizen";
import { effectivePenalty } from "./court-rules";
import { publish } from "./gazette";
import { getGuild } from "./guild";
import { holderOf, holds } from "./positions";
import type { Actor } from "./types";

const courtLink = (guildId: string) => `/g/${guildId}/court`;

export async function findCase(db: Db, guildId: string, number: number): Promise<CourtCase> {
  const found = await db.courtCase.findUnique({ where: { guildId_number: { guildId, number } } });
  if (!found) fail(`事件 第${number}号は見つかりません。`);
  return found;
}

const isParty = (c: CourtCase, citizenId: string) => c.plaintiffId === citizenId || c.defendantId === citizenId;

function statusLabel(c: CourtCase): string {
  return CASE_STATUS_LABEL[c.status as CaseStatus] ?? c.status;
}

export async function fileCase(actor: Actor, defendantDiscordId: string, title: string, claim: string, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const plaintiff = await requireCitizen(tx, actor.guildId, actor.discordId);
    const defendant = await requireTargetCitizen(tx, actor.guildId, defendantDiscordId, "被告");
    if (plaintiff.id === defendant.id) fail("自分自身を訴えることはできません。");
    const pending = await tx.courtCase.findFirst({
      where: { guildId: actor.guildId, plaintiffId: plaintiff.id, defendantId: defendant.id, status: { in: ["FILED", "IN_TRIAL"] } },
    });
    if (pending) fail(`同じ相手に対する係属中の事件（第${pending.number}号）があります。`);
    const number = await nextNumber(tx, actor.guildId, "case");
    const filed = await tx.courtCase.create({
      data: { guildId: actor.guildId, number, title, claim, plaintiffId: plaintiff.id, defendantId: defendant.id, filedAt: now },
    });
    events.push({ type: "caseFiled", guildId: actor.guildId, caseId: filed.id });
    await publish(tx, events, actor.guildId, {
      category: "JUDICIARY",
      title: `事件 第${number}号「${title}」受理`,
      body: `原告: ${plaintiff.displayName}\n被告: ${defendant.displayName}\n最高裁判所長官による配点、または裁判官の担当を待っています。`,
      linkPath: courtLink(actor.guildId),
    });
    return filed;
  });
}

export async function respondToCase(actor: Actor, number: number, statement: string) {
  return transact(async (tx, events) => {
    const citizen = await requireCitizen(tx, actor.guildId, actor.discordId);
    const found = await findCase(tx, actor.guildId, number);
    if (found.defendantId !== citizen.id) fail("答弁書を提出できるのは被告のみです。");
    if (found.status !== "FILED" && found.status !== "IN_TRIAL") fail("判決前の事件にのみ答弁できます。");
    const updated = await tx.courtCase.update({ where: { id: found.id }, data: { defense: statement } });
    events.push({
      type: "threadNotice",
      guildId: actor.guildId,
      threadId: found.threadId,
      title: `被告 ${citizen.displayName} の答弁書`,
      body: statement,
    });
    return updated;
  });
}

async function requireJudicialOfficer(db: Db, guildId: string, citizen: Citizen, message: string): Promise<void> {
  if (!(await holds(db, guildId, citizen.id, JUDICIAL_KEYS))) fail(message);
}

async function assign(tx: Tx, events: DomainEvent[], found: CourtCase, judge: Citizen, assignedBy: string) {
  if (isParty(found, judge.id)) fail("当事者は自分の事件を担当できません（利益相反）。");
  const updated = await tx.courtCase.update({ where: { id: found.id }, data: { judgeId: judge.id, status: "IN_TRIAL" } });
  await publish(tx, events, found.guildId, {
    category: "JUDICIARY",
    title: `事件 第${found.number}号 担当裁判官決定`,
    body: `${assignedBy}により ${judge.displayName} が担当裁判官となりました。審理を開始します。`,
    threadId: found.threadId,
    linkPath: courtLink(found.guildId),
  });
  return updated;
}

export async function assignJudge(actor: Actor, number: number, judgeDiscordId: string) {
  return transact(async (tx, events) => {
    const chief = await requireCitizen(tx, actor.guildId, actor.discordId);
    if (!(await holds(tx, actor.guildId, chief.id, "CHIEF_JUSTICE"))) fail("配点は最高裁判所長官のみ行えます。");
    const found = await findCase(tx, actor.guildId, number);
    if (found.status !== "FILED" && found.status !== "IN_TRIAL") fail(`この事件は配点できる状態ではありません（${statusLabel(found)}）。`);
    const judge = await requireTargetCitizen(tx, actor.guildId, judgeDiscordId, "裁判官");
    await requireJudicialOfficer(tx, actor.guildId, judge, `${judge.displayName} さんは裁判官ではありません。`);
    return assign(tx, events, found, judge, `最高裁判所長官 ${chief.displayName} の配点`);
  });
}

export async function takeCase(actor: Actor, number: number) {
  return transact(async (tx, events) => {
    const judge = await requireCitizen(tx, actor.guildId, actor.discordId);
    await requireJudicialOfficer(tx, actor.guildId, judge, "事件を担当できるのは裁判官のみです。");
    const found = await findCase(tx, actor.guildId, number);
    const assignedJudgeGone =
      found.status === "IN_TRIAL" && found.judgeId !== null && !(await holds(tx, actor.guildId, found.judgeId, JUDICIAL_KEYS));
    if (found.status !== "FILED" && !assignedJudgeGone) fail("この事件にはすでに担当裁判官がいます。");
    return assign(tx, events, found, judge, "自らの申し出");
  });
}

function validateRuling(result: CaseResult, penalty: Penalty): void {
  if (penalty !== "NONE" && result !== "PLAINTIFF_WINS") fail("制裁（警告・タイムアウト）を科せるのは原告勝訴の場合のみです。");
}

export interface RulingInput {
  result: CaseResult;
  ruling: string;
  penalty: Penalty;
}

export async function issueVerdict(actor: Actor, number: number, input: RulingInput, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const judge = await requireCitizen(tx, actor.guildId, actor.discordId);
    const found = await findCase(tx, actor.guildId, number);
    if (found.status !== "IN_TRIAL") fail(`審理中の事件ではありません（${statusLabel(found)}）。`);
    if (found.judgeId !== judge.id) fail("この事件の担当裁判官ではありません。");
    await requireJudicialOfficer(tx, actor.guildId, judge, "裁判官の職にないため判決を言い渡せません。");
    validateRuling(input.result, input.penalty);
    const guild = await getGuild(tx, actor.guildId);
    const appealDeadline = addHours(now, guild.appealHours);
    const updated = await tx.courtCase.update({
      where: { id: found.id },
      data: { status: "VERDICT", result: input.result, ruling: input.ruling, penalty: input.penalty, decidedAt: now, appealDeadline },
    });
    await publish(tx, events, actor.guildId, {
      category: "JUDICIARY",
      title: `事件 第${number}号 判決`,
      body: [
        `「${found.title}」`,
        `主文: ${CASE_RESULT_LABEL[input.result]}（制裁: ${PENALTY_LABEL[input.penalty]}）`,
        input.ruling,
        `担当裁判官: ${judge.displayName}`,
        `当事者は ${timeToken(appealDeadline)} まで /court appeal で上告できます。上告がなければ判決は確定します。`,
      ].join("\n"),
      threadId: found.threadId,
      linkPath: courtLink(actor.guildId),
    });
    return updated;
  });
}

export async function appealCase(actor: Actor, number: number, reason: string, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const citizen = await requireCitizen(tx, actor.guildId, actor.discordId);
    const found = await findCase(tx, actor.guildId, number);
    if (!isParty(found, citizen.id)) fail("上告できるのは当事者（原告・被告）のみです。");
    if (found.status !== "VERDICT" || !found.appealDeadline || now >= found.appealDeadline) fail("上告期間は終了しているか、上告できる状態ではありません。");
    const updated = await tx.courtCase.update({
      where: { id: found.id },
      data: { status: "APPEALED", appellantId: citizen.id, appealReason: reason },
    });
    await publish(tx, events, actor.guildId, {
      category: "JUDICIARY",
      title: `事件 第${number}号 上告`,
      body: `${citizen.displayName} が上告しました。\n理由: ${reason}\n最高裁判所長官（不在時は原審以外の裁判官）が上告審の判決を言い渡します。`,
      threadId: found.threadId,
      linkPath: courtLink(actor.guildId),
    });
    return updated;
  });
}

async function finalize(tx: Tx, events: DomainEvent[], found: CourtCase, now: Date): Promise<CourtCase> {
  const guild = await getGuild(tx, found.guildId);
  const penalty = effectivePenalty(found) as Penalty | null;
  let penaltyStatus: PenaltyStatus | null = null;
  let penaltyNote: string | null = null;
  if (penalty === "WARNING") {
    penaltyStatus = "EXECUTED";
    penaltyNote = "警告を記録しました";
  } else if (penalty && penalty !== "NONE") {
    if (guild.enforcePenalties) {
      penaltyStatus = "PENDING";
    } else {
      penaltyStatus = "SKIPPED";
      penaltyNote = "判決の自動執行が無効に設定されています";
    }
  }
  const updated = await tx.courtCase.update({
    where: { id: found.id },
    data: { status: "FINAL", finalizedAt: now, penaltyStatus, penaltyNote },
  });
  if (penaltyStatus === "PENDING") events.push({ type: "penaltyDue", guildId: found.guildId, caseId: found.id });
  return updated;
}

export async function issueFinalRuling(actor: Actor, number: number, input: RulingInput, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const citizen = await requireCitizen(tx, actor.guildId, actor.discordId);
    const found = await findCase(tx, actor.guildId, number);
    if (found.status !== "APPEALED") fail("上告審が係属している事件ではありません。");
    const chief = await holderOf(tx, actor.guildId, "CHIEF_JUSTICE");
    const chiefCanHear = chief !== null && chief.citizenId !== found.judgeId && !isParty(found, chief.citizenId);
    if (chiefCanHear) {
      if (chief.citizenId !== citizen.id) fail("上告審の判決は最高裁判所長官が言い渡します。");
    } else {
      const isJudge = await holds(tx, actor.guildId, citizen.id, JUDICIAL_KEYS);
      if (!isJudge || citizen.id === found.judgeId || isParty(found, citizen.id)) {
        fail("最高裁判所長官が不在または関係者のため、上告審は原審を担当していない裁判官が担当します。");
      }
    }
    validateRuling(input.result, input.penalty);
    const ruled = await tx.courtCase.update({
      where: { id: found.id },
      data: { appealJudgeId: citizen.id, appealResult: input.result, appealRuling: input.ruling, appealPenalty: input.penalty },
    });
    const updated = await finalize(tx, events, ruled, now);
    await publish(tx, events, actor.guildId, {
      category: "JUDICIARY",
      title: `事件 第${number}号 上告審判決（確定）`,
      body: [
        `「${found.title}」`,
        `主文: ${CASE_RESULT_LABEL[input.result]}（制裁: ${PENALTY_LABEL[input.penalty]}）`,
        input.ruling,
        `上告審担当: ${citizen.displayName}`,
        "本判決により事件は確定しました。",
      ].join("\n"),
      threadId: found.threadId,
      linkPath: courtLink(actor.guildId),
    });
    return updated;
  });
}

export async function withdrawCase(actor: Actor, number: number) {
  return transact(async (tx, events) => {
    const citizen = await requireCitizen(tx, actor.guildId, actor.discordId);
    const found = await findCase(tx, actor.guildId, number);
    if (found.plaintiffId !== citizen.id) fail("訴えを取り下げられるのは原告のみです。");
    if (found.status !== "FILED" && found.status !== "IN_TRIAL") fail("判決後は取り下げできません。");
    const updated = await tx.courtCase.update({ where: { id: found.id }, data: { status: "WITHDRAWN", finalizedAt: new Date() } });
    await publish(tx, events, actor.guildId, {
      category: "JUDICIARY",
      title: `事件 第${number}号 取下げ`,
      body: `原告 ${citizen.displayName} が訴えを取り下げました。`,
      threadId: found.threadId,
      linkPath: courtLink(actor.guildId),
    });
    return updated;
  });
}

/** Scheduler: verdicts whose appeal window closed without an appeal become final. */
export async function finalizeUnappealedVerdict(caseId: string, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const found = await tx.courtCase.findUnique({ where: { id: caseId } });
    if (!found || found.status !== "VERDICT" || !found.appealDeadline || found.appealDeadline > now) return null;
    const updated = await finalize(tx, events, found, now);
    await publish(tx, events, found.guildId, {
      category: "JUDICIARY",
      title: `事件 第${found.number}号 判決確定`,
      body: `上告期間内に上告がなかったため、「${found.title}」の判決（${CASE_RESULT_LABEL[found.result as CaseResult]}）が確定しました。`,
      threadId: found.threadId,
      linkPath: courtLink(found.guildId),
    });
    return updated;
  });
}

/** Called by the Discord adapter after trying to carry out a timeout. */
export async function recordPenaltyOutcome(caseId: string, status: PenaltyStatus, note: string) {
  return transact(async (tx, events) => {
    const found = await tx.courtCase.findUnique({ where: { id: caseId }, include: { defendant: true } });
    if (!found || found.penaltyStatus !== "PENDING") return null;
    const updated = await tx.courtCase.update({ where: { id: caseId }, data: { penaltyStatus: status, penaltyNote: note } });
    await publish(tx, events, found.guildId, {
      category: "JUDICIARY",
      title: `事件 第${found.number}号 判決の執行${status === "EXECUTED" ? "" : "（不能）"}`,
      body: `${found.defendant.displayName} に対する制裁（${PENALTY_LABEL[effectivePenalty(found) as Penalty]}）: ${note}`,
      threadId: found.threadId,
      linkPath: courtLink(found.guildId),
    });
    return updated;
  });
}

export type CaseFilter = "open" | "closed" | "all";

export async function listCases(guildId: string, filter: CaseFilter = "open", take = 20) {
  const status =
    filter === "open"
      ? { in: ["FILED", "IN_TRIAL", "VERDICT", "APPEALED"] }
      : filter === "closed"
        ? { in: ["FINAL", "WITHDRAWN"] }
        : undefined;
  return prisma.courtCase.findMany({
    where: { guildId, ...(status ? { status } : {}) },
    include: { plaintiff: true, defendant: true, judge: true, appealJudge: true },
    orderBy: { number: "desc" },
    take,
  });
}

export async function caseDetail(guildId: string, number: number) {
  return prisma.courtCase.findUnique({
    where: { guildId_number: { guildId, number } },
    include: { plaintiff: true, defendant: true, judge: true, appellant: true, appealJudge: true },
  });
}
