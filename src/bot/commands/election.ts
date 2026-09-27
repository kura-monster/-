import { InteractionContextType, SlashCommandBuilder } from "discord.js";
import { fail } from "../../core/errors";
import type { Election } from "@prisma/client";
import { ELECTION_KIND_LABEL, ELECTION_STATUS_LABEL, type ElectionKind, type ElectionStatus } from "../../core/constants";
import { MEMBERS_ONLY_OFFICES, OFFICE_ELECTION_KEYS, POSITIONS, type PositionKey } from "../../core/positions";
import { roleTag, truncate } from "../../core/text";
import {
  advanceElection,
  cancelElection,
  electionOffice,
  electionOverview,
  electionResults,
  standForElection,
  startElection,
  withdrawCandidacy,
  type ElectionInput,
} from "../../services/election";
import { actorFrom } from "../context";
import { COLOR, embed, field, limitLines, linkRow, mention, replyEmbed, withRelative } from "../ui";
import { suggestElections } from "./autocomplete";
import { routeOf, type BotCommand } from "./types";

function officeChoiceName(key: PositionKey): string {
  const def = POSITIONS[key];
  const note = MEMBERS_ONLY_OFFICES.includes(key)
    ? "（候補は議員）"
    : key === "MINISTER"
      ? "（portfolio で担当分野を指定）"
      : typeof def.capacity === "number" && def.capacity > 1
        ? "（欠員を補充）"
        : "";
  return `${def.label}の選挙${note}`;
}

/** What an election can be for: the parliament (general / by-election) or one of the offices citizens may elect. */
export const ELECTION_TARGET_CHOICES = [
  { name: "総選挙（議員の全議席を改選）", value: "GENERAL" },
  { name: "補欠選挙（議員の欠員を補充）", value: "BY" },
  ...OFFICE_ELECTION_KEYS.map((key) => ({ name: officeChoiceName(key), value: key })),
];

export function electionInputOf(target: string, extra: Omit<ElectionInput, "kind" | "position"> = {}): ElectionInput {
  if (target === "GENERAL" || target === "BY") return { kind: target, ...extra };
  return { kind: "OFFICE", position: target as PositionKey, ...extra };
}

/** "内閣総理大臣（1名）" for an office election, "議員（定数5名）" otherwise. */
export function electedOfficeText(election: Pick<Election, "kind" | "position" | "positionTitle" | "seats">): string {
  const { title } = electionOffice(election);
  return election.kind === "OFFICE" ? `${roleTag(title)}（${election.seats}名）` : `${roleTag(title)}（定数${election.seats}名）`;
}

export const electionCommand: BotCommand = {
  audience: "public",
  data: new SlashCommandBuilder()
    .setName("election")
    .setDescription("選挙（立候補・投票・結果）")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName("status").setDescription("進行中の選挙の状況と候補者を表示する"))
    .addSubcommand((s) =>
      s
        .setName("candidacy")
        .setDescription("進行中の選挙に立候補する")
        .addStringOption((o) => o.setName("manifesto").setDescription("公約（マニフェスト）").setMaxLength(500)),
    )
    .addSubcommand((s) => s.setName("withdraw").setDescription("立候補を取り下げる（立候補受付中のみ）"))
    .addSubcommand((s) => s.setName("vote").setDescription("Webの投票ページを開く（秘密投票）"))
    .addSubcommand((s) =>
      s
        .setName("results")
        .setDescription("選挙結果を表示する")
        .addIntegerOption((o) => o.setName("election").setDescription("選挙（省略すると直近）").setAutocomplete(true)),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("manage")
        .setDescription("選挙管理（選挙管理委員会・管理者）")
        .addSubcommand((s) =>
          s
            .setName("start")
            .setDescription("選挙を告示する")
            .addStringOption((o) =>
              o
                .setName("kind")
                .setDescription("何の選挙か（議員の総選挙・補欠選挙、または役職）")
                .setRequired(true)
                .addChoices(...ELECTION_TARGET_CHOICES),
            )
            .addStringOption((o) => o.setName("portfolio").setDescription("国務大臣の選挙のとき: 担当分野（例: 外務）").setMaxLength(20))
            .addIntegerOption((o) =>
              o.setName("seats").setDescription("裁判官・選挙管理委員の選挙のとき: 選ぶ人数（省略すると欠員数）").setMinValue(1).setMaxValue(12),
            )
            .addStringOption((o) => o.setName("title").setDescription("選挙名（省略すると「第N回 総選挙」「第N回 内閣総理大臣選挙」など）").setMaxLength(80))
            .addIntegerOption((o) => o.setName("registration_days").setDescription("立候補受付の日数（省略すると制度の値）").setMinValue(1).setMaxValue(14))
            .addIntegerOption((o) => o.setName("voting_days").setDescription("投票の日数（省略すると制度の値）").setMinValue(1).setMaxValue(14))
            .addStringOption((o) => o.setName("description").setDescription("告示文").setMaxLength(500)),
        )
        .addSubcommand((s) => s.setName("advance").setDescription("現在のフェーズを締め切って次に進める（立候補締切・開票）"))
        .addSubcommand((s) =>
          s
            .setName("cancel")
            .setDescription("進行中の選挙を中止する")
            .addStringOption((o) => o.setName("reason").setDescription("中止の理由").setRequired(true).setMaxLength(300)),
        ),
    ),

  async execute(interaction) {
    const actor = await actorFrom(interaction);
    const electionPath = `/g/${actor.guildId}/election`;

    switch (routeOf(interaction)) {
      case "status": {
        const overview = await electionOverview(actor.guildId);
        if (!overview) fail("進行中の選挙はありません。過去の結果は `/election results` で確認できます。");
        const { election, candidates, turnout } = overview;
        const body = embed(COLOR.election, election.title)
          .setDescription(election.description ?? null)
          .addFields(
            field("種類", ELECTION_KIND_LABEL[election.kind as ElectionKind], true),
            field("状態", ELECTION_STATUS_LABEL[election.status as ElectionStatus], true),
            field("選ぶ役職", electedOfficeText(election), true),
            field("立候補の締切", withRelative(election.registrationEndsAt)),
            field("投票の締切", withRelative(election.votingEndsAt)),
            field(
              `候補者（${candidates.length}名）`,
              limitLines(
                candidates.map((c) => `${mention(c.citizen.discordId)}${c.manifesto ? `　${truncate(c.manifesto, 80)}` : ""}`),
                "まだいません（`/election candidacy` で立候補できます）",
              ),
            ),
          );
        if (election.status === "VOTING") body.addFields(field("投票者数", `${turnout}名（得票は開票まで非公開）`, true));
        await replyEmbed(interaction, body, {
          components: election.status === "VOTING" ? [linkRow("Webで投票する", electionPath)] : [],
        });
        return;
      }

      case "candidacy": {
        const { election, candidate } = await standForElection(actor, interaction.options.getString("manifesto") ?? undefined);
        const body = embed(COLOR.success, `立候補届出｜${election.title}`)
          .setDescription(`${mention(actor.discordId)} さんが立候補しました。`)
          .addFields(field("立候補の締切", withRelative(election.registrationEndsAt)));
        if (candidate.manifesto) body.addFields(field("公約", candidate.manifesto));
        await replyEmbed(interaction, body);
        return;
      }

      case "withdraw": {
        const election = await withdrawCandidacy(actor);
        await replyEmbed(interaction, embed(COLOR.neutral, "立候補の取り下げ").setDescription(`${mention(actor.discordId)} さんが ${election.title} への立候補を取り下げました。`));
        return;
      }

      case "vote": {
        const overview = await electionOverview(actor.guildId);
        if (!overview || overview.election.status !== "VOTING") fail("現在、投票を受け付けている選挙はありません。");
        const body = embed(COLOR.election, overview.election.title)
          .setDescription("投票はWebで行います。Discordでログインして候補者を選んでください。\n秘密投票のため、誰が誰に投票したかは記録されません。")
          .addFields(field("投票の締切", withRelative(overview.election.votingEndsAt)));
        await replyEmbed(interaction, body, { ephemeral: true, components: [linkRow("Webで投票する", electionPath)] });
        return;
      }

      case "results": {
        const result = await electionResults(actor.guildId, interaction.options.getInteger("election") ?? undefined);
        if (!result) fail("確定した選挙はまだありません。");
        const { election, candidates, turnout } = result;
        const body = embed(election.status === "COMPLETED" ? COLOR.success : COLOR.neutral, `${election.title}｜結果`).addFields(
          field("状態", ELECTION_STATUS_LABEL[election.status as ElectionStatus], true),
          field("選ぶ役職", electedOfficeText(election), true),
          field("投票者数", `${turnout}名`, true),
        );
        if (election.status === "CANCELLED") body.addFields(field("中止の理由", election.cancelReason ?? "記載なし"));
        else {
          body.addFields(
            field(
              "得票",
              limitLines(candidates.map((c) => `${c.elected ? "`当選`" : "`落選`"}　${mention(c.citizen.discordId)}　${c.voteCount ?? 0}票`)),
            ),
          );
          if (election.lotteryUsed) body.setFooter({ text: "最下位当選者が得票同数のため、くじで当選人を決定しました" });
        }
        await replyEmbed(interaction, body, { components: [linkRow("Webで見る", electionPath)] });
        return;
      }

      case "manage start": {
        const election = await startElection(
          actor,
          electionInputOf(interaction.options.getString("kind", true), {
            portfolio: interaction.options.getString("portfolio") ?? undefined,
            seats: interaction.options.getInteger("seats") ?? undefined,
            title: interaction.options.getString("title") ?? undefined,
            description: interaction.options.getString("description") ?? undefined,
            registrationDays: interaction.options.getInteger("registration_days") ?? undefined,
            votingDays: interaction.options.getInteger("voting_days") ?? undefined,
          }),
        );
        const membersOnly = MEMBERS_ONLY_OFFICES.includes(electionOffice(election).key);
        const body = embed(COLOR.election, `${election.title}｜告示`)
          .setDescription(election.description ?? null)
          .addFields(
            field("選ぶ役職", electedOfficeText(election), true),
            field("立候補の締切", withRelative(election.registrationEndsAt)),
            field("投票の締切", withRelative(election.votingEndsAt)),
          )
          .setFooter({ text: membersOnly ? "現職の議員は /election candidacy で立候補できます" : "市民は /election candidacy で立候補できます" });
        await replyEmbed(interaction, body);
        return;
      }

      case "manage advance": {
        const election = await advanceElection(actor);
        await replyEmbed(
          interaction,
          embed(COLOR.election, "選挙の進行").setDescription(
            election ? `${election.title} は「${ELECTION_STATUS_LABEL[election.status as ElectionStatus]}」になりました。` : "状態は変わりませんでした。",
          ),
        );
        return;
      }

      case "manage cancel": {
        const election = await cancelElection(actor, interaction.options.getString("reason", true));
        await replyEmbed(interaction, embed(COLOR.danger, `${election.title}｜中止`).setDescription(`理由: ${election.cancelReason}`));
        return;
      }
    }
  },

  async autocomplete(interaction) {
    if (routeOf(interaction) === "results") await suggestElections(interaction);
  },
};
