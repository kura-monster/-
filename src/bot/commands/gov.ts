import { InteractionContextType, SlashCommandBuilder } from "discord.js";
import { prisma } from "../../lib/prisma";
import { GAZETTE_CATEGORY_LABEL, type GazetteCategory } from "../../core/constants";
import { BRANCH_LABEL, FACTION_LABEL, POSITION_KEYS, POSITIONS, type PositionKey } from "../../core/positions";
import { roleTag } from "../../core/text";
import { recentGazette } from "../../services/gazette";
import { formatSetting, getGuild, SETTING_FIELDS, type SettingKey } from "../../services/guild";
import { governmentOverview } from "../../services/overview";
import type { PositionWithCitizen } from "../../services/positions";
import { actorFrom } from "../context";
import { COLOR, discordTime, embed, field, joinNames, linkRow, mention, replyEmbed } from "../ui";
import { routeOf, type BotCommand } from "./types";

/** "{`議長`} @alice" — one office and everyone holding it. */
function office(positions: PositionWithCitizen[], key: PositionKey, max = 700): string {
  const holders = positions.filter((p) => p.key === key).map((p) => mention(p.citizen.discordId));
  return `${roleTag(POSITIONS[key].label)} ${joinNames(holders, "空席", max)}`;
}

/** Ministers carry their ministry as the title: "{`外務大臣`} @bob". */
function ministers(positions: PositionWithCitizen[]): string[] {
  const list = positions.filter((p) => p.key === "MINISTER");
  if (list.length === 0) return [`${roleTag(POSITIONS.MINISTER.label)} 空席`];
  return list.map((p) => `${roleTag(p.title)} ${mention(p.citizen.discordId)}`);
}

export const govCommand: BotCommand = {
  audience: "public",
  data: new SlashCommandBuilder()
    .setName("gov")
    .setDescription("国（政府・制度・官報）の情報")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName("overview").setDescription("現在の政府構成（派閥・三権）を表示する"))
    .addSubcommand((s) => s.setName("positions").setDescription("全役職の序列・選ばれ方・権限を表示する"))
    .addSubcommand((s) => s.setName("rules").setDescription("国の制度（議員定数・任期・採決ルールなど）を表示する"))
    .addSubcommand((s) =>
      s
        .setName("gazette")
        .setDescription("官報（すべての公式記録）を表示する")
        .addIntegerOption((o) => o.setName("before").setDescription("この号より前を表示する").setMinValue(2)),
    ),

  async execute(interaction) {
    const actor = await actorFrom(interaction);

    switch (routeOf(interaction)) {
      case "overview": {
        const { guild, positions, citizens, openBills, openCases } = await governmentOverview(actor.guildId);
        const seated = positions.filter((p) => p.key === "REPRESENTATIVE").length;
        const aides = positions.filter((p) => p.key === "AIDE").length;
        const body = embed(COLOR.government, `${guild.name}｜政府構成`)
          .setDescription(`市民 ${citizens}名 ／ 進行中の議案 ${openBills}件 ／ 係属中の事件 ${openCases}件`)
          .addFields(
            field(FACTION_LABEL.ADMIN, [office(positions, "SOVEREIGN"), office(positions, "ADMINISTRATOR")].join("\n")),
            field(
              `${BRANCH_LABEL.LEGISLATIVE}　議席 ${seated}/${guild.seats}`,
              [
                office(positions, "SPEAKER"),
                office(positions, "VICE_SPEAKER"),
                office(positions, "REPRESENTATIVE"),
                `${roleTag(POSITIONS.AIDE.label)} ${aides}名`,
              ].join("\n"),
            ),
            field(
              BRANCH_LABEL.EXECUTIVE,
              [
                office(positions, "PRIME_MINISTER"),
                office(positions, "DEPUTY_PRIME_MINISTER"),
                office(positions, "CHIEF_CABINET_SECRETARY"),
                ...ministers(positions),
              ].join("\n"),
            ),
            field(BRANCH_LABEL.JUDICIAL, [office(positions, "CHIEF_JUSTICE"), office(positions, "JUDGE")].join("\n")),
            field(BRANCH_LABEL.ELECTORAL, [office(positions, "ELECTION_COMMISSIONER"), office(positions, "ELECTION_COMMISSION_MEMBER")].join("\n")),
          );
        await replyEmbed(interaction, body, { components: [linkRow("Webダッシュボード", `/g/${actor.guildId}`)] });
        return;
      }

      case "positions": {
        const body = embed(COLOR.government, "役職一覧（序列順）").setDescription(
          "三権分立（立法・行政・司法）と、管理者派閥・国民代表派閥・独立機関の役職です。",
        );
        for (const key of POSITION_KEYS) {
          const def = POSITIONS[key];
          const faction = FACTION_LABEL[def.faction];
          const branch = BRANCH_LABEL[def.branch];
          body.addFields(
            field(
              `${def.rank}. ${roleTag(def.label)}`,
              [branch === faction ? faction : `${faction}・${branch}`, `選出: ${def.selection}`, ...def.powers.map((p) => `・${p}`)].join("\n"),
            ),
          );
        }
        body.addFields(field(roleTag("市民"), "・選挙権（Web投票）と被選挙権\n・請願と署名\n・裁判の提起"));
        await replyEmbed(interaction, body, { ephemeral: true });
        return;
      }

      case "rules": {
        const guild = await getGuild(prisma, actor.guildId);
        const show = (key: SettingKey) => `${SETTING_FIELDS[key].label}: **${formatSetting(key, guild[key])}**`;
        const body = embed(COLOR.government, `${guild.name}｜国の制度`).addFields(
          field("選挙", [show("seats"), show("termDays"), show("registrationDays"), show("votingDays"), show("autoElection"), "当選には法定得票数（有効票÷定数×1/6）以上が必要。同数はくじ"].join("\n")),
          field(
            "国会",
            [
              show("billVotingDays"),
              "定足数: 在籍議員の3分の1",
              `可決: 賛成が反対より多いこと（同数は${roleTag("議長")}が決裁）`,
              "弾劾・再議決: 出席議員の3分の2以上",
              show("sanctionDays"),
              "期限までに裁可も拒否権もなければ自動成立",
            ].join("\n"),
          ),
          field("市民", [show("minAccountAgeDays"), show("minMembershipDays"), show("petitionThreshold"), show("petitionDays")].join("\n")),
          field("司法", [show("appealHours"), show("enforcePenalties")].join("\n")),
          field("派閥", [show("allowAdminParticipation"), "管理者派閥は /admin で裁可・拒否権・解散などを行えます（すべて官報に記録）"].join("\n")),
        );
        await replyEmbed(interaction, body);
        return;
      }

      case "gazette": {
        const before = interaction.options.getInteger("before") ?? undefined;
        const entries = await recentGazette(actor.guildId, 12, before);
        const body = embed(COLOR.neutral, "官報").setDescription(
          entries.length === 0
            ? "記録はまだありません。"
            : entries
                .map(
                  (e) =>
                    `**第${e.number}号** ${discordTime(e.createdAt, "d")}［${GAZETTE_CATEGORY_LABEL[e.category as GazetteCategory] ?? e.category}］${e.title}`,
                )
                .join("\n"),
        );
        await replyEmbed(interaction, body, { ephemeral: true, components: [linkRow("Webで官報を読む", `/g/${actor.guildId}/gazette`)] });
        return;
      }
    }
  },
};
