import type { Candidate, Citizen, Election, Guild } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { nextNumber, transact, type Db, type Tx } from "../core/db";
import { DomainError, fail } from "../core/errors";
import type { DomainEvent } from "../core/events";
import { ELECTION_KIND_LABEL, type ElectionKind } from "../core/constants";
import { ELECTORAL_KEYS, MEMBERS_ONLY_OFFICES, OFFICE_ELECTION_KEYS, POSITIONS, type PositionKey } from "../core/positions";
import { decideWinners, secureRandom } from "../core/tally";
import { addDays, timeToken } from "../core/time";
import { cleanText, roleTag } from "../core/text";
import { normalizeMinistryTitle } from "./cabinet";
import { findCitizen, requireCitizen } from "./citizen";
import { publish } from "./gazette";
import { getGuild } from "./guild";
import { lapsePendingBills } from "./parliament";
import { appoint, checkEligibility, endPosition, holderOf, holds } from "./positions";
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
  /** OFFICE: the office to fill. */
  position?: PositionKey;
  /** OFFICE for 国務大臣: the ministry, e.g. 外務. */
  portfolio?: string;
  /** OFFICE for offices with several holders (裁判官・選挙管理委員): how many to elect; all vacancies when omitted. */
  seats?: number;
  title?: string;
  description?: string;
  registrationDays?: number;
  votingDays?: number;
}

/** Which office an election fills, under what title, and how many are elected. */
export function electionOffice(election: Pick<Election, "position" | "positionTitle">): { key: PositionKey; title: string } {
  const key = election.position as PositionKey;
  return { key, title: election.positionTitle ?? POSITIONS[key].label };
}

/**
 * An office election fills a single office by replacing whoever holds it (for 国務大臣, one ministry),
 * or fills vacancies in an office with several holders.
 */
async function planOfficeElection(tx: Tx, guildId: string, input: ElectionInput) {
  const key = input.position;
  if (!key || !OFFICE_ELECTION_KEYS.includes(key)) fail("その役職は選挙で選べません。");
  const def = POSITIONS[key];
  if (typeof def.capacity !== "number") fail("その役職は選挙で選べません。");
  if (key === "MINISTER") {
    if (!cleanText(input.portfolio)) fail("国務大臣の選挙では担当分野（portfolio。例: 外務）を指定してください。");
    const title = normalizeMinistryTitle(cleanText(input.portfolio) as string);
    const ministries = await tx.position.findMany({ where: { guildId, key, endedAt: null } });
    if (!ministries.some((m) => m.title === title) && ministries.length >= def.capacity) {
      fail(`国務大臣は定員（${def.capacity}名）に達しているため、新しい大臣の選挙はできません。`);
    }
    return { key, title, seats: 1 };
  }
  if (def.capacity === 1) return { key, title: def.label, seats: 1 };
  const held = await tx.position.count({ where: { guildId, key, endedAt: null } });
  const vacancies = def.capacity - held;
  if (vacancies <= 0) fail(`「${def.label}」は定員（${def.capacity}名）に達しているため、選挙で補う欠員がありません。`);
  const seats = input.seats ?? vacancies;
  if (!Number.isInteger(seats) || seats < 1 || seats > vacancies) fail(`選ぶ人数は 1〜${vacancies}名（欠員数）で指定してください。`);
  return { key, title: def.label, seats };
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
  let office: { key: PositionKey; title: string } = { key: "REPRESENTATIVE", title: POSITIONS.REPRESENTATIVE.label };
  if (input.kind === "BY") {
    const seated = await tx.position.count({ where: { guildId, key: "REPRESENTATIVE", endedAt: null } });
    seats = guild.seats - seated;
    if (seats <= 0) fail(`欠員がないため補欠選挙は実施できません（定数 ${guild.seats}・現職 ${seated}）。`);
  }
  if (input.kind === "OFFICE") {
    const plan = await planOfficeElection(tx, guildId, input);
    office = { key: plan.key, title: plan.title };
    seats = plan.seats;
  }

  const number = await nextNumber(tx, guildId, "election");
  const name = input.kind === "OFFICE" ? `${office.title}選挙` : ELECTION_KIND_LABEL[input.kind];
  const title = cleanText(input.title) ?? `第${number}回 ${name}`;
  const registrationEndsAt = addDays(now, input.registrationDays ?? guild.registrationDays);
  const votingEndsAt = addDays(registrationEndsAt, input.votingDays ?? guild.votingDays);
  const description = cleanText(input.description);

  const election = await tx.election.create({
    data: {
      guildId,
      number,
      kind: input.kind,
      position: office.key,
      positionTitle: office.title === POSITIONS[office.key].label ? null : office.title,
      title,
      description,
      seats,
      registrationEndsAt,
      votingEndsAt,
      createdAt: now,
    },
  });
  await publish(tx, events, guildId, {
    category: "ELECTION",
    title: `${title} 告示`,
    body: [
      `${announcer}が${title}を告示しました。`,
      description ?? null,
      input.kind === "OFFICE" ? `選ぶ役職: ${roleTag(office.title)}（${seats}名）` : `定数: ${seats}名`,
      MEMBERS_ONLY_OFFICES.includes(office.key) ? "立候補できるのは現職の議員です。" : null,
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
    const { key } = electionOffice(election);
    if (actor.isAdmin && !guild.allowAdminParticipation && POSITIONS[key].faction === "REPRESENTATIVE") {
      fail("管理者派閥（Discord管理者）は国民代表派閥の役職に立候補できません（/admin settings の admin_participation で許可できます）。");
    }
    if (election.kind === "BY" && (await holds(tx, actor.guildId, citizen.id, "REPRESENTATIVE"))) {
      fail("現職の議員は補欠選挙に立候補できません。");
    }
    await checkCandidate(tx, guild, election, citizen);

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

/** Seats the winners of an office election. Returns notes for the gazette. */
async function seatOfficeWinners(tx: Tx, events: DomainEvent[], election: Election, winners: CandidateWithCitizen[], now: Date): Promise<string[]> {
  const { key, title } = electionOffice(election);
  const def = POSITIONS[key];
  const replaces = def.capacity === 1 || key === "MINISTER";
  const notes: string[] = [];
  for (const winner of winners) {
    if (replaces) {
      const incumbents = await tx.position.findMany({
        where: { guildId: election.guildId, key, endedAt: null, ...(key === "MINISTER" ? { title } : {}) },
        include: { citizen: true },
      });
      if (incumbents.some((p) => p.citizenId === winner.citizenId)) {
        notes.push(`${winner.citizen.displayName} が引き続き ${roleTag(title)} を務めます。`);
        continue;
      }
      for (const incumbent of incumbents) {
        await endPosition(tx, events, incumbent.id, "選挙による交代", now);
        notes.push(`${incumbent.citizen.displayName} は ${roleTag(title)} を退任しました。`);
        if (key === "PRIME_MINISTER") {
          await publish(tx, events, election.guildId, {
            category: "CABINET",
            title: `${incumbent.citizen.displayName}内閣 総辞職`,
            body: `${election.title}の結果を受けて内閣は総辞職しました。新しい${roleTag("内閣総理大臣")}は /cabinet appoint で閣僚を任命できます。`,
          });
        }
      }
    }
    if (key === "MINISTER") {
      const other = await tx.position.findFirst({ where: { citizenId: winner.citizenId, key, endedAt: null } });
      if (other) await endPosition(tx, events, other.id, `${title}への就任に伴う退任`, now);
    }
    if (!replaces && typeof def.capacity === "number") {
      const held = await tx.position.count({ where: { guildId: election.guildId, key, endedAt: null } });
      if (held >= def.capacity) {
        notes.push(`${winner.citizen.displayName} は、選挙中に定員（${def.capacity}名）が埋まったため就任できませんでした。`);
        continue;
      }
    }
    await appoint(tx, events, { guildId: election.guildId, citizenId: winner.citizenId, key, title, source: "ELECTION", now });
  }
  return notes;
}

async function seatWinners(tx: Tx, events: DomainEvent[], election: Election, winners: CandidateWithCitizen[], now: Date): Promise<string[]> {
  if (election.kind === "OFFICE") return seatOfficeWinners(tx, events, election, winners, now);
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
  return [];
}

/**
 * Whether a citizen may stand (checked again when the votes are counted). Holders of a single office or ministry may
 * seek re-election, and holding what the win replaces is fine: an aide leaves on winning a seat, a minister moves
 * ministries. Offices with several holders only fill vacancies, so their holders cannot stand.
 */
async function checkCandidate(db: Db, guild: Guild, election: Election, citizen: Citizen): Promise<void> {
  const { key } = electionOffice(election);
  if (MEMBERS_ONLY_OFFICES.includes(key) && !(await holds(db, guild.id, citizen.id, "REPRESENTATIVE"))) {
    fail(`${POSITIONS[key].label}に立候補できるのは現職の議員だけです。`);
  }
  const replaces = POSITIONS[key].capacity === 1 || key === "MINISTER";
  const ignoreKeys: PositionKey[] = key === "REPRESENTATIVE" ? ["REPRESENTATIVE", "AIDE"] : replaces ? [key] : [];
  await checkEligibility(db, guild, citizen, key, { ignoreKeys });
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
    if (!candidate.citizen.active) continue;
    try {
      await checkCandidate(tx, guild, election, candidate.citizen);
      eligible.push(candidate);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
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
      const notes = await seatWinners(tx, events, election, candidates, now);
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
          ...notes,
          vacancies > 0
            ? `欠員: ${vacancies}名${election.kind === "OFFICE" ? "" : "（/election manage start で補欠選挙を実施できます）"}`
            : null,
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
    const notes = await seatWinners(tx, events, election, eligible.filter((c) => winnerIds.has(c.id)), now);

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
        ...notes,
        decision.lotteryUsed ? "※最下位当選者が得票同数のため、くじにより当選人を決定しました。" : null,
        decision.unfilledSeats > 0
          ? `※法定得票数（${decision.minVotes.toFixed(2)}票）以上の候補者が不足したため、${decision.unfilledSeats}${election.kind === "OFFICE" ? "名" : "議席"}が欠員となりました。`
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
