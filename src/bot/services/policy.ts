import { prisma } from "../../lib/prisma";
import { PROPOSAL_STATUS } from "../../lib/constants";

export async function createProposal(
  guildId: string,
  proposerId: string,
  title: string,
  content: string
) {
  return prisma.proposal.create({
    data: { guildId, proposerId, title, content },
  });
}

export async function listProposals(guildId: string, status?: string) {
  const where: Record<string, unknown> = { guildId };
  if (status) where.status = status;
  return prisma.proposal.findMany({
    where,
    include: {
      proposer: true,
      votes: true,
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
}

export async function getProposal(proposalId: string) {
  return prisma.proposal.findUnique({
    where: { id: proposalId },
    include: {
      proposer: true,
      votes: { include: { citizen: true } },
    },
  });
}

export async function startProposalVoting(proposalId: string, votingDays: number) {
  const now = new Date();
  return prisma.proposal.update({
    where: { id: proposalId },
    data: {
      status: PROPOSAL_STATUS.VOTING,
      votingStart: now,
      votingEnd: new Date(now.getTime() + votingDays * 86400000),
    },
  });
}

export async function voteOnProposal(
  proposalId: string,
  citizenId: string,
  inFavor: boolean,
  reason?: string
) {
  const proposal = await prisma.proposal.findUnique({ where: { id: proposalId } });
  if (!proposal) throw new Error("政策提案が見つかりません。");
  if (proposal.status !== PROPOSAL_STATUS.VOTING) {
    throw new Error("この提案は現在投票期間ではありません。");
  }

  return prisma.proposalVote.upsert({
    where: { proposalId_citizenId: { proposalId, citizenId } },
    update: { inFavor, reason },
    create: { proposalId, citizenId, inFavor, reason },
  });
}

export async function finalizeProposal(proposalId: string) {
  const proposal = await getProposal(proposalId);
  if (!proposal) throw new Error("政策提案が見つかりません。");

  const forVotes = proposal.votes.filter((v) => v.inFavor).length;
  const againstVotes = proposal.votes.filter((v) => !v.inFavor).length;
  const status = forVotes > againstVotes ? PROPOSAL_STATUS.APPROVED : PROPOSAL_STATUS.REJECTED;

  return prisma.proposal.update({
    where: { id: proposalId },
    data: { status },
  });
}
