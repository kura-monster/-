import type { GazetteEntry } from "@prisma/client";

/** Side effects that the Discord adapter carries out after a state change has been committed. */
export type DomainEvent =
  | { type: "gazette"; guildId: string; entry: GazetteEntry; threadId?: string | null }
  | { type: "rolesChanged"; guildId: string; discordIds: string[] }
  | { type: "billCreated"; guildId: string; billId: string }
  | { type: "caseFiled"; guildId: string; caseId: string }
  | { type: "threadNotice"; guildId: string; threadId: string | null; title: string; body: string }
  | { type: "electionVotingOpened"; guildId: string; electionId: string }
  | { type: "penaltyDue"; guildId: string; caseId: string };

type Listener = (event: DomainEvent) => void | Promise<void>;

const listeners = new Set<Listener>();

export function onDomainEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emit(event: DomainEvent): void {
  for (const listener of listeners) {
    Promise.resolve()
      .then(() => listener(event))
      .catch((error) => console.error(`[event:${event.type}]`, error));
  }
}
