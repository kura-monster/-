import { prisma } from "../../lib/prisma";
import { ELECTION_STATUS } from "../../lib/constants";

export async function createElection(
  guildId: string,
  title: string,
  seats: number,
  registrationDays: number,
  votingDays: number,
  description?: string
) {
  const now = new Date();
  const registrationEnd = new Date(now.getTime() + registrationDays * 86400000);
  const votingStart = registrationEnd;
  const votingEnd = new Date(votingStart.getTime() + votingDays * 86400000);

  return prisma.election.create({
    data: {
      guildId,
      title,
      description,
      seats,
      status: ELECTION_STATUS.REGISTRATION,
      registrationStart: now,
      registrationEnd,
      votingStart,
      votingEnd,
    },
  });
}

export async function registerCandidate(
  electionId: string,
  citizenId: string,
  manifesto?: string
) {
  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) throw new Error("選挙が見つかりません。");
  if (election.status !== ELECTION_STATUS.REGISTRATION) {
    throw new Error("立候補受付期間ではありません。");
  }
  if (new Date() > election.registrationEnd) {
    throw new Error("立候補受付は終了しました。");
  }

  return prisma.candidate.create({
    data: { electionId, citizenId, manifesto },
  });
}

export async function getActiveElection(guildId: string) {
  return prisma.election.findFirst({
    where: {
      guildId,
      status: { in: [ELECTION_STATUS.REGISTRATION, ELECTION_STATUS.VOTING] },
    },
    include: {
      candidates: { include: { citizen: true, votes: true } },
      votes: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function getElection(electionId: string) {
  return prisma.election.findUnique({
    where: { id: electionId },
    include: {
      candidates: { include: { citizen: true, votes: true } },
      votes: true,
    },
  });
}

export async function advanceElection(electionId: string) {
  const election = await getElection(electionId);
  if (!election) return null;

  const now = new Date();

  if (election.status === ELECTION_STATUS.REGISTRATION && now >= election.registrationEnd) {
    if (election.candidates.length === 0) {
      return prisma.election.update({
        where: { id: electionId },
        data: { status: ELECTION_STATUS.CANCELLED },
      });
    }
    return prisma.election.update({
      where: { id: electionId },
      data: { status: ELECTION_STATUS.VOTING },
    });
  }

  if (election.status === ELECTION_STATUS.VOTING && now >= election.votingEnd) {
    return finalizeElection(electionId);
  }

  return election;
}

export async function finalizeElection(electionId: string) {
  const election = await getElection(electionId);
  if (!election) throw new Error("選挙が見つかりません。");

  const results = election.candidates
    .map((c) => ({ candidate: c, voteCount: c.votes.length }))
    .sort((a, b) => b.voteCount - a.voteCount);

  const winners = results.slice(0, election.seats);

  for (const winner of winners) {
    await prisma.position.create({
      data: {
        type: "REPRESENTATIVE",
        title: "国民代表（議員）",
        citizenId: winner.candidate.citizenId,
        guildId: election.guildId,
        expiresAt: new Date(Date.now() + 30 * 86400000),
      },
    });
  }

  return prisma.election.update({
    where: { id: electionId },
    data: { status: ELECTION_STATUS.COMPLETED },
    include: { candidates: { include: { citizen: true, votes: true } }, votes: true },
  });
}

export async function castVote(electionId: string, citizenId: string, candidateId: string) {
  const election = await prisma.election.findUnique({ where: { id: electionId } });
  if (!election) throw new Error("選挙が見つかりません。");
  if (election.status !== ELECTION_STATUS.VOTING) {
    throw new Error("投票期間ではありません。");
  }

  const candidate = await prisma.candidate.findFirst({
    where: { id: candidateId, electionId },
  });
  if (!candidate) throw new Error("候補者が見つかりません。");

  return prisma.vote.create({
    data: { electionId, citizenId, candidateId },
  });
}
