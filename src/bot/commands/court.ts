import { InteractionContextType, SlashCommandBuilder, type SlashCommandSubcommandBuilder } from "discord.js";
import { fail } from "../../core/errors";
import {
  CASE_RESULT_LABEL,
  CASE_STATUS_LABEL,
  PENALTY_LABEL,
  PENALTY_STATUS_LABEL,
  type CaseResult,
  type CaseStatus,
  type Penalty,
  type PenaltyStatus,
} from "../../core/constants";
import { roleTag, truncate } from "../../core/text";
import {
  appealCase,
  assignJudge,
  caseDetail,
  fileCase,
  issueFinalRuling,
  issueVerdict,
  listCases,
  respondToCase,
  takeCase,
  withdrawCase,
  type CaseFilter,
} from "../../services/court";
import { actorFrom, targetOf } from "../context";
import { COLOR, discordTime, embed, field, linkRow, mention, replyEmbed, withRelative } from "../ui";
import { suggestCases } from "./autocomplete";
import { routeOf, type BotCommand } from "./types";

const RESULT_CHOICES = (Object.keys(CASE_RESULT_LABEL) as CaseResult[]).map((value) => ({ name: CASE_RESULT_LABEL[value], value }));
const PENALTY_CHOICES = (Object.keys(PENALTY_LABEL) as Penalty[]).map((value) => ({ name: PENALTY_LABEL[value], value }));

function withCase(s: SlashCommandSubcommandBuilder, description: string): SlashCommandSubcommandBuilder {
  return s.addIntegerOption((o) => o.setName("case").setDescription(description).setRequired(true).setAutocomplete(true).setMinValue(1));
}

function withRuling(s: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  return s
    .addStringOption((o) => o.setName("result").setDescription("主文").setRequired(true).addChoices(...RESULT_CHOICES))
    .addStringOption((o) => o.setName("ruling").setDescription("判決理由").setRequired(true).setMaxLength(1500))
    .addStringOption((o) => o.setName("penalty").setDescription("制裁（原告勝訴のときのみ／既定: なし）").addChoices(...PENALTY_CHOICES));
}

export const courtCommand: BotCommand = {
  audience: "public",
  data: new SlashCommandBuilder()
    .setName("court")
    .setDescription("裁判所（提訴・審理・判決・上告）")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName("file")
        .setDescription("訴えを提起する")
        .addUserOption((o) => o.setName("defendant").setDescription("被告").setRequired(true))
        .addStringOption((o) => o.setName("title").setDescription("事件名").setRequired(true).setMaxLength(80))
        .addStringOption((o) => o.setName("claim").setDescription("訴えの内容").setRequired(true).setMaxLength(1500)),
    )
    .addSubcommand((s) =>
      withCase(s.setName("respond").setDescription("答弁書を提出する（被告）"), "自分が被告の事件").addStringOption((o) =>
        o.setName("statement").setDescription("答弁").setRequired(true).setMaxLength(1500),
      ),
    )
    .addSubcommand((s) =>
      withCase(s.setName("assign").setDescription("担当裁判官を指定する（最高裁判所長官）"), "配点する事件").addUserOption((o) =>
        o.setName("judge").setDescription("担当させる裁判官").setRequired(true),
      ),
    )
    .addSubcommand((s) => withCase(s.setName("take").setDescription("未配点の事件を担当する（裁判官）"), "担当する事件"))
    .addSubcommand((s) => withRuling(withCase(s.setName("verdict").setDescription("判決を言い渡す（担当裁判官）"), "審理中の事件")))
    .addSubcommand((s) =>
      withCase(s.setName("appeal").setDescription("判決に対して上告する（当事者・上告期間内）"), "判決が出た事件").addStringOption((o) =>
        o.setName("reason").setDescription("上告の理由").setRequired(true).setMaxLength(1000),
      ),
    )
    .addSubcommand((s) =>
      withRuling(withCase(s.setName("final-ruling").setDescription("上告審の判決を言い渡す（最高裁判所長官）"), "上告された事件")),
    )
    .addSubcommand((s) => withCase(s.setName("withdraw").setDescription("訴えを取り下げる（原告・判決前）"), "自分が原告の事件"))
    .addSubcommand((s) =>
      s
        .setName("list")
        .setDescription("事件の一覧を表示する")
        .addStringOption((o) =>
          o
            .setName("filter")
            .setDescription("表示する範囲")
            .addChoices({ name: "係属中", value: "open" }, { name: "終結", value: "closed" }, { name: "すべて", value: "all" }),
        ),
    )
    .addSubcommand((s) => withCase(s.setName("info").setDescription("事件の詳細を表示する"), "事件")),

  async execute(interaction) {
    const actor = await actorFrom(interaction);
    const courtPath = `/g/${actor.guildId}/court`;
    const caseNumber = () => interaction.options.getInteger("case", true);
    const ruling = () => ({
      result: interaction.options.getString("result", true) as CaseResult,
      ruling: interaction.options.getString("ruling", true),
      penalty: (interaction.options.getString("penalty") ?? "NONE") as Penalty,
    });

    switch (routeOf(interaction)) {
      case "file": {
        const defendant = targetOf(interaction, "defendant");
        const filed = await fileCase(actor, defendant.user.id, interaction.options.getString("title", true), interaction.options.getString("claim", true));
        await replyEmbed(
          interaction,
          embed(COLOR.court, `事件 第${filed.number}号「${filed.title}」受理`)
            .setDescription(truncate(filed.claim, 3000))
            .addFields(field("原告", mention(actor.discordId), true), field("被告", mention(defendant.user.id), true))
            .setFooter({ text: "最高裁判所長官の配点、または裁判官の担当を待っています" }),
        );
        return;
      }

      case "respond": {
        const updated = await respondToCase(actor, caseNumber(), interaction.options.getString("statement", true));
        await replyEmbed(interaction, embed(COLOR.court, `事件 第${updated.number}号｜答弁書`).setDescription(truncate(updated.defense ?? "", 3000)));
        return;
      }

      case "assign": {
        const judge = targetOf(interaction, "judge");
        const updated = await assignJudge(actor, caseNumber(), judge.user.id);
        await replyEmbed(interaction, embed(COLOR.court, `事件 第${updated.number}号｜配点`).setDescription(`担当: ${roleTag("裁判官")} ${mention(judge.user.id)}`));
        return;
      }

      case "take": {
        const updated = await takeCase(actor, caseNumber());
        await replyEmbed(interaction, embed(COLOR.court, `事件 第${updated.number}号｜担当`).setDescription(`${roleTag("裁判官")} ${mention(actor.discordId)} が担当として審理を開始しました。`));
        return;
      }

      case "verdict": {
        const input = ruling();
        const updated = await issueVerdict(actor, caseNumber(), input);
        await replyEmbed(
          interaction,
          embed(COLOR.court, `事件 第${updated.number}号｜判決`)
            .setDescription(truncate(input.ruling, 3000))
            .addFields(
              field("主文", CASE_RESULT_LABEL[input.result], true),
              field("制裁", PENALTY_LABEL[input.penalty], true),
              field("上告期限", updated.appealDeadline ? withRelative(updated.appealDeadline) : "—"),
            ),
        );
        return;
      }

      case "appeal": {
        const updated = await appealCase(actor, caseNumber(), interaction.options.getString("reason", true));
        await replyEmbed(interaction, embed(COLOR.court, `事件 第${updated.number}号｜上告`).setDescription(`理由: ${updated.appealReason}`));
        return;
      }

      case "final-ruling": {
        const input = ruling();
        const updated = await issueFinalRuling(actor, caseNumber(), input);
        await replyEmbed(
          interaction,
          embed(COLOR.court, `事件 第${updated.number}号｜上告審判決（確定）`)
            .setDescription(truncate(input.ruling, 3000))
            .addFields(field("主文", CASE_RESULT_LABEL[input.result], true), field("制裁", PENALTY_LABEL[input.penalty], true)),
        );
        return;
      }

      case "withdraw": {
        const updated = await withdrawCase(actor, caseNumber());
        await replyEmbed(interaction, embed(COLOR.neutral, `事件 第${updated.number}号｜取下げ`).setDescription("原告が訴えを取り下げました。"));
        return;
      }

      case "list": {
        const cases = await listCases(actor.guildId, (interaction.options.getString("filter") ?? "open") as CaseFilter);
        const body = embed(COLOR.court, "事件一覧").setDescription(
          cases.length === 0
            ? "該当する事件はありません。"
            : cases
                .map(
                  (c) =>
                    `**第${c.number}号**「${truncate(c.title, 50)}」${mention(c.plaintiff.discordId)} 対 ${mention(c.defendant.discordId)} — ${CASE_STATUS_LABEL[c.status as CaseStatus]}`,
                )
                .join("\n"),
        );
        await replyEmbed(interaction, body, { components: [linkRow("Webで見る", courtPath)] });
        return;
      }

      case "info": {
        const found = await caseDetail(actor.guildId, caseNumber());
        if (!found) fail("事件が見つかりません。");
        const body = embed(COLOR.court, `事件 第${found.number}号「${found.title}」`)
          .setDescription(truncate(found.claim, 2000))
          .addFields(
            field("状態", CASE_STATUS_LABEL[found.status as CaseStatus], true),
            field("原告", mention(found.plaintiff.discordId), true),
            field("被告", mention(found.defendant.discordId), true),
            field(`担当${roleTag("裁判官")}`, found.judge ? mention(found.judge.discordId) : "未定", true),
            field("提訴日", discordTime(found.filedAt, "D"), true),
          );
        if (found.defense) body.addFields(field("答弁", found.defense));
        if (found.result) {
          body.addFields(field("判決", `${CASE_RESULT_LABEL[found.result as CaseResult]}（制裁: ${PENALTY_LABEL[(found.penalty ?? "NONE") as Penalty]}）\n${found.ruling ?? ""}`));
        }
        if (found.status === "VERDICT" && found.appealDeadline) body.addFields(field("上告期限", withRelative(found.appealDeadline)));
        if (found.appealReason) body.addFields(field("上告理由", `${found.appellant ? mention(found.appellant.discordId) : ""} ${found.appealReason}`));
        if (found.appealResult) {
          body.addFields(
            field(
              "上告審判決",
              `${CASE_RESULT_LABEL[found.appealResult as CaseResult]}（制裁: ${PENALTY_LABEL[(found.appealPenalty ?? "NONE") as Penalty]}）\n${found.appealRuling ?? ""}`,
            ),
          );
        }
        if (found.penaltyStatus) {
          body.addFields(field("執行", `${PENALTY_STATUS_LABEL[found.penaltyStatus as PenaltyStatus]}${found.penaltyNote ? `: ${found.penaltyNote}` : ""}`));
        }
        if (found.threadId) body.addFields(field("審理スレッド", `<#${found.threadId}>`));
        await replyEmbed(interaction, body, { components: [linkRow("Webで見る", courtPath)] });
        return;
      }
    }
  },

  async autocomplete(interaction) {
    switch (routeOf(interaction)) {
      case "respond":
      case "withdraw":
      case "assign":
      case "take":
        return suggestCases(interaction, ["FILED", "IN_TRIAL"]);
      case "verdict":
        return suggestCases(interaction, ["IN_TRIAL"]);
      case "appeal":
        return suggestCases(interaction, ["VERDICT"]);
      case "final-ruling":
        return suggestCases(interaction, ["APPEALED"]);
      default:
        return suggestCases(interaction);
    }
  },
};
