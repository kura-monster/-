import type { Bill, Citizen } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { nextNumber, transact, type Db, type Tx } from "../core/db";
import { fail } from "../core/errors";
import type { DomainEvent } from "../core/events";
import {
  BILL_KIND_LABEL,
  billStatusLabel,
  MAJORITY_LABEL,
  OFFICE_LABEL,
  OPEN_BILL_STATUSES,
  type BillKind,
  type BillOrigin,
  type Majority,
  type Office,
  type VoteChoice,
} from "../core/constants";
import { ADMIN_FACTION_KEYS, CABINET_KEYS, type PositionKey } from "../core/positions";
import { describeTally, officeMajority, tallyVotes, type BillTally } from "../core/tally";
import { roleTag } from "../core/text";
import { addDays, timeToken } from "../core/time";
import { requireCitizen, requireTargetCitizen } from "./citizen";
import { publish } from "./gazette";
import { getGuild } from "./guild";
import {
  activePositions,
  appoint,
  checkEligibility,
  describeEnded,
  endAllPositions,
  endPosition,
  holderOf,
  holds,
  isEligible,
  seatedRepresentativeIds,
} from "./positions";
import type { Actor } from "./types";

const parliamentLink = (guildId: string) => `/g/${guildId}/parliament`;

async function requireRepresentative(db: Db, actor: Actor): Promise<Citizen> {
  const citizen = await requireCitizen(db, actor.guildId, actor.discordId);
  if (!(await holds(db, actor.guildId, citizen.id, "REPRESENTATIVE"))) fail("このコマンドは国民代表（議員）のみ使用できます。");
  return citizen;
}

export async function findBill(db: Db, guildId: string, number: number): Promise<Bill> {
  const bill = await db.bill.findUnique({ where: { guildId_number: { guildId, number } } });
  if (!bill) fail(`第${number}号議案は見つかりません。`);
  return bill;
}

// ───────────── 院内選挙（議長・副議長・首班指名）

export interface OfficeStanding {
  citizen: Citizen;
  votes: number;
}

export async function voteForOffice(actor: Actor, office: Office, candidateDiscordId: string, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const voter = await requireRepresentative(tx, actor);
    const candidate = await requireTargetCitizen(tx, actor.guildId, candidateDiscordId, "候補者");
    if (!(await holds(tx, actor.guildId, candidate.id, "REPRESENTATIVE"))) fail(`${OFFICE_LABEL[office]}には議員しか選ばれません。`);
    const incumbent = await holderOf(tx, actor.guildId, office);
    if (incumbent) fail(`${OFFICE_LABEL[office]}は ${incumbent.citizen.displayName} さんが在任中です。`);
    const guild = await getGuild(tx, actor.guildId);
    await checkEligibility(tx, guild, candidate, office);

    await tx.officeVote.upsert({
      where: { guildId_office_voterId: { guildId: actor.guildId, office, voterId: voter.id } },
      create: { guildId: actor.guildId, office, voterId: voter.id, candidateId: candidate.id },
      update: { candidateId: candidate.id },
    });

    const seated = await seatedRepresentativeIds(tx, actor.guildId);
    const votes = await tx.officeVote.findMany({ where: { guildId: actor.guildId, office }, include: { candidate: true } });
    const standings = new Map<string, OfficeStanding>();
    for (const vote of votes) {
      if (!seated.has(vote.voterId) || !seated.has(vote.candidateId)) continue;
      const entry = standings.get(vote.candidateId) ?? { citizen: vote.candidate, votes: 0 };
      entry.votes++;
      standings.set(vote.candidateId, entry);
    }
    const ranking = [...standings.values()].sort((a, b) => b.votes - a.votes);
    const majority = officeMajority(seated.size);
    const leader = ranking[0];

    if (leader && leader.votes >= majority && (await isEligible(tx, guild, leader.citizen, office))) {
      await appoint(tx, events, { guildId: actor.guildId, citizenId: leader.citizen.id, key: office, source: "PARLIAMENT", now });
      await tx.officeVote.deleteMany({ where: { guildId: actor.guildId, office } });
      const label = OFFICE_LABEL[office];
      await publish(tx, events, actor.guildId, {
        category: office === "PRIME_MINISTER" ? "CABINET" : "PERSONNEL",
        title: office === "PRIME_MINISTER" ? `内閣総理大臣の指名: ${leader.citizen.displayName}` : `${label}の選出: ${leader.citizen.displayName}`,
        body: [
          `国会は ${leader.citizen.displayName} を ${roleTag(label)} に選出しました（${leader.votes}票／在籍議員 ${seated.size}名・過半数 ${majority}票）。`,
          office === "PRIME_MINISTER" ? `${roleTag("内閣総理大臣")}は /cabinet appoint で閣僚を任命できます。` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        linkPath: `/g/${actor.guildId}`,
      });
      return { elected: leader.citizen, ranking, majority, seated: seated.size };
    }
    return { elected: null, ranking, majority, seated: seated.size };
  });
}

// ───────────── 法案

interface CreateBillInput {
  guildId: string;
  kind: BillKind;
  origin: BillOrigin;
  title: string;
  content: string;
  proposerId: string;
  targetId?: string;
  petitionId?: string;
  requiredMajority?: Majority;
  votingEndsAt?: Date;
  now: Date;
}

export async function createBill(tx: Tx, events: DomainEvent[], input: CreateBillInput): Promise<Bill> {
  const number = await nextNumber(tx, input.guildId, "bill");
  const bill = await tx.bill.create({
    data: {
      guildId: input.guildId,
      number,
      kind: input.kind,
      origin: input.origin,
      title: input.title,
      content: input.content,
      proposerId: input.proposerId,
      targetId: input.targetId,
      petitionId: input.petitionId,
      requiredMajority: input.requiredMajority ?? "MAJORITY",
      status: input.votingEndsAt ? "VOTING" : "DELIBERATION",
      votingEndsAt: input.votingEndsAt,
      createdAt: input.now,
    },
  });
  events.push({ type: "billCreated", guildId: input.guildId, billId: bill.id });
  return bill;
}

export async function submitBill(actor: Actor, input: { title: string; content: string }, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const citizen = await requireCitizen(tx, actor.guildId, actor.discordId);
    const isCabinet = await holds(tx, actor.guildId, citizen.id, CABINET_KEYS);
    const isRepresentative = await holds(tx, actor.guildId, citizen.id, "REPRESENTATIVE");
    if (!isCabinet && !isRepresentative) fail("法案を提出できるのは議員と閣僚です。市民の方は /petition で請願できます。");
    const origin: BillOrigin = isCabinet ? "CABINET" : "MEMBER";
    const bill = await createBill(tx, events, {
      guildId: actor.guildId,
      kind: "ORDINARY",
      origin,
      title: input.title,
      content: input.content,
      proposerId: citizen.id,
      now,
    });
    await publish(tx, events, actor.guildId, {
      category: "LEGISLATION",
      title: `第${bill.number}号議案「${bill.title}」提出`,
      body: `${origin === "CABINET" ? "内閣" : "議員"}提出法案。提出者: ${citizen.displayName}\n議長（不在時は議員）が /parliament bill open で採決を開始します。`,
      linkPath: parliamentLink(actor.guildId),
    });
    return bill;
  });
}

async function requirePresiding(db: Db, guildId: string, citizenId: string): Promise<void> {
  const speaker = await holderOf(db, guildId, "SPEAKER");
  const vice = await holderOf(db, guildId, "VICE_SPEAKER");
  if (speaker || vice) {
    if (speaker?.citizenId === citizenId || vice?.citizenId === citizenId) return;
    fail("採決の開始は議長・副議長のみ行えます。");
  }
  if (!(await holds(db, guildId, citizenId, "REPRESENTATIVE"))) fail("採決の開始は議員のみ行えます（議長不在時）。");
}

export async function openBillVote(actor: Actor, number: number, days: number | undefined, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const citizen = await requireCitizen(tx, actor.guildId, actor.discordId);
    await requirePresiding(tx, actor.guildId, citizen.id);
    const bill = await findBill(tx, actor.guildId, number);
    if (bill.status !== "DELIBERATION") fail(`第${number}号議案は審議中ではありません（現在: ${billStatusLabel(bill.status, bill.kind)}）。`);
    const guild = await getGuild(tx, actor.guildId);
    const votingEndsAt = addDays(now, days ?? guild.billVotingDays);
    const updated = await tx.bill.update({ where: { id: bill.id }, data: { status: "VOTING", votingEndsAt } });
    await publish(tx, events, actor.guildId, {
      category: "LEGISLATION",
      title: `第${number}号議案 採決開始`,
      body: `「${bill.title}」の採決を開始しました（${MAJORITY_LABEL[bill.requiredMajority as Majority]}で可決）。\n締切: ${timeToken(votingEndsAt)}\n議員は /parliament bill vote で投票してください。`,
      threadId: bill.threadId,
      linkPath: parliamentLink(actor.guildId),
    });
    return updated;
  });
}

async function currentTally(db: Db, bill: Bill): Promise<BillTally> {
  const seated = await seatedRepresentativeIds(db, bill.guildId);
  const votes = await db.billVote.findMany({ where: { billId: bill.id, round: bill.round } });
  const speaker = await holderOf(db, bill.guildId, "SPEAKER");
  return tallyVotes(
    votes.filter((v) => seated.has(v.citizenId)),
    seated.size,
    bill.requiredMajority as Majority,
    speaker?.citizenId,
  );
}

export async function castBillVote(actor: Actor, number: number, choice: VoteChoice, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const citizen = await requireRepresentative(tx, actor);
    const bill = await findBill(tx, actor.guildId, number);
    if (bill.status !== "VOTING" || !bill.votingEndsAt || now >= bill.votingEndsAt) fail(`第${number}号議案は採決中ではありません。`);
    await tx.billVote.upsert({
      where: { billId_citizenId_round: { billId: bill.id, citizenId: citizen.id, round: bill.round } },
      create: { billId: bill.id, citizenId: citizen.id, round: bill.round, choice, votedAt: now },
      update: { choice, votedAt: now },
    });
    const tally = await currentTally(tx, bill);
    const decision = tally.participants >= tally.seated ? await decideBill(tx, events, bill.id, now, "全議員の投票がそろったため") : null;
    return { bill, tally, decision };
  });
}

export async function decideBill(tx: Tx, events: DomainEvent[], billId: string, now: Date, trigger: string) {
  const bill = await tx.bill.findUnique({ where: { id: billId }, include: { target: true } });
  if (!bill || bill.status !== "VOTING") return null;
  const guild = await getGuild(tx, bill.guildId);
  const tally = await currentTally(tx, bill);
  const summary = describeTally(tally);
  const link = parliamentLink(bill.guildId);
  const label = `第${bill.number}号${BILL_KIND_LABEL[bill.kind as BillKind]}`;

  if (!tally.passed) {
    const note = !tally.quorumMet
      ? "定足数不足"
      : tally.tieBreak === "SPEAKER_AGAINST"
        ? "可否同数・議長決裁により否決"
        : tally.tieBreak === "NO_SPEAKER_VOTE"
          ? "可否同数のため否決"
          : bill.round === 2
            ? "再議決で3分の2に届かず"
            : bill.requiredMajority === "TWO_THIRDS"
              ? "3分の2に届かず"
              : "反対多数";
    await tx.bill.update({ where: { id: bill.id }, data: { status: "REJECTED", decidedAt: now, outcomeNote: note } });
    await publish(tx, events, bill.guildId, {
      category: "LEGISLATION",
      title: `${label} 否決`,
      body: `${trigger}採決を締め切りました。「${bill.title}」は否決されました（${note}）。\n${summary}`,
      threadId: bill.threadId,
      linkPath: link,
    });
    return { status: "REJECTED" as const, tally };
  }

  if (bill.kind === "ORDINARY") {
    if (bill.round === 1) {
      const sanctionDeadline = addDays(now, guild.sanctionDays);
      await tx.bill.update({
        where: { id: bill.id },
        data: {
          status: "PASSED",
          decidedAt: now,
          sanctionDeadline,
          outcomeNote: tally.tieBreak === "SPEAKER_FOR" ? "可否同数・議長決裁により可決" : null,
        },
      });
      await publish(tx, events, bill.guildId, {
        category: "LEGISLATION",
        title: `${label} 可決`,
        body: `${trigger}採決を締め切りました。「${bill.title}」は可決されました。\n${summary}\n管理者派閥は ${timeToken(sanctionDeadline)} までに裁可または拒否権の行使ができます。期限を過ぎると自動的に成立します。`,
        threadId: bill.threadId,
        linkPath: link,
      });
      return { status: "PASSED" as const, tally };
    }
    await tx.bill.update({ where: { id: bill.id }, data: { status: "ENACTED", decidedAt: now, outcomeNote: "再議決（3分の2以上）により成立" } });
    await publish(tx, events, bill.guildId, {
      category: "LEGISLATION",
      title: `${label} 再可決・成立`,
      body: `国会は拒否権を覆し、「${bill.title}」を3分の2以上の賛成で再可決しました。法律として成立します。\n${summary}`,
      threadId: bill.threadId,
      linkPath: link,
    });
    return { status: "ENACTED" as const, tally };
  }

  await tx.bill.update({ where: { id: bill.id }, data: { status: "PASSED", decidedAt: now } });

  if (bill.kind === "NO_CONFIDENCE") {
    const pm = await holderOf(tx, bill.guildId, "PRIME_MINISTER");
    const ended = pm ? await endPosition(tx, events, pm.id, "内閣不信任決議の可決による総辞職", now) : [];
    await publish(tx, events, bill.guildId, {
      category: "CABINET",
      title: "内閣不信任決議 可決",
      body: [
        `${summary}`,
        pm ? `${pm.citizen.displayName}内閣は総辞職しました。` : "内閣総理大臣はすでに不在です。",
        ended.length > 0 ? describeEnded(ended) : null,
        "国会は /parliament elect で新しい内閣総理大臣を指名してください。",
      ]
        .filter(Boolean)
        .join("\n"),
      threadId: bill.threadId,
      linkPath: link,
    });
    return { status: "PASSED" as const, tally };
  }

  // IMPEACHMENT: removes the target from every office except the admin faction's titles.
  const ended = bill.targetId
    ? await endAllPositions(tx, events, bill.guildId, bill.targetId, "国会の弾劾による罷免", now, (key) => !ADMIN_FACTION_KEYS.includes(key as PositionKey))
    : [];
  await publish(tx, events, bill.guildId, {
    category: "PERSONNEL",
    title: `弾劾決議 可決: ${bill.target?.displayName ?? "対象者"}`,
    body: [summary, ended.length > 0 ? `罷免:\n${describeEnded(ended)}` : "対象者はすでに役職に就いていませんでした。"].join("\n"),
    threadId: bill.threadId,
    linkPath: link,
  });
  return { status: "PASSED" as const, tally };
}

export async function withdrawBill(actor: Actor, number: number) {
  return transact(async (tx, events) => {
    const citizen = await requireCitizen(tx, actor.guildId, actor.discordId);
    const bill = await findBill(tx, actor.guildId, number);
    if (bill.proposerId !== citizen.id) fail("法案を撤回できるのは提出者のみです。");
    if (bill.status !== "DELIBERATION") fail("撤回できるのは審議中（採決前）の法案のみです。");
    const updated = await tx.bill.update({ where: { id: bill.id }, data: { status: "WITHDRAWN", decidedAt: new Date() } });
    await publish(tx, events, actor.guildId, {
      category: "LEGISLATION",
      title: `第${number}号議案 撤回`,
      body: `提出者 ${citizen.displayName} が「${bill.title}」を撤回しました。`,
      threadId: bill.threadId,
      linkPath: parliamentLink(actor.guildId),
    });
    return updated;
  });
}

export async function moveOverride(actor: Actor, number: number, days: number | undefined, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const citizen = await requireRepresentative(tx, actor);
    const bill = await findBill(tx, actor.guildId, number);
    if (bill.status !== "VETOED") fail("再議決を発議できるのは拒否権が行使された法案のみです。");
    const guild = await getGuild(tx, actor.guildId);
    const votingEndsAt = addDays(now, days ?? guild.billVotingDays);
    const updated = await tx.bill.update({
      where: { id: bill.id },
      data: { status: "VOTING", round: 2, requiredMajority: "TWO_THIRDS", votingEndsAt, decidedAt: null },
    });
    await publish(tx, events, actor.guildId, {
      category: "LEGISLATION",
      title: `第${number}号議案 再議決の発議`,
      body: `${citizen.displayName} 議員が「${bill.title}」の再議決を発議しました。出席議員の3分の2以上の賛成で成立します。\n締切: ${timeToken(votingEndsAt)}`,
      threadId: bill.threadId,
      linkPath: parliamentLink(actor.guildId),
    });
    return updated;
  });
}

export async function lapsePendingBills(tx: Tx, events: DomainEvent[], guildId: string, reason: string, now: Date): Promise<number> {
  const pending = await tx.bill.findMany({ where: { guildId, status: { in: ["DELIBERATION", "VOTING", "VETOED"] } }, orderBy: { number: "asc" } });
  if (pending.length === 0) return 0;
  await tx.bill.updateMany({
    where: { id: { in: pending.map((b) => b.id) } },
    data: { status: "LAPSED", decidedAt: now, outcomeNote: reason },
  });
  await publish(tx, events, guildId, {
    category: "LEGISLATION",
    title: `議案${pending.length}件が廃案`,
    body: `${reason}、審議未了の議案は廃案となりました。\n${pending.map((b) => `・第${b.number}号 ${b.title}`).join("\n")}`,
    linkPath: parliamentLink(guildId),
  });
  return pending.length;
}

// ───────────── 不信任・弾劾

export async function moveNoConfidence(actor: Actor, reason: string, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const citizen = await requireRepresentative(tx, actor);
    const pm = await holderOf(tx, actor.guildId, "PRIME_MINISTER");
    if (!pm) fail("内閣総理大臣が不在のため、不信任決議案は提出できません。");
    const pending = await tx.bill.findFirst({ where: { guildId: actor.guildId, kind: "NO_CONFIDENCE", status: "VOTING" } });
    if (pending) fail(`採決中の内閣不信任決議案（第${pending.number}号）があります。`);
    const guild = await getGuild(tx, actor.guildId);
    const votingEndsAt = addDays(now, guild.billVotingDays);
    const bill = await createBill(tx, events, {
      guildId: actor.guildId,
      kind: "NO_CONFIDENCE",
      origin: "MEMBER",
      title: `${pm.citizen.displayName}内閣不信任決議案`,
      content: reason,
      proposerId: citizen.id,
      requiredMajority: "MAJORITY",
      votingEndsAt,
      now,
    });
    await publish(tx, events, actor.guildId, {
      category: "CABINET",
      title: `内閣不信任決議案の提出（第${bill.number}号）`,
      body: `${citizen.displayName} 議員が${pm.citizen.displayName}内閣への不信任決議案を提出しました。\n理由: ${reason}\n採決は直ちに開始されます（締切: ${timeToken(votingEndsAt)}）。可決されると内閣は総辞職します。`,
      linkPath: parliamentLink(actor.guildId),
    });
    return bill;
  });
}

export async function moveImpeachment(actor: Actor, targetDiscordId: string, reason: string, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const citizen = await requireRepresentative(tx, actor);
    const target = await requireTargetCitizen(tx, actor.guildId, targetDiscordId, "弾劾の対象者");
    const impeachable = (await activePositions(tx, actor.guildId, { citizenId: target.id })).filter(
      (p) => !ADMIN_FACTION_KEYS.includes(p.key as PositionKey),
    );
    if (impeachable.length === 0) fail("弾劾の対象となる役職に就いていません（元首・管理官は対象外です）。");
    const pending = await tx.bill.findFirst({ where: { guildId: actor.guildId, kind: "IMPEACHMENT", targetId: target.id, status: "VOTING" } });
    if (pending) fail(`この方に対する弾劾決議案（第${pending.number}号）が採決中です。`);
    const guild = await getGuild(tx, actor.guildId);
    const votingEndsAt = addDays(now, guild.billVotingDays);
    const bill = await createBill(tx, events, {
      guildId: actor.guildId,
      kind: "IMPEACHMENT",
      origin: "MEMBER",
      title: `${target.displayName}（${impeachable.map((p) => p.title).join("・")}）弾劾決議案`,
      content: reason,
      proposerId: citizen.id,
      targetId: target.id,
      requiredMajority: "TWO_THIRDS",
      votingEndsAt,
      now,
    });
    await publish(tx, events, actor.guildId, {
      category: "PERSONNEL",
      title: `弾劾決議案の提出（第${bill.number}号）`,
      body: `${citizen.displayName} 議員が ${target.displayName} の弾劾を発議しました。\n理由: ${reason}\n出席議員の3分の2以上の賛成で全役職（${roleTag("元首")}・${roleTag("管理官")}を除く）から罷免されます。締切: ${timeToken(votingEndsAt)}`,
      linkPath: parliamentLink(actor.guildId),
    });
    return bill;
  });
}

// ───────────── 補佐官

export async function appointAide(actor: Actor, targetDiscordId: string, targetIsAdmin: boolean, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const representative = await requireRepresentative(tx, actor);
    const target = await requireTargetCitizen(tx, actor.guildId, targetDiscordId);
    if (target.id === representative.id) fail("自分自身を補佐官に任命することはできません。");
    const position = await appoint(tx, events, {
      guildId: actor.guildId,
      citizenId: target.id,
      key: "AIDE",
      title: `補佐官（${representative.displayName}議員付）`,
      source: "APPOINTMENT",
      appointedById: representative.id,
      targetIsDiscordAdmin: targetIsAdmin,
      now,
    });
    await publish(tx, events, actor.guildId, {
      category: "PERSONNEL",
      title: `補佐官の任命: ${target.displayName}`,
      body: `${roleTag("国民代表（議員）")} ${representative.displayName} が ${target.displayName} を ${roleTag(position.title)} に任命しました。`,
    });
    return position;
  });
}

export async function dismissAide(actor: Actor, targetDiscordId: string, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const representative = await requireRepresentative(tx, actor);
    const target = await requireTargetCitizen(tx, actor.guildId, targetDiscordId);
    const position = await tx.position.findFirst({
      where: { guildId: actor.guildId, citizenId: target.id, key: "AIDE", appointedById: representative.id, endedAt: null },
    });
    if (!position) fail("あなたが任命した補佐官ではありません。");
    await endPosition(tx, events, position.id, "任命した議員による解任", now);
    await publish(tx, events, actor.guildId, {
      category: "PERSONNEL",
      title: `補佐官の解任: ${target.displayName}`,
      body: `${roleTag("国民代表（議員）")} ${representative.displayName} が ${roleTag("補佐官")} ${target.displayName} を解任しました。`,
    });
    return position;
  });
}

// ───────────── 参照

export type BillFilter = "open" | "enacted" | "closed" | "all";

export async function listBills(guildId: string, filter: BillFilter = "open", take = 20) {
  const status =
    filter === "open"
      ? { in: OPEN_BILL_STATUSES }
      : filter === "enacted"
        ? { in: ["ENACTED", "IMPLEMENTED"] }
        : filter === "closed"
          ? { in: ["REJECTED", "WITHDRAWN", "LAPSED"] }
          : undefined;
  return prisma.bill.findMany({
    where: { guildId, ...(status ? { status } : {}) },
    include: { proposer: true, target: true },
    orderBy: { number: "desc" },
    take,
  });
}

export async function billDetail(guildId: string, number: number) {
  const bill = await prisma.bill.findUnique({
    where: { guildId_number: { guildId, number } },
    include: { proposer: true, target: true, petition: true },
  });
  if (!bill) return null;
  const votes = await prisma.billVote.findMany({
    where: { billId: bill.id, round: bill.round },
    include: { citizen: true },
    orderBy: { votedAt: "asc" },
  });
  const tally = await currentTally(prisma, bill);
  return { bill, votes, tally };
}

export async function parliamentRoster(guildId: string) {
  const guild = await getGuild(prisma, guildId);
  const positions = await activePositions(prisma, guildId, { keys: ["SPEAKER", "VICE_SPEAKER", "REPRESENTATIVE", "AIDE"] });
  const officeVotes = await prisma.officeVote.findMany({ where: { guildId }, include: { candidate: true } });
  return {
    seats: guild.seats,
    speaker: positions.find((p) => p.key === "SPEAKER") ?? null,
    viceSpeaker: positions.find((p) => p.key === "VICE_SPEAKER") ?? null,
    representatives: positions.filter((p) => p.key === "REPRESENTATIVE"),
    aides: positions.filter((p) => p.key === "AIDE"),
    officeVotes,
  };
}
