import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { emit, type DomainEvent } from "./events";

export type Tx = Prisma.TransactionClient;
export type Db = Tx | typeof prisma;

/** Runs `fn` in a transaction and emits the collected events only once it has committed. */
export async function transact<T>(fn: (tx: Tx, events: DomainEvent[]) => Promise<T>): Promise<T> {
  const events: DomainEvent[] = [];
  const result = await prisma.$transaction((tx) => fn(tx, events), { maxWait: 15_000, timeout: 30_000 });
  for (const event of events) emit(event);
  return result;
}

/** Per-guild sequence (第N号議案, 事件番号, 官報 第N号 ...). */
export async function nextNumber(tx: Tx, guildId: string, kind: string): Promise<number> {
  const counter = await tx.counter.upsert({
    where: { guildId_kind: { guildId, kind } },
    create: { guildId, kind, value: 1 },
    update: { value: { increment: 1 } },
  });
  return counter.value;
}
