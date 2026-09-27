import type { Petition } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { nextNumber, transact, type Db, type Tx } from "../core/db";
import { fail } from "../core/errors";
import type { DomainEvent } from "../core/events";
import { MAX_OPEN_PETITIONS_PER_CITIZEN } from "../core/constants";
import { addDays, timeToken } from "../core/time";
import { findCitizen, requireCitizen } from "./citizen";
import { publish } from "./gazette";
import { getGuild } from "./guild";
import { createBill } from "./parliament";
import type { Actor } from "./types";

const petitionLink = (guildId: string) => `/g/${guildId}/petitions`;

export async function findPetition(db: Db, guildId: string, number: number): Promise<Petition> {
  const petition = await db.petition.findUnique({ where: { guildId_number: { guildId, number } } });
  if (!petition) fail(`請願 第${number}号は見つかりません。`);
  return petition;
}

/** Once enough citizens have signed, the petition is submitted to parliament as a bill. */
async function submitIfReady(tx: Tx, events: DomainEvent[], petition: Petition, signerId: string, now: Date): Promise<boolean> {
  const guild = await getGuild(tx, petition.guildId);
  const signatures = await tx.petitionSignature.count({ where: { petitionId: petition.id } });
  if (signatures < guild.petitionThreshold) return false;
  const creator = await tx.citizen.findUnique({ where: { id: petition.creatorId } });
  const bill = await createBill(tx, events, {
    guildId: petition.guildId,
    kind: "ORDINARY",
    origin: "PETITION",
    title: petition.title,
    content: petition.content,
    proposerId: creator?.active ? creator.id : signerId,
    petitionId: petition.id,
    now,
  });
  await tx.petition.update({ where: { id: petition.id }, data: { status: "SUBMITTED", closedAt: now } });
  await publish(tx, events, petition.guildId, {
    category: "PETITION",
    title: `請願 第${petition.number}号 国会へ送付`,
    body: `「${petition.title}」が ${signatures}筆の署名を集め、第${bill.number}号議案として国会に送付されました。`,
    linkPath: `/g/${petition.guildId}/parliament`,
  });
  return true;
}

export async function createPetition(actor: Actor, title: string, content: string, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const citizen = await requireCitizen(tx, actor.guildId, actor.discordId);
    const open = await tx.petition.count({ where: { guildId: actor.guildId, creatorId: citizen.id, status: "OPEN" } });
    if (open >= MAX_OPEN_PETITIONS_PER_CITIZEN) fail(`署名受付中の請願は1人${MAX_OPEN_PETITIONS_PER_CITIZEN}件までです。`);
    const guild = await getGuild(tx, actor.guildId);
    const number = await nextNumber(tx, actor.guildId, "petition");
    const expiresAt = addDays(now, guild.petitionDays);
    const petition = await tx.petition.create({
      data: { guildId: actor.guildId, number, title, content, creatorId: citizen.id, expiresAt, createdAt: now },
    });
    await tx.petitionSignature.create({ data: { petitionId: petition.id, citizenId: citizen.id, signedAt: now } });
    await publish(tx, events, actor.guildId, {
      category: "PETITION",
      title: `請願 第${number}号「${title}」署名受付開始`,
      body: `${citizen.displayName} が請願を提出しました。\n${content}\n${guild.petitionThreshold}筆の署名が集まると国会に送付されます（締切: ${timeToken(expiresAt)}）。/petition sign または Web で署名できます。`,
      linkPath: petitionLink(actor.guildId),
    });
    const submitted = await submitIfReady(tx, events, petition, citizen.id, now);
    return { petition, submitted };
  });
}

export async function signPetition(guildId: string, discordId: string, number: number, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const citizen = await findCitizen(tx, guildId, discordId);
    if (!citizen || !citizen.active) fail("署名するには市民登録が必要です。Discordで /citizen register を実行してください。");
    const petition = await findPetition(tx, guildId, number);
    if (petition.status !== "OPEN" || now >= petition.expiresAt) fail("この請願は署名を受け付けていません。");
    const already = await tx.petitionSignature.findUnique({
      where: { petitionId_citizenId: { petitionId: petition.id, citizenId: citizen.id } },
    });
    if (already) fail("すでに署名済みです。");
    await tx.petitionSignature.create({ data: { petitionId: petition.id, citizenId: citizen.id, signedAt: now } });
    const submitted = await submitIfReady(tx, events, petition, citizen.id, now);
    const signatures = await tx.petitionSignature.count({ where: { petitionId: petition.id } });
    const guild = await getGuild(tx, guildId);
    return { petition, signatures, threshold: guild.petitionThreshold, submitted };
  });
}

export async function expirePetition(petitionId: string, now: Date = new Date()) {
  return transact(async (tx, events) => {
    const petition = await tx.petition.findUnique({ where: { id: petitionId } });
    if (!petition || petition.status !== "OPEN" || petition.expiresAt > now) return null;
    const signatures = await tx.petitionSignature.count({ where: { petitionId } });
    const updated = await tx.petition.update({ where: { id: petitionId }, data: { status: "EXPIRED", closedAt: now } });
    await publish(tx, events, petition.guildId, {
      category: "PETITION",
      title: `請願 第${petition.number}号 期限切れ`,
      body: `「${petition.title}」は署名期間内に必要数に達しませんでした（${signatures}筆）。`,
      linkPath: petitionLink(petition.guildId),
    });
    return updated;
  });
}

export async function listPetitions(guildId: string, viewerDiscordId?: string, take = 20) {
  const viewer = viewerDiscordId ? await findCitizen(prisma, guildId, viewerDiscordId) : null;
  const petitions = await prisma.petition.findMany({
    where: { guildId },
    include: {
      creator: true,
      bill: { select: { number: true, status: true } },
      _count: { select: { signatures: true } },
      signatures: { where: { citizenId: viewer?.id ?? "" }, select: { citizenId: true } },
    },
    orderBy: { number: "desc" },
    take,
  });
  const guild = await getGuild(prisma, guildId);
  const openFirst = (p: Petition) => (p.status === "OPEN" ? 0 : 1);
  return {
    threshold: guild.petitionThreshold,
    petitions: petitions
      .sort((a, b) => openFirst(a) - openFirst(b))
      .map(({ signatures, _count, ...p }) => ({
        ...p,
        signatureCount: _count.signatures,
        signedByViewer: signatures.length > 0,
      })),
  };
}

export async function petitionDetail(guildId: string, number: number) {
  const petition = await prisma.petition.findUnique({
    where: { guildId_number: { guildId, number } },
    include: { creator: true, bill: true, signatures: { include: { citizen: true }, orderBy: { signedAt: "asc" } } },
  });
  if (!petition) return null;
  const guild = await getGuild(prisma, guildId);
  return { petition, threshold: guild.petitionThreshold };
}
