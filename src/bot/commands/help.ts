import { InteractionContextType, SlashCommandBuilder } from "discord.js";
import { prisma } from "../../lib/prisma";
import { CABINET_KEYS, ELECTORAL_KEYS, JUDICIAL_KEYS, PRESIDING_KEYS, type PositionKey } from "../../core/positions";
import { actorFrom } from "../context";
import { COLOR, embed, field, replyEmbed } from "../ui";
import type { BotCommand } from "./types";

interface Section {
  title: string;
  lines: string[];
  /** Holders of any of these positions see the section marked as theirs. */
  holders?: PositionKey[];
  adminOnly?: boolean;
}

const SECTIONS: Section[] = [
  {
    title: "👤 市民（だれでも）",
    lines: [
      "`/citizen register` 市民登録　`/citizen profile` 経歴　`/citizen resign` 辞職　`/citizen leave` 登録抹消",
      "`/gov overview` 政府構成　`/gov positions` 役職一覧　`/gov rules` 国の制度　`/gov gazette` 官報",
      "`/election status | candidacy | withdraw | vote | results` 選挙（投票はWeb）",
      "`/petition create | sign | list | info` 請願",
      "`/court file | respond | appeal | withdraw | list | info` 裁判",
      "`/parliament bill list | info`　`/parliament members` 国会の傍聴",
    ],
  },
  {
    title: "🏛️ 国民代表（議員）",
    holders: ["REPRESENTATIVE"],
    lines: [
      "`/parliament bill submit | vote | withdraw | override` 法案の提出・採決・再議決",
      "`/parliament elect` 議長・副議長・内閣総理大臣の選出",
      "`/parliament no-confidence` 内閣不信任　`/parliament impeach` 弾劾",
      "`/parliament aide appoint | dismiss` 補佐官の任命",
    ],
  },
  {
    title: "🔔 議長・副議長",
    holders: PRESIDING_KEYS,
    lines: ["`/parliament bill open` 採決の開始（議長不在時は議員が行えます）"],
  },
  {
    title: "🎌 内閣",
    holders: CABINET_KEYS,
    lines: [
      "`/cabinet appoint | dismiss` 閣僚・裁判官の任命と罷免（首相）",
      "`/cabinet resign` 内閣総辞職（首相）　`/cabinet statement` 談話（首相・官房長官）",
      "`/cabinet implement` 法律の施行記録　`/parliament bill submit` 内閣提出法案",
    ],
  },
  {
    title: "⚖️ 司法",
    holders: JUDICIAL_KEYS,
    lines: ["`/court assign` 配点（長官）　`/court take` 事件の担当", "`/court verdict` 判決　`/court final-ruling` 上告審の判決"],
  },
  {
    title: "🗳️ 選挙管理委員会",
    holders: ELECTORAL_KEYS,
    lines: ["`/election manage start | advance | cancel` 選挙の告示・進行・中止（管理者も可）"],
  },
  {
    title: "🛡️ 管理者専用（/admin はDiscordの管理者にだけ表示されます）",
    adminOnly: true,
    lines: [
      "`/admin setup` 初期設定　`/admin sync` ロール同期　`/admin diagnose` 診断　`/admin settings` 制度の変更",
      "`/admin appoint | dismiss` 元首・管理官・最高裁判所長官・選挙管理委員の任命／罷免",
      "`/admin bill sanction | veto` 可決法案の裁可・拒否権",
      "`/admin dissolve` 議会の解散　`/admin citizen revoke | restore` 市民権の停止／回復",
    ],
  },
];

export const helpCommand: BotCommand = {
  audience: "public",
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("民主主義Botのコマンド一覧（あなたの役職で使えるものに印がつきます）")
    .setContexts(InteractionContextType.Guild),

  async execute(interaction) {
    const actor = await actorFrom(interaction);
    const positions = await prisma.position.findMany({
      where: { guildId: actor.guildId, endedAt: null, citizen: { discordId: actor.discordId } },
      select: { key: true },
    });
    const held = new Set(positions.map((p) => p.key));
    const body = embed(COLOR.primary, "🏛️ 民主主義Bot コマンド一覧").setDescription(
      "管理者派閥と国民代表派閥が、選挙・国会・内閣・裁判所を通じてサーバーを運営します。✅ はあなたの役職で使えるコマンドです。",
    );
    for (const section of SECTIONS) {
      if (section.adminOnly && !actor.isAdmin) continue;
      const mine = section.adminOnly || section.holders?.some((key) => held.has(key));
      body.addFields(field(`${mine ? "✅ " : ""}${section.title}`, section.lines.join("\n")));
    }
    await replyEmbed(interaction, body, { ephemeral: true });
  },
};
