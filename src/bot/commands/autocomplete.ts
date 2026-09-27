import type { AutocompleteInteraction } from "discord.js";
import { prisma } from "../../lib/prisma";
import {
  CASE_STATUS_LABEL,
  ELECTION_STATUS_LABEL,
  MINISTRY_SUGGESTIONS,
  PETITION_STATUS_LABEL,
  billStatusLabel,
  type CaseStatus,
  type ElectionStatus,
  type PetitionStatus,
} from "../../core/constants";
import { truncate } from "../../core/text";

type Interaction = AutocompleteInteraction<"cached">;

function focusedText(interaction: Interaction): string {
  return String(interaction.options.getFocused() ?? "").trim();
}

function matches(text: string, number: number, title: string): boolean {
  return !text || String(number).startsWith(text) || title.includes(text);
}

export async function suggestBills(interaction: Interaction, statuses?: string[], kinds?: string[]): Promise<void> {
  const text = focusedText(interaction);
  const bills = await prisma.bill.findMany({
    where: {
      guildId: interaction.guildId,
      ...(statuses ? { status: { in: statuses } } : {}),
      ...(kinds ? { kind: { in: kinds } } : {}),
    },
    orderBy: { number: "desc" },
    take: 100,
  });
  await interaction.respond(
    bills
      .filter((b) => matches(text, b.number, b.title))
      .slice(0, 25)
      .map((b) => ({ name: truncate(`第${b.number}号 ${b.title}（${billStatusLabel(b.status, b.kind)}）`, 100), value: b.number })),
  );
}

export async function suggestCases(interaction: Interaction, statuses?: string[]): Promise<void> {
  const text = focusedText(interaction);
  const cases = await prisma.courtCase.findMany({
    where: { guildId: interaction.guildId, ...(statuses ? { status: { in: statuses } } : {}) },
    orderBy: { number: "desc" },
    take: 100,
  });
  await interaction.respond(
    cases
      .filter((c) => matches(text, c.number, c.title))
      .slice(0, 25)
      .map((c) => ({ name: truncate(`第${c.number}号 ${c.title}（${CASE_STATUS_LABEL[c.status as CaseStatus]}）`, 100), value: c.number })),
  );
}

export async function suggestPetitions(interaction: Interaction, statuses?: string[]): Promise<void> {
  const text = focusedText(interaction);
  const petitions = await prisma.petition.findMany({
    where: { guildId: interaction.guildId, ...(statuses ? { status: { in: statuses } } : {}) },
    orderBy: { number: "desc" },
    take: 100,
  });
  await interaction.respond(
    petitions
      .filter((p) => matches(text, p.number, p.title))
      .slice(0, 25)
      .map((p) => ({ name: truncate(`第${p.number}号 ${p.title}（${PETITION_STATUS_LABEL[p.status as PetitionStatus]}）`, 100), value: p.number })),
  );
}

export async function suggestElections(interaction: Interaction): Promise<void> {
  const text = focusedText(interaction);
  const elections = await prisma.election.findMany({
    where: { guildId: interaction.guildId, status: { in: ["COMPLETED", "CANCELLED"] } },
    orderBy: { number: "desc" },
    take: 100,
  });
  await interaction.respond(
    elections
      .filter((e) => matches(text, e.number, e.title))
      .slice(0, 25)
      .map((e) => ({ name: truncate(`${e.title}（${ELECTION_STATUS_LABEL[e.status as ElectionStatus]}）`, 100), value: e.number })),
  );
}

export async function suggestMinistries(interaction: Interaction): Promise<void> {
  const text = focusedText(interaction);
  const taken = new Set(
    (await prisma.position.findMany({ where: { guildId: interaction.guildId, key: "MINISTER", endedAt: null }, select: { title: true } })).map(
      (p) => p.title,
    ),
  );
  const options = MINISTRY_SUGGESTIONS.filter((m) => !taken.has(m) && (!text || m.includes(text)));
  const typed = text && !options.includes(text) ? [text] : [];
  await interaction.respond([...typed, ...options].slice(0, 25).map((m) => ({ name: truncate(m, 100), value: truncate(m, 100) })));
}

export async function suggestOwnPositions(interaction: Interaction): Promise<void> {
  const positions = await prisma.position.findMany({
    where: { guildId: interaction.guildId, endedAt: null, citizen: { discordId: interaction.user.id } },
    orderBy: { startedAt: "asc" },
  });
  await interaction.respond(positions.slice(0, 25).map((p) => ({ name: truncate(p.title, 100), value: p.id })));
}
