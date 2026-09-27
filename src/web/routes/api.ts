import { Router, Request, Response } from "express";
import { prisma } from "../../lib/prisma";
import * as electionService from "../../bot/services/election";
import { getGovernment } from "../../bot/services/government";
import { registerCitizen } from "../../bot/services/citizen";

const router = Router();

function requireAuth(req: Request, res: Response, next: () => void) {
  if (!req.session.user) {
    res.status(401).json({ error: "ログインが必要です" });
    return;
  }
  next();
}

router.get("/guilds/:guildId/election", requireAuth, async (req: Request, res: Response) => {
  try {
    const guildId = req.params.guildId as string;
    const election = await electionService.getActiveElection(guildId);
    if (!election) {
      res.json({ election: null });
      return;
    }

    const citizen = await prisma.citizen.findUnique({
      where: { discordId_guildId: { discordId: req.session.user!.id, guildId } },
    });

    const hasVoted = citizen
      ? await prisma.vote.findUnique({
          where: { electionId_citizenId: { electionId: election.id, citizenId: citizen.id } },
        })
      : null;

    res.json({
      election: {
        ...election,
        candidates: election.candidates.map((c) => ({
          id: c.id,
          manifesto: c.manifesto,
          discordId: c.citizen.discordId,
          voteCount: c.votes.length,
        })),
      },
      hasVoted: !!hasVoted,
      citizenId: citizen?.id,
    });
  } catch (error) {
    console.error("API error:", error);
    res.status(500).json({ error: "サーバーエラー" });
  }
});

router.post("/guilds/:guildId/election/vote", requireAuth, async (req: Request, res: Response) => {
  try {
    const guildId = req.params.guildId as string;
    const { candidateId } = req.body;
    if (!candidateId) {
      res.status(400).json({ error: "候補者を選択してください" });
      return;
    }

    let citizen = await prisma.citizen.findUnique({
      where: { discordId_guildId: { discordId: req.session.user!.id, guildId } },
    });

    if (!citizen) {
      citizen = await registerCitizen(req.session.user!.id, guildId);
    }

    const election = await electionService.getActiveElection(guildId);
    if (!election) {
      res.status(400).json({ error: "現在投票中の選挙がありません" });
      return;
    }

    await electionService.castVote(election.id, citizen.id, candidateId);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

router.get("/guilds/:guildId/government", async (req: Request, res: Response) => {
  try {
    const guildId = req.params.guildId as string;
    const gov = await getGovernment(guildId);
    const guild = await prisma.guild.findUnique({ where: { id: guildId } });

    res.json({
      guildName: guild?.name || "不明",
      ...gov,
    });
  } catch (error) {
    console.error("API error:", error);
    res.status(500).json({ error: "サーバーエラー" });
  }
});

router.get("/guilds/:guildId/proposals", async (req: Request, res: Response) => {
  try {
    const guildId = req.params.guildId as string;
    const proposals = await prisma.proposal.findMany({
      where: { guildId },
      include: { proposer: true, votes: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    res.json({ proposals });
  } catch (error) {
    res.status(500).json({ error: "サーバーエラー" });
  }
});

router.get("/guilds/:guildId/trials", async (req: Request, res: Response) => {
  try {
    const guildId = req.params.guildId as string;
    const trials = await prisma.trial.findMany({
      where: { guildId },
      include: { plaintiff: true, defendant: true, judge: true },
      orderBy: { filedAt: "desc" },
      take: 20,
    });
    res.json({ trials });
  } catch (error) {
    res.status(500).json({ error: "サーバーエラー" });
  }
});

export { router as apiRoutes };
