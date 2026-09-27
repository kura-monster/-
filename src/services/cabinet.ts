import type { Citizen } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { transact, type Db } from "../core/db";
import { fail } from "../core/errors";
import { CABINET_KEYS, POSITIONS, type PositionKey } from "../core/positions";
import { cleanText } from "../core/text";
import { findCitizen, requireCitizen, requireTargetCitizen } from "./citizen";
import { publish } from "./gazette";
import { findBill } from "./parliament";
import { activePositions, appoint, describeEnded, endPosition, holderOf, holds } from "./positions";
import type { Actor } from "./types";

export const CABINET_APPOINTABLE = ["DEPUTY_PRIME_MINISTER", "CHIEF_CABINET_SECRETARY", "MINISTER", "JUDGE"] as const;
export type CabinetAppointable = (typeof CABINET_APPOINTABLE)[number];
export const CABINET_DISMISSABLE = ["DEPUTY_PRIME_MINISTER", "CHIEF_CABINET_SECRETARY", "MINISTER"] as const;
export type CabinetDismissable = (typeof CABINET_DISMISSABLE)[number];

async function requirePrimeMinister(db: Db, actor: Actor): Promise<Citizen> {
  const citizen = await requireCitizen(db, actor.guildId, actor.discordId);
  if (!(await holds(db, actor.guildId, citizen.id, "PRIME_MINISTER"))) fail("このコマンドは内閣総理大臣のみ使用できます。");
  return citizen;
}

/** "外務" → "外務大臣" so ministries read naturally whatever the PM typed. */
export function normalizeMinistryTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) fail("大臣の担当分野（例: 外務大臣）を指定してください。");
  return trimmed.endsWith("大臣") ? trimmed : `${trimmed}大臣`;
}

export async function cabinetAppoint(
  actor: Actor,
  key: CabinetAppointable,
  target: { discordId: string; isDiscordAdmin: boolean },
  title: string | undefined,
  now: Date = new Date(),
) {
  if (!CABINET_APPOINTABLE.includes(key)) fail("内閣が任命できる役職ではありません。");
  return transact(async (tx, events) => {
    const pm = await requirePrimeMinister(tx, actor);
    const citizen = await requireTargetCitizen(tx, actor.guildId, target.discordId);
    const positionTitle = key === "MINISTER" ? normalizeMinistryTitle(title ?? "") : POSITIONS[key].label;
    const position = await appoint(tx, events, {
      guildId: actor.guildId,
      citizenId: citizen.id,
      key,
      title: positionTitle,
      source: "APPOINTMENT",
      appointedById: pm.id,
      targetIsDiscordAdmin: target.isDiscordAdmin,
      now,
    });
    await publish(tx, events, actor.guildId, {
      category: key === "JUDGE" ? "JUDICIARY" : "CABINET",
      title: `${positionTitle}の任命: ${citizen.displayName}`,
      body: `内閣総理大臣 ${pm.displayName} が ${citizen.displayName} を${positionTitle}に任命しました。`,
      linkPath: `/g/${actor.guildId}`,
    });
    return position;
  });
}

export async function cabinetDismiss(actor: Actor, targetDiscordId: string, key: CabinetDismissable, now: Date = new Date()) {
  if (!CABINET_DISMISSABLE.includes(key)) fail("内閣総理大臣が罷免できるのは閣僚のみです（裁判官の罷免は国会の弾劾によります）。");
  return transact(async (tx, events) => {
    const pm = await requirePrimeMinister(tx, actor);
    const citizen = await requireTargetCitizen(tx, actor.guildId, targetDiscordId);
    const position = await tx.position.findFirst({ where: { guildId: actor.guildId, citizenId: citizen.id, key, endedAt: null } });
    if (!position) fail(`${citizen.displayName} さんは${POSITIONS[key].label}ではありません。`);
    await endPosition(tx, events, position.id, "内閣総理大臣による罷免", now);
    await publish(tx, events, actor.guildId, {
      category: "CABINET",
      title: `${position.title}の罷免: ${citizen.displayName}`,
      body: `内閣総理大臣 ${pm.displayName} が ${citizen.displayName} を${position.title}から罷免しました。`,
    });
    return position;
  });
}

export async function cabinetResign(actor: Actor, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const pm = await requirePrimeMinister(tx, actor);
    const position = await holderOf(tx, actor.guildId, "PRIME_MINISTER");
    if (!position) fail("内閣総理大臣が不在です。");
    const ended = await endPosition(tx, events, position.id, "内閣総辞職", now);
    await publish(tx, events, actor.guildId, {
      category: "CABINET",
      title: `${pm.displayName}内閣 総辞職`,
      body: `内閣総理大臣 ${pm.displayName} が内閣総辞職を表明しました。\n${describeEnded(ended)}\n国会は /parliament elect で新しい内閣総理大臣を指名してください。`,
    });
    return ended;
  });
}

export async function issueStatement(actor: Actor, title: string, content: string) {
  return transact(async (tx, events) => {
    const citizen = await requireCitizen(tx, actor.guildId, actor.discordId);
    const office = (await activePositions(tx, actor.guildId, { citizenId: citizen.id })).find(
      (p) => p.key === "PRIME_MINISTER" || p.key === "CHIEF_CABINET_SECRETARY",
    );
    if (!office) fail("談話を発表できるのは内閣総理大臣と内閣官房長官です。");
    const speaker = office.key === "PRIME_MINISTER" ? "内閣総理大臣談話" : "内閣官房長官談話";
    return publish(tx, events, actor.guildId, {
      category: "CABINET",
      title: `${speaker}「${title}」`,
      body: `${content}\n\n${office.title} ${citizen.displayName}`,
    });
  });
}

export async function implementLaw(actor: Actor, number: number, note: string | undefined) {
  return transact(async (tx, events) => {
    const citizen = await findCitizen(tx, actor.guildId, actor.discordId);
    const inCabinet = citizen?.active ? await holds(tx, actor.guildId, citizen.id, CABINET_KEYS) : false;
    if (!inCabinet && !actor.isAdmin) fail("法律の施行を記録できるのは閣僚または管理者です。");
    const bill = await findBill(tx, actor.guildId, number);
    if (bill.status !== "ENACTED") fail(`第${number}号議案は成立済みの法律ではありません。`);
    const text = cleanText(note) ?? null;
    const updated = await tx.bill.update({ where: { id: bill.id }, data: { status: "IMPLEMENTED", implementedNote: text } });
    await publish(tx, events, actor.guildId, {
      category: "LEGISLATION",
      title: `第${number}号「${bill.title}」施行`,
      body: `${inCabinet ? "内閣" : "管理者"}（${actor.displayName}）が法律の施行を記録しました。${text ? `\n${text}` : ""}`,
      threadId: bill.threadId,
      linkPath: `/g/${actor.guildId}/parliament`,
    });
    return updated;
  });
}

export async function cabinetRoster(guildId: string) {
  const members = await activePositions(prisma, guildId, { keys: CABINET_KEYS as PositionKey[] });
  const judges = await activePositions(prisma, guildId, { keys: ["CHIEF_JUSTICE", "JUDGE"] });
  return { members, judges };
}
