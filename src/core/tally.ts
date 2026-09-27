import crypto from "node:crypto";
import type { Majority } from "./constants";

export function secureRandom(): number {
  return crypto.randomInt(0, 2 ** 32) / 2 ** 32;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** 法定得票数: 有効投票総数 ÷ 定数 × 1/6. Winning also always requires at least one vote. */
export function legalMinimumVotes(totalVotes: number, seats: number): number {
  return Math.max(1, totalVotes / seats / 6);
}

export interface WinnerDecision {
  winners: string[];
  lotteryUsed: boolean;
  tiedAtCutoff: string[];
  minVotes: number;
  unfilledSeats: number;
}

/** Ranks candidates by votes; a tie for the last seat is settled by lot (くじ), as in Japanese election law. */
export function decideWinners(
  candidates: { id: string; votes: number }[],
  seats: number,
  random: () => number = secureRandom,
): WinnerDecision {
  const totalVotes = candidates.reduce((sum, c) => sum + c.votes, 0);
  const minVotes = legalMinimumVotes(totalVotes, seats);
  const qualified = candidates.filter((c) => c.votes >= minVotes).sort((a, b) => b.votes - a.votes);

  if (qualified.length <= seats) {
    return { winners: qualified.map((c) => c.id), lotteryUsed: false, tiedAtCutoff: [], minVotes, unfilledSeats: seats - qualified.length };
  }

  const cutoff = qualified[seats - 1].votes;
  const above = qualified.filter((c) => c.votes > cutoff);
  const tied = qualified.filter((c) => c.votes === cutoff);
  const remaining = seats - above.length;
  if (tied.length === remaining) {
    return { winners: [...above, ...tied].map((c) => c.id), lotteryUsed: false, tiedAtCutoff: [], minVotes, unfilledSeats: 0 };
  }
  const drawn = shuffle(tied, random).slice(0, remaining);
  return {
    winners: [...above, ...drawn].map((c) => c.id),
    lotteryUsed: true,
    tiedAtCutoff: tied.map((c) => c.id),
    minVotes,
    unfilledSeats: 0,
  };
}

export interface BillTally {
  for: number;
  against: number;
  abstain: number;
  participants: number;
  seated: number;
  quorum: number;
  quorumMet: boolean;
  passed: boolean;
  /** Set when FOR and AGAINST tie and the Speaker's vote decided the outcome (可否同数の議長決裁). */
  tieBreak: "SPEAKER_FOR" | "SPEAKER_AGAINST" | "NO_SPEAKER_VOTE" | null;
}

/**
 * Quorum is one third of seated members (abstentions count as present).
 * MAJORITY: more FOR than AGAINST. TWO_THIRDS: FOR is at least 2/3 of members present.
 */
export function tallyVotes(
  votes: { citizenId: string; choice: string }[],
  seated: number,
  rule: Majority,
  speakerCitizenId?: string | null,
): BillTally {
  let forVotes = 0;
  let against = 0;
  let abstain = 0;
  for (const vote of votes) {
    if (vote.choice === "FOR") forVotes++;
    else if (vote.choice === "AGAINST") against++;
    else abstain++;
  }
  const participants = forVotes + against + abstain;
  const quorum = Math.max(1, Math.ceil(seated / 3));
  const quorumMet = seated > 0 && participants >= quorum;

  let passed = false;
  let tieBreak: BillTally["tieBreak"] = null;
  if (quorumMet) {
    if (rule === "TWO_THIRDS") {
      passed = forVotes > 0 && forVotes * 3 >= participants * 2;
    } else if (forVotes > against) {
      passed = true;
    } else if (forVotes === against && forVotes > 0) {
      const speakerChoice = speakerCitizenId ? votes.find((v) => v.citizenId === speakerCitizenId)?.choice : undefined;
      if (speakerChoice === "FOR") {
        passed = true;
        tieBreak = "SPEAKER_FOR";
      } else {
        tieBreak = speakerChoice === "AGAINST" ? "SPEAKER_AGAINST" : "NO_SPEAKER_VOTE";
      }
    }
  }
  return { for: forVotes, against, abstain, participants, seated, quorum, quorumMet, passed, tieBreak };
}

export function describeTally(t: BillTally): string {
  return `賛成 ${t.for} ／ 反対 ${t.against} ／ 棄権 ${t.abstain}（在籍 ${t.seated}名・定足数 ${t.quorum}名）`;
}

export function officeMajority(seated: number): number {
  return Math.floor(seated / 2) + 1;
}
