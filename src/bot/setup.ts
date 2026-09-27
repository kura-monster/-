import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits,
  type ActionRowBuilder,
  type ButtonBuilder,
  type EmbedBuilder,
  type Guild,
  type GuildTextBasedChannel,
  type OverwriteResolvable,
} from "discord.js";
import { prisma } from "../lib/prisma";
import { DomainError } from "../core/errors";
import { POSITION_KEYS, POSITIONS } from "../core/positions";
import { roleTag } from "../core/text";
import { adminAppoint } from "../services/admin";
import type { ChannelSettings } from "../services/guild";
import { holderOf } from "../services/positions";
import type { Actor } from "../services/types";
import { identityOf } from "./context";
import { describeDiscordError, syncAllMembers } from "./roles";
import { COLOR, embed, field, mention } from "./ui";

const P = PermissionFlagsBits;

export const CATEGORY_NAME = "{民主主義}";

export type ChannelSlot = keyof ChannelSettings;

export interface ChannelPlan {
  slot: ChannelSlot;
  name: string;
  topic: string;
  overwrites: OverwriteResolvable[];
}

/**
 * Members may read (as far as the server's own settings allow) but not post; the bot always may.
 * Discord only lets a bot allow or deny permissions it holds itself, so these stay within what the invite grants
 * (a private thread nobody can post in is harmless, so CreatePrivateThreads is left alone).
 */
const NO_POSTING = [P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads];
const BOT_NEEDS = [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory, P.CreatePublicThreads, P.SendMessagesInThreads, P.ManageThreads];

/** Everything the auto setup needs, named as in Discord's Japanese settings screen. */
const AUTOSETUP_PERMISSIONS: [bigint, string][] = [
  [P.ManageChannels, "チャンネルの管理"],
  [P.ManageRoles, "ロールの管理"],
  [P.ViewChannel, "チャンネルを見る"],
  [P.SendMessages, "メッセージを送信"],
  [P.EmbedLinks, "埋め込みリンク"],
  [P.ReadMessageHistory, "メッセージ履歴を読む"],
  [P.CreatePublicThreads, "公開スレッドの作成"],
  [P.SendMessagesInThreads, "スレッドでメッセージを送信"],
  [P.ManageThreads, "スレッドの管理"],
];

/** The permissions the bot lacks for the auto setup, by their Japanese names. */
export function missingForAutoSetup(permissions: { has(bit: bigint): boolean }): string[] {
  return AUTOSETUP_PERMISSIONS.filter(([bit]) => !permissions.has(bit)).map(([, label]) => label);
}

/** Roles that speak in parliament: the admin faction and the representatives' faction (not the neutral judiciary or election commission). */
export const DEBATER_KEYS = POSITION_KEYS.filter((key) => POSITIONS[key].faction !== "NEUTRAL");

/**
 * The channels the auto setup creates. Reading is left to the server's own settings (so servers that hide channels
 * from unverified members keep doing so); only posting is limited to the bot and, in threads, to the roles concerned.
 */
export function planChannels(ids: { everyone: string; bot: string; citizen?: string; debaters: string[] }): ChannelPlan[] {
  const readOnly: OverwriteResolvable[] = [
    { id: ids.everyone, type: OverwriteType.Role, deny: NO_POSTING },
    { id: ids.bot, type: OverwriteType.Member, allow: BOT_NEEDS },
  ];
  const mayPostInThreads = (roleIds: string[]): OverwriteResolvable[] =>
    roleIds.map((id) => ({ id, type: OverwriteType.Role, allow: [P.SendMessagesInThreads] }));
  return [
    {
      slot: "announceChannelId",
      name: "官報",
      topic: "国の公式記録。選挙・人事・立法・司法・管理者の操作がすべて番号つきで掲載されます。",
      overwrites: readOnly,
    },
    {
      slot: "debateChannelId",
      name: "議事堂",
      topic: "法案ごとに議論スレッドが作られます。スレッドで発言できるのは管理者派閥と国民代表派閥の役職者です（市民は傍聴）。",
      overwrites: [...readOnly, ...mayPostInThreads(ids.debaters)],
    },
    {
      slot: "courtChannelId",
      name: "裁判所",
      topic: "事件ごとに審理スレッドが作られます。スレッドでは市民が発言できます。",
      overwrites: [...readOnly, ...mayPostInThreads(ids.citizen ? [ids.citizen] : [])],
    },
    {
      slot: "electionChannelId",
      name: "選挙",
      topic: "選挙の告示と投票開始のお知らせ。投票は Web ダッシュボードで行います。",
      overwrites: readOnly,
    },
  ];
}

export type ChannelOutcome = { plan: ChannelPlan; channelId: string | null; status: "created" | "existing" | "failed"; error?: string };

/**
 * Makes sure every slot has a channel: one already configured is kept, one left over from an earlier auto setup
 * (same name in the category) is reused, and the rest are created in the category.
 */
export async function ensureCountryChannels(guild: Guild, configured: ChannelSettings, plans: ChannelPlan[]) {
  const isCategory = (c: { type: ChannelType; name: string }) => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME;
  let category = guild.channels.cache.find(isCategory) ?? null;
  let categoryCreated = false;
  const outcomes: ChannelOutcome[] = [];
  for (const plan of plans) {
    const current = configured[plan.slot];
    const leftover = category
      ? guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.parentId === category?.id && c.name === plan.name)
      : undefined;
    const keep = current && guild.channels.cache.has(current) ? current : leftover?.id;
    if (keep) {
      outcomes.push({ plan, channelId: keep, status: "existing" });
      continue;
    }
    try {
      if (!category) {
        category = await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory, reason: "民主主義Bot: オートセットアップ" });
        categoryCreated = true;
      }
      const channel = await guild.channels.create({
        name: plan.name,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: plan.topic,
        permissionOverwrites: plan.overwrites,
        reason: "民主主義Bot: オートセットアップ",
      });
      outcomes.push({ plan, channelId: channel.id, status: "created" });
    } catch (error) {
      outcomes.push({ plan, channelId: null, status: "failed", error: describeDiscordError(error) });
    }
  }
  return { category: category?.id ?? null, categoryCreated, outcomes };
}

/** Appoints the server owner as head of state unless someone already holds the office. */
export async function appointOwnerAsSovereign(guild: Guild, actor: Actor): Promise<string> {
  const current = await holderOf(prisma, actor.guildId, "SOVEREIGN");
  if (current) return `${mention(current.citizen.discordId)}（在任中）`;
  const owner = await guild.fetchOwner();
  try {
    await adminAppoint(actor, "SOVEREIGN", { ...identityOf(owner.user, owner), isDiscordAdmin: true });
    return `サーバーオーナー ${mention(owner.id)} を ${roleTag("元首")} に任命しました`;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return `未任命（${error.message}）`;
  }
}

export async function syncRolesReport(guild: Guild): Promise<string> {
  const sync = await syncAllMembers(guild).catch((error: unknown) => ({
    synced: 0,
    errors: [`メンバー一覧を取得できませんでした（Developer Portal で SERVER MEMBERS INTENT を有効にしてください）: ${String(error)}`],
  }));
  return [`${sync.synced}名を同期`, ...sync.errors.map((e) => `\`失敗\` ${e}`)].join("\n");
}

/** The first post in a freshly created 官報 channel: how to take part, without anyone having to explain it. */
export function welcomeEmbed(guild: Guild, channels: ChannelSettings): EmbedBuilder {
  const at = (id: string | undefined) => (id ? `<#${id}>` : "");
  return embed(COLOR.primary, `${guild.name}｜はじめに`)
    .setDescription("このサーバーは、選挙・国会・内閣・裁判所をもつ「国」として民主主義で運営されます。")
    .addFields(
      field("1. 市民になる", `\`/citizen register\` で市民登録すると ${roleTag("市民")} になり、投票・立候補・請願・提訴ができます。`),
      field("2. 選挙", `立候補は \`/election candidacy\`、投票は Web ダッシュボードで行います（秘密投票）。お知らせは ${at(channels.electionChannelId)}`),
      field("3. 国会", `法案は ${at(channels.debateChannelId)} のスレッドで議論されます。議員は \`/parliament\` で法案の提出・採決を行います。`),
      field("4. 裁判所", `\`/court file\` で提訴できます。審理は ${at(channels.courtChannelId)} のスレッドで行われます。`),
      field("5. 請願", "`/petition create` で請願を始め、必要な署名が集まると法案として国会に送られます。"),
      field("記録とコマンド", `すべての公式行為はこのチャンネル（官報）に掲載されます。使えるコマンドは \`/help\` で確認できます。`),
    );
}

/** Posts the welcome message and says how it went; a failure here does not undo the setup. */
export async function postWelcome(channel: GuildTextBasedChannel, body: EmbedBuilder, components: ActionRowBuilder<ButtonBuilder>[]): Promise<string> {
  try {
    await channel.send({ embeds: [body], components, allowedMentions: { parse: [] } });
    return `${channel} に投稿しました`;
  } catch (error) {
    return `\`失敗\` ${describeDiscordError(error)}`;
  }
}

export function channelSettingsOf(guild: { [K in ChannelSlot]: string | null }): ChannelSettings {
  return {
    announceChannelId: guild.announceChannelId ?? undefined,
    debateChannelId: guild.debateChannelId ?? undefined,
    courtChannelId: guild.courtChannelId ?? undefined,
    electionChannelId: guild.electionChannelId ?? undefined,
  };
}
