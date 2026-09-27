import { InteractionContextType, SlashCommandBuilder } from "discord.js";
import { fail } from "../../core/errors";
import { roleTag } from "../../core/text";
import { citizenProfile, registerCitizen, removeCitizenship, resignPosition } from "../../services/citizen";
import { actorFrom, identityOf } from "../context";
import { COLOR, discordTime, embed, field, limitLines, mention, replyEmbed } from "../ui";
import { suggestOwnPositions } from "./autocomplete";
import { routeOf, type BotCommand } from "./types";

export const citizenCommand: BotCommand = {
  audience: "public",
  data: new SlashCommandBuilder()
    .setName("citizen")
    .setDescription("市民（国籍）に関するコマンド")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName("register").setDescription("市民として登録する（選挙権・被選挙権・請願権を得る）"))
    .addSubcommand((s) =>
      s
        .setName("profile")
        .setDescription("市民プロフィールと経歴を表示する")
        .addUserOption((o) => o.setName("user").setDescription("表示する市民（省略すると自分）")),
    )
    .addSubcommand((s) =>
      s
        .setName("resign")
        .setDescription("自分の役職を辞職する")
        .addStringOption((o) => o.setName("position").setDescription("辞職する役職").setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("leave")
        .setDescription("市民登録を抹消する（すべての役職と立候補を失います）")
        .addBooleanOption((o) => o.setName("confirm").setDescription("本当に抹消する場合は True").setRequired(true)),
    ),

  async execute(interaction) {
    const actor = await actorFrom(interaction);
    const identity = identityOf(interaction.user, interaction.member);

    switch (routeOf(interaction)) {
      case "register": {
        const { citizen, reactivated } = await registerCitizen(actor.guildId, {
          ...identity,
          accountCreatedAt: interaction.user.createdAt,
          joinedAt: interaction.member.joinedAt,
        });
        const body = embed(COLOR.success, reactivated ? "市民登録（再登録）" : "市民登録完了")
          .setDescription(`${mention(actor.discordId)} さんを ${roleTag("市民")} として登録しました。`)
          .setThumbnail(identity.avatarUrl)
          .addFields(
            field("市民番号", `第${citizen.number}号`, true),
            field("登録日", discordTime(citizen.registeredAt, "D"), true),
            field(
              "できること",
              ["・選挙での投票（Web）と立候補（`/election candidacy`）", "・請願と署名（`/petition`）", "・裁判の提起（`/court file`）"].join("\n"),
            ),
          );
        await replyEmbed(interaction, body);
        return;
      }

      case "profile": {
        const user = interaction.options.getUser("user") ?? interaction.user;
        const profile = await citizenProfile(actor.guildId, user.id);
        if (!profile) fail(`${mention(user.id)} さんは市民登録されていません。`);
        const { citizen } = profile;
        const status = citizen.revokedAt ? "市民権停止中" : citizen.active ? "市民" : "登録抹消";
        const body = embed(COLOR.primary, `市民プロフィール｜${citizen.displayName}`)
          .setThumbnail(citizen.avatarUrl)
          .addFields(
            field("市民番号", `第${citizen.number}号`, true),
            field("状態", status, true),
            field("登録日", discordTime(citizen.registeredAt, "D"), true),
            field(
              "現在の役職",
              limitLines(
                profile.current.map(
                  (p) => `${roleTag(p.title)}${p.expiresAt ? `（任期: ${discordTime(p.expiresAt, "D")}まで）` : ""}`,
                ),
              ),
            ),
            field(
              "経歴",
              limitLines(
                profile.history.map(
                  (p) => `${roleTag(p.title)}　${discordTime(p.startedAt, "d")}〜${p.endedAt ? discordTime(p.endedAt, "d") : ""}（${p.endReason ?? "退任"}）`,
                ),
              ),
            ),
            field("選挙", `当選 ${profile.electedCount}回／立候補 ${profile.candidacyCount}回`, true),
            field("提出した法案", `${profile.billsProposed}件`, true),
            field("確定した制裁", `${profile.sanctions}件`, true),
          );
        await replyEmbed(interaction, body);
        return;
      }

      case "resign": {
        const position = await resignPosition(actor, interaction.options.getString("position", true));
        await replyEmbed(
          interaction,
          embed(COLOR.warning, "辞職").setDescription(`${mention(actor.discordId)} さんが ${roleTag(position.title)} を辞職しました。`),
        );
        return;
      }

      case "leave": {
        if (!interaction.options.getBoolean("confirm", true)) fail("中止しました。抹消する場合は confirm を True にしてください。");
        const result = await removeCitizenship(actor.guildId, identity, "SELF");
        if (!result) fail("市民登録されていません。");
        await replyEmbed(
          interaction,
          embed(COLOR.neutral, "市民登録の抹消").setDescription(
            `${mention(actor.discordId)} さんの市民登録を抹消しました。${result.ended.length > 0 ? `\n失職した役職: ${result.ended.map((p) => roleTag(p.title)).join(" ")}` : ""}`,
          ),
        );
        return;
      }
    }
  },

  async autocomplete(interaction) {
    if (routeOf(interaction) === "resign") await suggestOwnPositions(interaction);
  },
};
