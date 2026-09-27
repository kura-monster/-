import type { Position } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { transact } from "../core/db";
import { DAY } from "../core/time";
import { enactAfterSanctionDeadline } from "./admin";
import { finalizeUnappealedVerdict } from "./court";
import { activeElection, closeRegistration, createElection, finalizeElection } from "./election";
import { publish } from "./gazette";
import { decideBill } from "./parliament";
import { expirePetition } from "./petition";
import { describeEnded, endPosition, type PositionWithCitizen } from "./positions";

async function safely(label: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    console.error(`[scheduler] ${label}`, error);
  }
}

/** Advances every deadline that has passed. Each transition re-checks its state, so running twice is harmless. */
export async function runDueTasks(now: Date = new Date()): Promise<void> {
  for (const e of await prisma.election.findMany({ where: { status: "REGISTRATION", registrationEndsAt: { lte: now } } })) {
    await safely(`election ${e.id} registration`, () => closeRegistration(e.guildId, e.id, now));
  }
  for (const e of await prisma.election.findMany({ where: { status: "VOTING", votingEndsAt: { lte: now } } })) {
    await safely(`election ${e.id} finalize`, () => finalizeElection(e.guildId, e.id, now));
  }
  for (const b of await prisma.bill.findMany({ where: { status: "VOTING", votingEndsAt: { lte: now } } })) {
    await safely(`bill ${b.id} decide`, () => transact((tx, events) => decideBill(tx, events, b.id, now, "採決期限に達したため")));
  }
  for (const b of await prisma.bill.findMany({ where: { status: "PASSED", kind: "ORDINARY", sanctionDeadline: { lte: now } } })) {
    await safely(`bill ${b.id} sanction deadline`, () => enactAfterSanctionDeadline(b.id, now));
  }
  for (const c of await prisma.courtCase.findMany({ where: { status: "VERDICT", appealDeadline: { lte: now } } })) {
    await safely(`case ${c.id} finalize`, () => finalizeUnappealedVerdict(c.id, now));
  }
  for (const p of await prisma.petition.findMany({ where: { status: "OPEN", expiresAt: { lte: now } } })) {
    await safely(`petition ${p.id} expire`, () => expirePetition(p.id, now));
  }
  await safely("term expiry", () => expireTerms(now));
  await safely("auto election", () => callDueElections(now));
  await safely("session cleanup", () => prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }));
}

async function expireTerms(now: Date): Promise<void> {
  const expired = await prisma.position.findMany({ where: { endedAt: null, expiresAt: { lte: now } } });
  const byGuild = new Map<string, Position[]>();
  for (const position of expired) byGuild.set(position.guildId, [...(byGuild.get(position.guildId) ?? []), position]);

  for (const [guildId, positions] of byGuild) {
    await safely(`term expiry ${guildId}`, () =>
      transact(async (tx, events) => {
        const visited = new Set<string>();
        const ended: PositionWithCitizen[] = [];
        for (const position of positions) ended.push(...(await endPosition(tx, events, position.id, "任期満了", now, visited)));
        if (ended.length > 0) {
          await publish(tx, events, guildId, {
            category: "PERSONNEL",
            title: "任期満了",
            body: `次の役職が任期満了により終了しました。\n${describeEnded(ended)}`,
          });
        }
      }),
    );
  }
}

/** Calls a general election so that it is decided right when the sitting representatives' terms run out. */
async function callDueElections(now: Date): Promise<void> {
  const guilds = await prisma.guild.findMany({ where: { autoElection: true } });
  for (const guild of guilds) {
    const lead = (guild.registrationDays + guild.votingDays) * DAY;
    if (guild.termDays * DAY <= lead) continue;
    await safely(`auto election ${guild.id}`, () =>
      transact(async (tx, events) => {
        if (await activeElection(tx, guild.id)) return;
        const first = await tx.position.findFirst({
          where: { guildId: guild.id, key: "REPRESENTATIVE", endedAt: null, expiresAt: { not: null } },
          orderBy: { expiresAt: "asc" },
        });
        const expiresAt = first?.expiresAt;
        if (!expiresAt || expiresAt.getTime() - now.getTime() > lead) return;
        const lastGeneral = await tx.election.findFirst({ where: { guildId: guild.id, kind: "GENERAL" }, orderBy: { createdAt: "desc" } });
        if (lastGeneral && lastGeneral.createdAt.getTime() >= expiresAt.getTime() - lead) return;
        await createElection(
          tx,
          events,
          guild.id,
          { kind: "GENERAL", description: "議員の任期満了に伴う総選挙（自動告示）" },
          now,
          "選挙管理委員会（自動告示）",
        );
      }),
    );
  }
}

export function startScheduler(intervalMs = 60_000): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueTasks();
    } catch (error) {
      console.error("[scheduler]", error);
    } finally {
      running = false;
    }
  };
  void tick();
  return setInterval(() => void tick(), intervalMs);
}
