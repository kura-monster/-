import type { Guild } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { onDomainEvent, type DomainEvent } from "../src/core/events";
import { registerCitizen } from "../src/services/citizen";
import { closeRegistration, standForElection, startElection } from "../src/services/election";
import { ensureGuild } from "../src/services/guild";
import type { Actor } from "../src/services/types";

export const GUILD = "guild-1";
export const LONG_AGO = new Date("2020-01-01T00:00:00Z");

export async function resetDb(): Promise<void> {
  await prisma.$transaction([
    prisma.ballot.deleteMany(),
    prisma.voterRecord.deleteMany(),
    prisma.candidate.deleteMany(),
    prisma.election.deleteMany(),
    prisma.billVote.deleteMany(),
    prisma.bill.deleteMany(),
    prisma.petitionSignature.deleteMany(),
    prisma.petition.deleteMany(),
    prisma.courtCase.deleteMany(),
    prisma.officeVote.deleteMany(),
    prisma.position.deleteMany(),
    prisma.managedRole.deleteMany(),
    prisma.gazetteEntry.deleteMany(),
    prisma.citizen.deleteMany(),
    prisma.counter.deleteMany(),
    prisma.session.deleteMany(),
    prisma.guild.deleteMany(),
  ]);
}

export async function setupGuild(settings: Partial<Omit<Guild, "id" | "name">> = {}): Promise<void> {
  await resetDb();
  await ensureGuild(GUILD, "テスト国");
  if (Object.keys(settings).length > 0) await prisma.guild.update({ where: { id: GUILD }, data: settings });
}

export const discordIdOf = (name: string) => `id-${name}`;

export function actor(name: string, isAdmin = false): Actor {
  return { guildId: GUILD, discordId: discordIdOf(name), displayName: name, isAdmin };
}

export async function register(name: string, now: Date = new Date()) {
  const { citizen } = await registerCitizen(
    GUILD,
    { discordId: discordIdOf(name), displayName: name, avatarUrl: null, accountCreatedAt: LONG_AGO, joinedAt: LONG_AGO },
    now,
  );
  return citizen;
}

/** Seats the given citizens as representatives through a real (unopposed) general election. */
export async function seatRepresentatives(names: string[], now: Date = new Date()) {
  await prisma.guild.update({ where: { id: GUILD }, data: { seats: Math.max(names.length, 1) } });
  for (const name of names) {
    if (!(await prisma.citizen.findUnique({ where: { guildId_discordId: { guildId: GUILD, discordId: discordIdOf(name) } } }))) {
      await register(name, now);
    }
  }
  const election = await startElection(actor("admin", true), { kind: "GENERAL" }, now);
  for (const name of names) await standForElection(actor(name), undefined, now);
  await closeRegistration(GUILD, election.id, now);
}

export async function activeKeys(name: string): Promise<string[]> {
  const positions = await prisma.position.findMany({
    where: { guildId: GUILD, endedAt: null, citizen: { discordId: discordIdOf(name) } },
  });
  return positions.map((p) => p.key).sort();
}

export function recordEvents(): { events: DomainEvent[]; stop: () => void } {
  const events: DomainEvent[] = [];
  const stop = onDomainEvent((event) => {
    events.push(event);
  });
  return { events, stop };
}

/** Lets queued event listeners run. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));

export const minutesLater = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);
export const daysLater = (base: Date, days: number) => new Date(base.getTime() + days * 86_400_000);
