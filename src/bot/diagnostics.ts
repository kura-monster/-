import { ChannelType, PermissionFlagsBits, type Guild } from "discord.js";
import { prisma } from "../lib/prisma";
import { config } from "../config";
import { MANAGED_KEYS } from "./roles";

const P = PermissionFlagsBits;

/** Human-readable checklist of everything the bot needs to work in this guild. */
export async function diagnose(guild: Guild): Promise<string[]> {
  const me = await guild.members.fetchMe();
  const settings = await prisma.guild.findUnique({ where: { id: guild.id } });
  const lines: string[] = [];
  const check = (ok: boolean, label: string, problem: string) => lines.push(ok ? `✅ ${label}` : `⚠️ ${label} — ${problem}`);

  check(me.permissions.has(P.ManageRoles), "ロールの管理", "役職ロールを付与できません");
  check(me.permissions.has(P.ModerateMembers), "メンバーのタイムアウト", "判決（タイムアウト）を執行できません");
  const grantable = [P.ManageEvents, P.PrioritySpeaker, P.MentionEveryone, P.ManageThreads];
  check(
    grantable.every((bit) => me.permissions.has(bit)),
    "役職ロールへ付与する権限",
    "Botが持たない権限は役職ロールに付与されません",
  );

  const managed = await prisma.managedRole.findMany({ where: { guildId: guild.id } });
  const roles = managed.map((r) => guild.roles.cache.get(r.roleId)).filter((r) => r !== undefined);
  check(roles.length === MANAGED_KEYS.length, `役職ロール（${roles.length}/${MANAGED_KEYS.length}）`, "`/admin sync` で作成してください");
  const above = roles.filter((role) => role.comparePositionTo(me.roles.highest) >= 0);
  check(
    above.length === 0,
    "ロールの順位",
    `Botのロールより上にある役職ロールを付与できません: ${above.map((r) => r.name).join("、")}（サーバー設定でBotのロールを上に移動してください）`,
  );

  const channels: [string, string | null | undefined, boolean][] = [
    ["官報チャンネル", settings?.announceChannelId, false],
    ["議事堂（法案スレッド）", settings?.debateChannelId, true],
    ["裁判所（事件スレッド）", settings?.courtChannelId, true],
    ["選挙チャンネル", settings?.electionChannelId, false],
  ];
  for (const [label, channelId, threads] of channels) {
    if (!channelId) {
      lines.push(`➖ ${label}: 未設定`);
      continue;
    }
    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      check(false, label, "チャンネルが見つかりません（削除された可能性があります）");
      continue;
    }
    const permissions = channel.permissionsFor(me);
    const needed = [P.ViewChannel, P.SendMessages, P.EmbedLinks];
    if (threads) needed.push(P.SendMessagesInThreads);
    if (threads && channel.type === ChannelType.GuildText) needed.push(P.CreatePublicThreads);
    check(needed.every((bit) => permissions?.has(bit)), `${label}（<#${channelId}>）`, "Botの送信・スレッド作成権限が不足しています");
  }

  check(Boolean(config.clientSecret), "Webログイン（DISCORD_CLIENT_SECRET）", "未設定のためWeb投票にログインできません");
  lines.push(`ℹ️ Webダッシュボード: ${config.webBaseUrl}`);
  return lines;
}
