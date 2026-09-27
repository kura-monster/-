import type { CourtCase } from "@prisma/client";

type Ruling = Pick<CourtCase, "result" | "penalty" | "ruling" | "appealResult" | "appealPenalty" | "appealRuling">;

/** The Supreme Court ruling replaces the first-instance one when an appeal was decided. */
export function effectiveResult(c: Ruling): string | null {
  return c.appealResult ?? c.result;
}

export function effectivePenalty(c: Ruling): string | null {
  return c.appealResult ? c.appealPenalty : c.penalty;
}

export function effectiveRuling(c: Ruling): string | null {
  return c.appealResult ? c.appealRuling : c.ruling;
}
