import { prisma } from "../../lib/prisma";
import { TRIAL_STATUS } from "../../lib/constants";

export async function fileTrial(
  guildId: string,
  plaintiffId: string,
  defendantId: string,
  title: string,
  description: string
) {
  return prisma.trial.create({
    data: { guildId, plaintiffId, defendantId, title, description },
    include: { plaintiff: true, defendant: true },
  });
}

export async function assignJudge(trialId: string, judgeId: string) {
  return prisma.trial.update({
    where: { id: trialId },
    data: {
      judgeId,
      status: TRIAL_STATUS.IN_PROGRESS,
    },
    include: { plaintiff: true, defendant: true, judge: true },
  });
}

export async function issueVerdict(trialId: string, judgeId: string, verdict: string) {
  const trial = await prisma.trial.findUnique({ where: { id: trialId } });
  if (!trial) throw new Error("裁判が見つかりません。");
  if (trial.judgeId !== judgeId) throw new Error("この裁判の担当裁判官ではありません。");
  if (trial.status !== TRIAL_STATUS.IN_PROGRESS) {
    throw new Error("この裁判は審理中ではありません。");
  }

  return prisma.trial.update({
    where: { id: trialId },
    data: {
      verdict,
      status: TRIAL_STATUS.VERDICT,
      closedAt: new Date(),
    },
    include: { plaintiff: true, defendant: true, judge: true },
  });
}

export async function getActiveTrial(guildId: string) {
  return prisma.trial.findMany({
    where: {
      guildId,
      status: { in: [TRIAL_STATUS.FILED, TRIAL_STATUS.IN_PROGRESS] },
    },
    include: { plaintiff: true, defendant: true, judge: true },
    orderBy: { filedAt: "desc" },
  });
}

export async function getTrial(trialId: string) {
  return prisma.trial.findUnique({
    where: { id: trialId },
    include: { plaintiff: true, defendant: true, judge: true },
  });
}
