import { Router, type NextFunction, type Request, type Response } from "express";
import type { Citizen } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { config } from "../config";
import { DomainError } from "../core/errors";
import {
  BILL_KIND_LABEL,
  BILL_ORIGIN_LABEL,
  CASE_RESULT_LABEL,
  CASE_STATUS_LABEL,
  ELECTION_KIND_LABEL,
  ELECTION_STATUS_LABEL,
  GAZETTE_CATEGORY_LABEL,
  MAJORITY_LABEL,
  PENALTY_LABEL,
  PENALTY_STATUS_LABEL,
  PETITION_STATUS_LABEL,
  VOTE_CHOICE_LABEL,
  billStatusLabel,
} from "../core/constants";
import { BRANCH_LABEL, FACTION_LABEL, POSITION_KEYS, POSITIONS } from "../core/positions";
import { effectivePenalty, effectiveResult, effectiveRuling } from "../services/court-rules";
import { caseDetail, listCases } from "../services/court";
import { citizenGuilds, findCitizen } from "../services/citizen";
import { castBallot, electionViewForVoter } from "../services/election";
import { recentGazette } from "../services/gazette";
import { governmentOverview } from "../services/overview";
import { billDetail, listBills } from "../services/parliament";
import { listPetitions, signPetition } from "../services/petition";

export const apiRouter = Router();

const allowedOrigin = new URL(config.webBaseUrl).origin;

function requestOrigin(req: Request): string | undefined {
  const origin = req.get("origin");
  if (origin) return origin;
  const referer = req.get("referer");
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

/** State-changing requests must come from our own pages (defence in depth on top of SameSite cookies). */
function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.method === "GET" || req.method === "HEAD") return next();
  if (requestOrigin(req) !== allowedOrigin) {
    res.status(403).json({ error: "不正なリクエスト元です。" });
    return;
  }
  next();
}

function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.user) {
    res.status(401).json({ error: "ログインが必要です。" });
    return;
  }
  next();
}

/** Guild data is only visible to that guild's citizens. */
async function requireCitizen(req: Request<{ guildId: string }>, res: Response, next: NextFunction): Promise<void> {
  const citizen = await findCitizen(prisma, req.params.guildId, req.session.user!.id);
  if (!citizen?.active) {
    res.status(403).json({ error: "このサーバーの市民ではありません。Discordで /citizen register を実行してください。" });
    return;
  }
  res.locals.citizen = citizen;
  next();
}

function numberParam(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new DomainError("番号が正しくありません。");
  return number;
}

const label = <T extends Record<string, string>>(labels: T, key: string | null | undefined) => (key ? (labels[key] ?? key) : null);
const person = (c: Pick<Citizen, "displayName" | "avatarUrl" | "number">) => ({ name: c.displayName, avatarUrl: c.avatarUrl, number: c.number });
const avatarOf = (user: { id: string; avatar: string | null }) =>
  user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64` : null;

apiRouter.use(requireSameOrigin);

apiRouter.get("/me", async (req, res) => {
  const user = req.session.user;
  if (!user) {
    res.json({ user: null, guilds: [] });
    return;
  }
  const citizens = await citizenGuilds(user.id);
  res.json({
    user: { name: user.globalName ?? user.username, avatarUrl: avatarOf(user) },
    guilds: citizens.map((c) => ({ id: c.guild.id, name: c.guild.name, citizenNumber: c.number })),
  });
});

const guildApi = Router({ mergeParams: true });
apiRouter.use("/guilds/:guildId", requireUser, requireCitizen, guildApi);

guildApi.get("/overview", async (req: Request<{ guildId: string }>, res) => {
  const { guild, positions, citizens, openBills, openCases } = await governmentOverview(req.params.guildId);
  const me = res.locals.citizen as Citizen;
  res.json({
    guild: { id: guild.id, name: guild.name, seats: guild.seats, termDays: guild.termDays },
    me: person(me),
    stats: { citizens, openBills, openCases, seated: positions.filter((p) => p.key === "REPRESENTATIVE").length },
    positions: positions.map((p) => ({
      key: p.key,
      title: p.title,
      startedAt: p.startedAt,
      expiresAt: p.expiresAt,
      holder: person(p.citizen),
      isMe: p.citizenId === me.id,
    })),
    catalog: POSITION_KEYS.map((key) => {
      const def = POSITIONS[key];
      return {
        key,
        label: def.label,
        rank: def.rank,
        faction: def.faction,
        factionLabel: FACTION_LABEL[def.faction],
        branch: def.branch,
        branchLabel: BRANCH_LABEL[def.branch],
        capacity: typeof def.capacity === "number" ? def.capacity : null,
        selection: def.selection,
        powers: def.powers,
        color: `#${def.color.toString(16).padStart(6, "0")}`,
      };
    }),
  });
});

guildApi.get("/election", async (req: Request<{ guildId: string }>, res) => {
  const view = await electionViewForVoter(req.params.guildId, req.session.user!.id);
  const current = view.current;
  res.json({
    current: current && {
      id: current.election.id,
      title: current.election.title,
      kindLabel: label(ELECTION_KIND_LABEL, current.election.kind),
      status: current.election.status,
      statusLabel: label(ELECTION_STATUS_LABEL, current.election.status),
      seats: current.election.seats,
      description: current.election.description,
      createdAt: current.election.createdAt,
      registrationEndsAt: current.election.registrationEndsAt,
      votingEndsAt: current.election.votingEndsAt,
      turnout: current.turnout,
      candidates: current.candidates.map((c) => ({ id: c.id, manifesto: c.manifesto, ...person(c.citizen) })),
    },
    viewer: view.viewer,
    past: view.past.map((e) => ({
      title: e.title,
      kindLabel: label(ELECTION_KIND_LABEL, e.kind),
      status: e.status,
      statusLabel: label(ELECTION_STATUS_LABEL, e.status),
      seats: e.seats,
      decidedAt: e.decidedAt,
      cancelReason: e.cancelReason,
      lotteryUsed: e.lotteryUsed,
      turnout: e._count.voterRecords,
      candidates: e.candidates.map((c) => ({ ...person(c.citizen), voteCount: c.voteCount ?? 0, elected: c.elected })),
    })),
  });
});

guildApi.post("/elections/:electionId/ballot", async (req: Request<{ guildId: string; electionId: string }>, res) => {
  const candidateId = typeof req.body?.candidateId === "string" ? req.body.candidateId : "";
  if (!candidateId) {
    res.status(400).json({ error: "候補者を選んでください。" });
    return;
  }
  await castBallot(req.params.guildId, req.session.user!.id, req.params.electionId, candidateId);
  res.json({ ok: true });
});

guildApi.get("/bills", async (req: Request<{ guildId: string }>, res) => {
  const bills = await listBills(req.params.guildId, "all", 50);
  res.json({
    bills: bills.map((b) => ({
      number: b.number,
      title: b.title,
      kindLabel: label(BILL_KIND_LABEL, b.kind),
      originLabel: label(BILL_ORIGIN_LABEL, b.origin),
      status: b.status,
      statusLabel: billStatusLabel(b.status, b.kind),
      majorityLabel: label(MAJORITY_LABEL, b.requiredMajority),
      round: b.round,
      proposer: person(b.proposer),
      target: b.target ? person(b.target) : null,
      createdAt: b.createdAt,
      votingEndsAt: b.votingEndsAt,
      sanctionDeadline: b.sanctionDeadline,
    })),
  });
});

guildApi.get("/bills/:number", async (req: Request<{ guildId: string; number: string }>, res) => {
  const detail = await billDetail(req.params.guildId, numberParam(req.params.number));
  if (!detail) {
    res.status(404).json({ error: "法案が見つかりません。" });
    return;
  }
  const { bill, votes, tally } = detail;
  res.json({
    number: bill.number,
    content: bill.content,
    outcomeNote: bill.outcomeNote,
    vetoReason: bill.vetoReason,
    implementedNote: bill.implementedNote,
    petitionNumber: bill.petition?.number ?? null,
    tally,
    votes: votes.map((v) => ({ choice: v.choice, choiceLabel: label(VOTE_CHOICE_LABEL, v.choice), ...person(v.citizen) })),
  });
});

guildApi.get("/cases", async (req: Request<{ guildId: string }>, res) => {
  const cases = await listCases(req.params.guildId, "all", 50);
  res.json({
    cases: cases.map((c) => ({
      number: c.number,
      title: c.title,
      status: c.status,
      statusLabel: label(CASE_STATUS_LABEL, c.status),
      filedAt: c.filedAt,
      plaintiff: person(c.plaintiff),
      defendant: person(c.defendant),
      judge: c.judge ? person(c.judge) : null,
      resultLabel: label(CASE_RESULT_LABEL, effectiveResult(c)),
      penaltyLabel: label(PENALTY_LABEL, effectivePenalty(c)),
    })),
  });
});

guildApi.get("/cases/:number", async (req: Request<{ guildId: string; number: string }>, res) => {
  const found = await caseDetail(req.params.guildId, numberParam(req.params.number));
  if (!found) {
    res.status(404).json({ error: "事件が見つかりません。" });
    return;
  }
  res.json({
    number: found.number,
    claim: found.claim,
    defense: found.defense,
    firstInstance: found.result
      ? { resultLabel: label(CASE_RESULT_LABEL, found.result), penaltyLabel: label(PENALTY_LABEL, found.penalty), ruling: found.ruling }
      : null,
    appeal: found.appealReason ? { reason: found.appealReason, appellant: found.appellant ? person(found.appellant) : null } : null,
    finalRuling: found.appealResult
      ? {
          resultLabel: label(CASE_RESULT_LABEL, found.appealResult),
          penaltyLabel: label(PENALTY_LABEL, found.appealPenalty),
          ruling: effectiveRuling(found),
          judge: found.appealJudge ? person(found.appealJudge) : null,
        }
      : null,
    appealDeadline: found.status === "VERDICT" ? found.appealDeadline : null,
    penalty: found.penaltyStatus ? { statusLabel: label(PENALTY_STATUS_LABEL, found.penaltyStatus), note: found.penaltyNote } : null,
  });
});

guildApi.get("/petitions", async (req: Request<{ guildId: string }>, res) => {
  const { petitions, threshold } = await listPetitions(req.params.guildId, req.session.user!.id, 50);
  res.json({
    threshold,
    petitions: petitions.map((p) => ({
      number: p.number,
      title: p.title,
      content: p.content,
      status: p.status,
      statusLabel: label(PETITION_STATUS_LABEL, p.status),
      expiresAt: p.expiresAt,
      createdAt: p.createdAt,
      creator: person(p.creator),
      signatureCount: p.signatureCount,
      signedByMe: p.signedByViewer,
      billNumber: p.bill?.number ?? null,
    })),
  });
});

guildApi.post("/petitions/:number/sign", async (req: Request<{ guildId: string; number: string }>, res) => {
  const result = await signPetition(req.params.guildId, req.session.user!.id, numberParam(req.params.number));
  res.json({ ok: true, signatures: result.signatures, submitted: result.submitted });
});

guildApi.get("/gazette", async (req: Request<{ guildId: string }>, res) => {
  const before = Number(req.query.before);
  const entries = await recentGazette(req.params.guildId, 30, Number.isInteger(before) && before > 0 ? before : undefined);
  res.json({
    entries: entries.map((e) => ({
      number: e.number,
      category: e.category,
      categoryLabel: label(GAZETTE_CATEGORY_LABEL, e.category),
      title: e.title,
      body: e.body,
      linkPath: e.linkPath,
      createdAt: e.createdAt,
    })),
  });
});
