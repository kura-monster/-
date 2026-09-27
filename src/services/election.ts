import type { Candidate, Citizen, Election } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { nextNumber, transact, type Db, type Tx } from "../core/db";
import { fail } from "../core/errors";
import type { DomainEvent } from "../core/events";
import { ELECTION_KIND_LABEL, type ElectionKind } from "../core/constants";
import { ELECTORAL_KEYS } from "../core/positions";
import { decideWinners, secureRandom } from "../core/tally";
import { addDays, timeToken } from "../core/time";
import { cleanText } from "../core/text";
import { findCitizen, requireCitizen } from "./citizen";
import { publish } from "./gazette";
import { getGuild } from "./guild";
import { lapsePendingBills } from "./parliament";
import { appoint, checkEligibility, endPosition, holderOf, holds, isEligible } from "./positions";
import type { Actor } from "./types";

export const ACTIVE_ELECTION_STATUSES = ["REGISTRATION", "VOTING"];
const electionLink = (guildId: string) => `/g/${guildId}/election`;

export async function activeElection(db: Db, guildId: string): Promise<Election | null> {
  return db.election.findFirst({
    where: { guildId, status: { in: ACTIVE_ELECTION_STATUSES } },
    orderBy: { number: "desc" },
  });
}

async function electionManagerLabel(db: Db, actor: Actor): Promise<string> {
  const citizen = await findCitizen(db, actor.guildId, actor.discordId);
  if (citizen?.active && (await holds(db, actor.guildId, citizen.id, ELECTORAL_KEYS))) return `選挙管理委員会（${actor.displayName}）`;
  if (actor.isAdmin) return `管理者 ${actor.displayName}`;
  fail("選挙の管理は選挙管理委員長・選挙管理委員、または管理者のみが行えます。");
}

export interface ElectionInput {
  kind: ElectionKind;
  title?: string;
  description?: string;
  registrationDays?: number;
  votingDays?: number;
}

export async function createElection(
  tx: Tx,
  events: DomainEvent[],
  guildId: string,
  input: ElectionInput,
  now: Date,
  announcer: string,
): Promise<Election> {
  const guild = await getGuild(tx, guildId);
  const running = await activeElection(tx, guildId);
  if (running) fail(`進行中の選挙（${running.title}）があります。確定または中止してから告示してください。`);

  let seats = guild.seats;
  if (input.kind === "BY") {
    const seated = await tx.position.count({ where: { guildId, key: "REPRESENTATIVE", endedAt: null } });
    seats = guild.seats - seated;
    if (seats <= 0) fail(`欠員がないため補欠選挙は実施できません（定数 ${guild.seats}・現職 ${seated}）。`);
  }

  const number = await nextNumber(tx, guildId, "election");
  const title = cleanText(input.title) ?? `第${number}回 ${ELECTION_KIND_LABEL[input.kind]}`;
  const registrationEndsAt = addDays(now, input.registrationDays ?? guild.registrationDays);
  const votingEndsAt = addDays(registrationEndsAt, input.votingDays ?? guild.votingDays);
  const description = cleanText(input.description);

  const election = await tx.election.create({
    data: { guildId, number, kind: input.kind, title, description, seats, registrationEndsAt, votingEndsAt, createdAt: now },
  });
  await publish(tx, events, guildId, {
    category: "ELECTION",
    title: `${title} 告示`,
    body: [
      `${announcer}が${title}を告示しました。`,
      description ?? null,
      `定数: ${seats}名`,
      `立候補受付: ${timeToken(registrationEndsAt)} まで（/election candidacy）`,
      `投票期間: ${timeToken(registrationEndsAt)} 〜 ${timeToken(votingEndsAt)}（Webで秘密投票）`,
    ]
      .filter(Boolean)
      .join("\n"),
    linkPath: electionLink(guildId),
  });
  return election;
}

export async function startElection(actor: Actor, input: ElectionInput, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const announcer = await electionManagerLabel(tx, actor);
    return createElection(tx, events, actor.guildId, input, now, announcer);
  });
}

export async function standForElection(actor: Actor, manifesto?: string, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const citizen = await requireCitizen(tx, actor.guildId, actor.discordId);
    const guild = await getGuild(tx, actor.guildId);
    const election = await activeElection(tx, actor.guildId);
    if (!election) fail("現在、告示中の選挙はありません。");
    if (election.status !== "REGISTRATION" || now >= election.registrationEndsAt) fail("立候補の受付期間は終了しています。");
    if (actor.isAdmin && !guild.allowAdminParticipation) {
      fail("管理者派閥（Discord管理者）は立候補できません（/admin settings の admin_participation で許可できます）。");
    }
    if (election.kind === "BY" && (await holds(tx, actor.guildId, citizen.id, "REPRESENTATIVE"))) {
      fail("現職の議員は補欠選挙に立候補できません。");
    }
    // Sitting representatives may seek re-election; an aide resigns automatically on winning.
    await checkEligibility(tx, guild, citizen, "REPRESENTATIVE", { ignoreKeys: ["REPRESENTATIVE", "AIDE"] });

    const existing = await tx.candidate.findUnique({
      where: { electionId_citizenId: { electionId: election.id, citizenId: citizen.id } },
    });
    if (existing && !existing.withdrawnAt) fail("すでに立候補しています。");
    const text = cleanText(manifesto) ?? null;
    const candidate = existing
      ? await tx.candidate.update({ where: { id: existing.id }, data: { withdrawnAt: null, manifesto: text, registeredAt: now } })
      : await tx.candidate.create({ data: { electionId: election.id, citizenId: citizen.id, manifesto: text, registeredAt: now } });

    await publish(tx, events, actor.guildId, {
      category: "ELECTION",
      title: `${election.title} 立候補届出: ${citizen.displayName}`,
      body: `${citizen.displayName} が立候補しました。${text ? `\n公約: ${text}` : ""}`,
      linkPath: electionLink(actor.guildId),
    });
    return { election, candidate };
  });
}

export async function withdrawCandidacy(actor: Actor, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const citizen = await requireCitizen(tx, actor.guildId, actor.discordId);
    const election = await activeElection(tx, actor.guildId);
    if (!election) fail("現在、告示中の選挙はありません。");
    if (election.status !== "REGISTRATION") fail("立候補受付の締切後は取り下げできません。");
    const candidate = await tx.candidate.findUnique({
      where: { electionId_citizenId: { electionId: election.id, citizenId: citizen.id } },
    });
    if (!candidate || candidate.withdrawnAt) fail("立候補していません。");
    await tx.candidate.update({ where: { id: candidate.id }, data: { withdrawnAt: now } });
    await publish(tx, events, actor.guildId, {
      category: "ELECTION",
      title: `${election.title} 立候補取り下げ: ${citizen.displayName}`,
      body: `${citizen.displayName} が立候補を取り下げました。`,
      linkPath: electionLink(actor.guildId),
    });
    return election;
  });
}

type CandidateWithCitizen = Candidate & { citizen: Citizen };

async function seatWinners(tx: Tx, events: DomainEvent[], election: Election, winners: CandidateWithCitizen[], now: Date) {
  const guild = await getGuild(tx, election.guildId);
  let expiresAt: Date;

  if (election.kind === "GENERAL") {
    const visited = new Set<string>();
    const oldSeats = await tx.position.findMany({ where: { guildId: guild.id, key: "REPRESENTATIVE", endedAt: null } });
    for (const seat of oldSeats) await endPosition(tx, events, seat.id, "総選挙による任期満了", now, visited);
    const pm = await holderOf(tx, guild.id, "PRIME_MINISTER");
    if (pm) {
      await endPosition(tx, events, pm.id, "総選挙後の内閣総辞職", now, visited);
      await publish(tx, events, guild.id, {
        category: "CABINET",
        title: `${pm.citizen.displayName}内閣 総辞職`,
        body: "総選挙の結果を受けて内閣は総辞職しました。新しい国会は /parliament elect で内閣総理大臣を指名してください。",
      });
    }
    await lapsePendingBills(tx, events, guild.id, "総選挙により新しい国会が構成されたため", now);
    await tx.officeVote.deleteMany({ where: { guildId: guild.id } });
    expiresAt = addDays(now, guild.termDays);
  } else {
    // 補欠選挙の当選者の任期は現職の残任期間。
    const seats = await tx.position.findMany({ where: { guildId: guild.id, key: "REPRESENTATIVE", endedAt: null } });
    const latest = Math.max(0, ...seats.map((s) => s.expiresAt?.getTime() ?? 0));
    expiresAt = latest > now.getTime() ? new Date(latest) : addDays(now, guild.termDays);
  }

  for (const winner of winners) {
    const aide = await tx.position.findFirst({ where: { citizenId: winner.citizenId, key: "AIDE", endedAt: null } });
    if (aide) await endPosition(tx, events, aide.id, "議員当選に伴う辞職", now);
    await appoint(tx, events, {
      guildId: guild.id,
      citizenId: winner.citizenId,
      key: "REPRESENTATIVE",
      source: "ELECTION",
      expiresAt,
      now,
    });
  }
}

/** Candidates who left, were revoked, or took an incompatible office during the campaign cannot be seated. */
async function eligibleCandidates(tx: Tx, election: Election): Promise<CandidateWithCitizen[]> {
  const guild = await getGuild(tx, election.guildId);
  const candidates = await tx.candidate.findMany({
    where: { electionId: election.id, withdrawnAt: null },
    include: { citizen: true },
    orderBy: { registeredAt: "asc" },
  });
  const eligible: CandidateWithCitizen[] = [];
  for (const candidate of candidates) {
    if (candidate.citizen.active && (await isEligible(tx, guild, candidate.citizen, "REPRESENTATIVE", ["REPRESENTATIVE", "AIDE"]))) {
      eligible.push(candidate);
    }
  }
  return eligible;
}

/** Ends the candidacy period: cancels (no candidates), elects unopposed (≤ seats), or opens voting. */
export async function closeRegistration(guildId: string, electionId: string, now: Date = new Date()): Promise<Election | null> {
  return transact(async (tx, events) => {
    const election = await tx.election.findUnique({ where: { id: electionId } });
    if (!election || election.guildId !== guildId || election.status !== "REGISTRATION") return null;
    const registrationEndsAt = now < election.registrationEndsAt ? now : election.registrationEndsAt;
    const candidates = await eligibleCandidates(tx, election);

    if (candidates.length === 0) {
      const updated = await tx.election.update({
        where: { id: election.id },
        data: { status: "CANCELLED", cancelReason: "立候補者なし", decidedAt: now, registrationEndsAt },
      });
      await publish(tx, events, guildId, {
        category: "ELECTION",
        title: `${election.title} 不成立`,
        body: "立候補者がいなかったため、選挙は不成立となりました。",
        linkPath: electionLink(guildId),
      });
      return updated;
    }

    if (candidates.length <= election.seats) {
      await tx.candidate.updateMany({ where: { id: { in: candidates.map((c) => c.id) } }, data: { elected: true } });
      await seatWinners(tx, events, election, candidates, now);
      const updated = await tx.election.update({
        where: { id: election.id },
        data: { status: "COMPLETED", decidedAt: now, registrationEndsAt, votingEndsAt: now },
      });
      const vacancies = election.seats - candidates.length;
      await publish(tx, events, guildId, {
        category: "ELECTION",
        title: `${election.title} 無投票当選`,
        body: [
          `立候補者が定数（${election.seats}名）以下のため、投票を行わずに当選が確定しました。`,
          ...candidates.map((c) => `当選　${c.citizen.displayName}`),
          vacancies > 0 ? `欠員: ${vacancies}名（/election manage start で補欠選挙を実施できます）` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        linkPath: electionLink(guildId),
      });
      return updated;
    }

    const updated = await tx.election.update({ where: { id: election.id }, data: { status: "VOTING", registrationEndsAt } });
    events.push({ type: "electionVotingOpened", guildId, electionId: election.id });
    await publish(tx, events, guildId, {
      category: "ELECTION",
      title: `${election.title} 投票開始`,
      body: [
        `立候補者 ${candidates.length}名（定数 ${election.seats}名）。`,
        `投票締切: ${timeToken(election.votingEndsAt)}`,
        `選挙人名簿: ${timeToken(registrationEndsAt)} までに市民登録した市民`,
        "投票はWebから行えます。秘密投票のため、誰が誰に投票したかは記録されません。",
      ].join("\n"),
      linkPath: electionLink(guildId),
    });
    return updated;
  });
}

export async function castBallot(guildId: string, voterDiscordId: string, electionId: string, candidateId: string, now: Date = new Date()) {
  return transact(async (tx) => {
    const citizen = await findCitizen(tx, guildId, voterDiscordId);
    if (!citizen || !citizen.active) fail("市民登録が必要です。Discordで /citizen register を実行してください。");
    const election = await tx.election.findUnique({ where: { id: electionId } });
    if (!election || election.guildId !== guildId) fail("選挙が見つかりません。");
    if (election.status !== "VOTING" || now >= election.votingEndsAt) fail("投票期間外です。");
    if (citizen.registeredAt > election.registrationEndsAt) {
      fail("選挙人名簿に登録されていません（立候補受付の締切までに市民登録した方のみ投票できます）。");
    }
    const candidate = await tx.candidate.findFirst({ where: { id: candidateId, electionId, withdrawnAt: null } });
    if (!candidate) fail("候補者が見つかりません。");
    const already = await tx.voterRecord.findUnique({ where: { electionId_citizenId: { electionId, citizenId: citizen.id } } });
    if (already) fail("すでに投票済みです。");
    await tx.voterRecord.create({ data: { electionId, citizenId: citizen.id } });
    await tx.ballot.create({ data: { electionId, candidateId } });
    return { ok: true as const };
  });
}

export async function finalizeElection(guildId: string, electionId: string, now: Date = new Date(), random: () => number = secureRandom) {
  return transact(async (tx, events) => {
    const election = await tx.election.findUnique({ where: { id: electionId } });
    if (!election || election.guildId !== guildId || election.status !== "VOTING") return null;

    const allCandidates = await tx.candidate.findMany({ where: { electionId, withdrawnAt: null }, include: { citizen: true } });
    const eligible = await eligibleCandidates(tx, election);
    const eligibleIds = new Set(eligible.map((c) => c.id));
    const grouped = await tx.ballot.groupBy({ by: ["candidateId"], where: { electionId }, _count: { _all: true } });
    const votesOf = (id: string) => grouped.find((g) => g.candidateId === id)?._count._all ?? 0;

    const decision = decideWinners(
      eligible.map((c) => ({ id: c.id, votes: votesOf(c.id) })),
      election.seats,
      random,
    );
    const winnerIds = new Set(decision.winners);
    for (const candidate of allCandidates) {
      await tx.candidate.update({ where: { id: candidate.id }, data: { voteCount: votesOf(candidate.id), elected: winnerIds.has(candidate.id) } });
    }
    await seatWinners(tx, events, election, eligible.filter((c) => winnerIds.has(c.id)), now);

    const updated = await tx.election.update({
      where: { id: electionId },
      data: {
        status: "COMPLETED",
        decidedAt: now,
        lotteryUsed: decision.lotteryUsed,
        votingEndsAt: now < election.votingEndsAt ? now : election.votingEndsAt,
      },
    });
    const turnout = await tx.voterRecord.count({ where: { electionId } });
    const ranking = [...allCandidates].sort((a, b) => votesOf(b.id) - votesOf(a.id));
    await publish(tx, events, guildId, {
      category: "ELECTION",
      title: `${election.title} 当選確定`,
      body: [
        `投票者数: ${turnout}名`,
        ...ranking.map((c) => {
          const mark = winnerIds.has(c.id) ? "当選" : "落選";
          return `${mark}　${c.citizen.displayName}　${votesOf(c.id)}票${eligibleIds.has(c.id) ? "" : "（失格）"}`;
        }),
        decision.lotteryUsed ? "※最下位当選者が得票同数のため、くじにより当選人を決定しました。" : null,
        decision.unfilledSeats > 0
          ? `※法定得票数（${decision.minVotes.toFixed(2)}票）以上の候補者が不足したため、${decision.unfilledSeats}議席が欠員となりました。`
          : null,
      ]
        .filter(Boolean)
        .join("\n"),
      linkPath: electionLink(guildId),
    });
    return { election: updated, decision };
  });
}

export async function advanceElection(actor: Actor, now: Date = new Date()) {
  const election = await activeElection(prisma, actor.guildId);
  if (!election) fail("進行中の選挙はありません。");
  await electionManagerLabel(prisma, actor);
  if (election.status === "REGISTRATION") return closeRegistration(actor.guildId, election.id, now);
  const result = await finalizeElection(actor.guildId, election.id, now);
  return result?.election ?? null;
}

export async function cancelElection(actor: Actor, reason: string, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const announcer = await electionManagerLabel(tx, actor);
    const election = await activeElection(tx, actor.guildId);
    if (!election) fail("進行中の選挙はありません。");
    const updated = await tx.election.update({
      where: { id: election.id },
      data: { status: "CANCELLED", cancelReason: reason, decidedAt: now },
    });
    await publish(tx, events, actor.guildId, {
      category: "ELECTION",
      title: `${election.title} 中止`,
      body: `${announcer}が選挙を中止しました。\n理由: ${reason}`,
      linkPath: electionLink(actor.guildId),
    });
    return updated;
  });
}

// ───────────── 参照

export async function electionOverview(guildId: string) {
  const election = await activeElection(prisma, guildId);
  if (!election) return null;
  const candidates = await prisma.candidate.findMany({
    where: { electionId: election.id, withdrawnAt: null },
    include: { citizen: true },
    orderBy: { registeredAt: "asc" },
  });
  const turnout = await prisma.voterRecord.count({ where: { electionId: election.id } });
  return { election, candidates, turnout };
}

export async function electionResults(guildId: string, number?: number) {
  const election = await prisma.election.findFirst({
    where: { guildId, status: { in: ["COMPLETED", "CANCELLED"] }, ...(number ? { number } : {}) },
    orderBy: { number: "desc" },
  });
  if (!election) return null;
  const candidates = await prisma.candidate.findMany({
    where: { electionId: election.id, withdrawnAt: null },
    include: { citizen: true },
    orderBy: [{ voteCount: "desc" }, { registeredAt: "asc" }],
  });
  const turnout = await prisma.voterRecord.count({ where: { electionId: election.id } });
  return { election, candidates, turnout };
}

/** What the web dashboard shows to one voter. Vote counts stay hidden until the election is decided. */
export async function electionViewForVoter(guildId: string, voterDiscordId: string, now: Date = new Date()) {
  const overview = await electionOverview(guildId);
  const citizen = await findCitizen(prisma, guildId, voterDiscordId);
  let viewer: { voted: boolean; onRoll: boolean; canVote: boolean } | null = null;
  if (overview && citizen) {
    const { election } = overview;
    const voted = !!(await prisma.voterRecord.findUnique({
      where: { electionId_citizenId: { electionId: election.id, citizenId: citizen.id } },
    }));
    const onRoll = citizen.active && citizen.registeredAt <= election.registrationEndsAt;
    viewer = { voted, onRoll, canVote: election.status === "VOTING" && now < election.votingEndsAt && onRoll && !voted };
  }
  const past = await prisma.election.findMany({
    where: { guildId, status: { in: ["COMPLETED", "CANCELLED"] } },
    orderBy: { number: "desc" },
    take: 5,
    include: {
      candidates: { where: { withdrawnAt: null }, include: { citizen: true }, orderBy: [{ voteCount: "desc" }] },
      _count: { select: { voterRecords: true } },
    },
  });
  return { current: overview, viewer, past };
}
