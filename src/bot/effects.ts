import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type Client,
  type EmbedBuilder,
  type Guild,
  type MessageCreateOptions,
} from "discord.js";
import { prisma } from "../lib/prisma";
import {
  BILL_KIND_LABEL,
  BILL_ORIGIN_LABEL,
  GAZETTE_CATEGORY_LABEL,
  GAZETTE_COLOR,
  MAJORITY_LABEL,
  PENALTY_DURATION_MS,
  PENALTY_LABEL,
  type BillKind,
  type BillOrigin,
  type GazetteCategory,
  type Majority,
  type Penalty,
} from "../core/constants";
import { onDomainEvent, type DomainEvent } from "../core/events";
import { truncate } from "../core/text";
import { effectivePenalty } from "../services/court-rules";
import { recordPenaltyOutcome } from "../services/court";
import { describeDiscordError, syncMember } from "./roles";
import { COLOR, embed, field, linkRow, mention, renderTokens, withRelative } from "./ui";

const queues = new Map<string, Promise<void>>();

/** Discord side effects run one at a time per guild, so gazette posts keep their order. */
function enqueue(guildId: string, task: () => Promise<void>): void {
  const previous = queues.get(guildId) ?? Promise.resolve();
  const next = previous.then(task).catch((error) => console.error(`[discord ${guildId}]`, error));
  queues.set(guildId, next);
}

async function sendTo(client: Client, channelId: string | null | undefined, message: MessageCreateOptions): Promise<void> {
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isSendable()) return;
  await channel.send({ allowedMentions: { parse: [] }, ...message });
}

/** Opens a discussion thread: a forum post in forum channels, or a thread under an announcement message otherwise. */
async function openThread(client: Client, channelId: string | null, name: string, message: MessageCreateOptions): Promise<string | null> {
  if (!channelId) return null;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return null;
  const threadName = truncate(name, 100);
  if (channel.type === ChannelType.GuildForum) {
    const thread = await channel.threads.create({ name: threadName, message });
    return thread.id;
  }
  if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
    const starter = await channel.send(message);
    const thread = await starter.startThread({ name: threadName, autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek });
    return thread.id;
  }
  return null;
}

function gazetteEmbed(entry: { number: number; category: string; title: string; body: string; createdAt: Date }): EmbedBuilder {
  const category = entry.category as GazetteCategory;
  return embed(GAZETTE_COLOR[category] ?? COLOR.neutral, `📜 官報 第${entry.number}号｜${entry.title}`)
    .setDescription(truncate(renderTokens(entry.body), 4000))
    .setFooter({ text: `${GAZETTE_CATEGORY_LABEL[category] ?? entry.category}｜民主主義Bot 官報` })
    .setTimestamp(entry.createdAt);
}

async function handle(client: Client, event: Exclude<DomainEvent, { type: "rolesChanged" }>): Promise<void> {
  const guild = client.guilds.cache.get(event.guildId);
  if (!guild) return;
  const settings = await prisma.guild.findUnique({ where: { id: event.guildId } });
  if (!settings) return;

  switch (event.type) {
    case "gazette": {
      const body = gazetteEmbed(event.entry);
      const components = event.entry.linkPath ? [linkRow("Webで見る", event.entry.linkPath)] : [];
      await sendTo(client, settings.announceChannelId, { embeds: [body], components });
      if (event.threadId) await sendTo(client, event.threadId, { embeds: [body] });
      return;
    }
    case "billCreated": {
      const bill = await prisma.bill.findUnique({ where: { id: event.billId }, include: { proposer: true, target: true } });
      if (!bill || !settings.debateChannelId) return;
      const body = embed(COLOR.parliament, `📋 第${bill.number}号 ${BILL_KIND_LABEL[bill.kind as BillKind]}「${bill.title}」`)
        .setDescription(truncate(bill.content, 3500))
        .addFields(
          field("提出", `${BILL_ORIGIN_LABEL[bill.origin as BillOrigin]}（${mention(bill.proposer.discordId)}）`, true),
          field("可決要件", MAJORITY_LABEL[bill.requiredMajority as Majority], true),
          ...(bill.target ? [field("対象", mention(bill.target.discordId), true)] : []),
          ...(bill.votingEndsAt ? [field("採決締切", withRelative(bill.votingEndsAt))] : []),
        )
        .setFooter({ text: "このスレッドで管理者派閥・国民代表派閥が議論できます" });
      const threadId = await openThread(client, settings.debateChannelId, `第${bill.number}号 ${bill.title}`, {
        embeds: [body],
        components: [linkRow("Webで見る", `/g/${guild.id}/parliament`)],
        allowedMentions: { parse: [] },
      });
      if (threadId) await prisma.bill.update({ where: { id: bill.id }, data: { threadId } });
      return;
    }
    case "caseFiled": {
      const found = await prisma.courtCase.findUnique({ where: { id: event.caseId }, include: { plaintiff: true, defendant: true } });
      if (!found || !settings.courtChannelId) return;
      const body = embed(COLOR.court, `⚖️ 事件 第${found.number}号「${found.title}」`)
        .setDescription(truncate(found.claim, 3500))
        .addFields(field("原告", mention(found.plaintiff.discordId), true), field("被告", mention(found.defendant.discordId), true))
        .setFooter({ text: "被告は /court respond で答弁できます" });
      const threadId = await openThread(client, settings.courtChannelId, `事件${found.number} ${found.title}`, {
        content: `${mention(found.plaintiff.discordId)} ${mention(found.defendant.discordId)}`,
        embeds: [body],
        allowedMentions: { users: [found.plaintiff.discordId, found.defendant.discordId] },
      });
      if (threadId) await prisma.courtCase.update({ where: { id: found.id }, data: { threadId } });
      return;
    }
    case "threadNotice": {
      await sendTo(client, event.threadId, {
        embeds: [embed(COLOR.neutral, event.title).setDescription(truncate(renderTokens(event.body), 4000))],
      });
      return;
    }
    case "electionVotingOpened": {
      const election = await prisma.election.findUnique({ where: { id: event.electionId } });
      if (!election) return;
      const body = embed(COLOR.election, `🗳️ ${election.title} 投票受付中`)
        .setDescription("Webの投票ページからDiscordでログインして投票してください。秘密投票のため、誰が誰に投票したかは記録されません。")
        .addFields(field("投票締切", withRelative(election.votingEndsAt)));
      await sendTo(client, settings.electionChannelId ?? settings.announceChannelId, {
        embeds: [body],
        components: [linkRow("Webで投票する", `/g/${guild.id}/election`)],
      });
      return;
    }
    case "penaltyDue": {
      await executePenalty(guild, event.caseId);
      return;
    }
  }
}

async function executePenalty(guild: Guild, caseId: string): Promise<void> {
  const found = await prisma.courtCase.findUnique({ where: { id: caseId }, include: { defendant: true } });
  if (!found || found.penaltyStatus !== "PENDING") return;
  const penalty = effectivePenalty(found) as Penalty | null;
  const duration = penalty ? PENALTY_DURATION_MS[penalty] : undefined;
  if (!penalty || !duration) {
    await recordPenaltyOutcome(caseId, "SKIPPED", "執行すべき制裁がありません");
    return;
  }
  const member = await guild.members.fetch(found.defendant.discordId).catch(() => null);
  if (!member) {
    await recordPenaltyOutcome(caseId, "FAILED", "対象者がサーバーにいないため執行できませんでした");
    return;
  }
  if (!member.moderatable) {
    await recordPenaltyOutcome(caseId, "FAILED", "Botの権限またはロールの順位が不足しているため執行できませんでした（管理者は対象外です）");
    return;
  }
  try {
    await member.timeout(duration, `民主主義Bot: 事件 第${found.number}号の確定判決`);
    await recordPenaltyOutcome(caseId, "EXECUTED", `${PENALTY_LABEL[penalty]}を執行しました`);
  } catch (error) {
    await recordPenaltyOutcome(caseId, "FAILED", `執行に失敗しました（${describeDiscordError(error)}）`);
  }
}

const pendingRoleSync = new Map<string, Set<string>>();

/** Wires domain events to Discord. Role syncs are coalesced per guild so cascades touch each member once. */
export function attachDiscordEffects(client: Client): () => void {
  return onDomainEvent((event) => {
    if (event.type !== "rolesChanged") {
      enqueue(event.guildId, () => handle(client, event));
      return;
    }
    let pending = pendingRoleSync.get(event.guildId);
    if (!pending) {
      pending = new Set();
      pendingRoleSync.set(event.guildId, pending);
      enqueue(event.guildId, async () => {
        const ids = [...(pendingRoleSync.get(event.guildId) ?? [])];
        pendingRoleSync.delete(event.guildId);
        const guild = client.guilds.cache.get(event.guildId);
        if (!guild) return;
        for (const id of ids) {
          await syncMember(guild, id).catch((error) =>
            console.warn(`[roles ${event.guildId}] ${id}: ${describeDiscordError(error)}`),
          );
        }
      });
    }
    for (const id of event.discordIds) pending.add(id);
  });
}
