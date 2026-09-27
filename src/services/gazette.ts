import type { GazetteEntry } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { nextNumber, type Tx } from "../core/db";
import type { DomainEvent } from "../core/events";
import type { GazetteCategory } from "../core/constants";
import { truncate } from "../core/text";

export interface GazetteInput {
  category: GazetteCategory;
  title: string;
  body: string;
  linkPath?: string;
  /** Also post the entry into this discussion thread (bill / case). */
  threadId?: string | null;
}

export async function publish(tx: Tx, events: DomainEvent[], guildId: string, input: GazetteInput): Promise<GazetteEntry> {
  const number = await nextNumber(tx, guildId, "gazette");
  const entry = await tx.gazetteEntry.create({
    data: {
      guildId,
      number,
      category: input.category,
      title: truncate(input.title, 200),
      body: truncate(input.body, 3500),
      linkPath: input.linkPath,
    },
  });
  events.push({ type: "gazette", guildId, entry, threadId: input.threadId ?? null });
  return entry;
}

export async function recentGazette(guildId: string, limit = 10, beforeNumber?: number): Promise<GazetteEntry[]> {
  return prisma.gazetteEntry.findMany({
    where: { guildId, ...(beforeNumber ? { number: { lt: beforeNumber } } : {}) },
    orderBy: { number: "desc" },
    take: limit,
  });
}
