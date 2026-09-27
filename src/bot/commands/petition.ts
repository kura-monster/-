import { InteractionContextType, SlashCommandBuilder } from "discord.js";
import { fail } from "../../core/errors";
import { PETITION_STATUS_LABEL, type PetitionStatus } from "../../core/constants";
import { truncate } from "../../core/text";
import { createPetition, listPetitions, petitionDetail, signPetition } from "../../services/petition";
import { actorFrom } from "../context";
import { COLOR, discordTime, embed, field, joinNames, linkRow, mention, replyEmbed, withRelative } from "../ui";
import { suggestPetitions } from "./autocomplete";
import { routeOf, type BotCommand } from "./types";

export const petitionCommand: BotCommand = {
  audience: "public",
  data: new SlashCommandBuilder()
    .setName("petition")
    .setDescription("請願（市民の署名が集まると国会に法案として送られます）")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName("create")
        .setDescription("請願を作成する")
        .addStringOption((o) => o.setName("title").setDescription("件名").setRequired(true).setMaxLength(80))
        .addStringOption((o) => o.setName("content").setDescription("請願の内容").setRequired(true).setMaxLength(1500)),
    )
    .addSubcommand((s) =>
      s
        .setName("sign")
        .setDescription("請願に署名する")
        .addIntegerOption((o) => o.setName("petition").setDescription("署名受付中の請願").setRequired(true).setAutocomplete(true).setMinValue(1)),
    )
    .addSubcommand((s) => s.setName("list").setDescription("請願の一覧を表示する"))
    .addSubcommand((s) =>
      s
        .setName("info")
        .setDescription("請願の詳細と署名者を表示する")
        .addIntegerOption((o) => o.setName("petition").setDescription("請願").setRequired(true).setAutocomplete(true).setMinValue(1)),
    ),

  async execute(interaction) {
    const actor = await actorFrom(interaction);
    const petitionsPath = `/g/${actor.guildId}/petitions`;

    switch (routeOf(interaction)) {
      case "create": {
        const { petition, submitted } = await createPetition(actor, interaction.options.getString("title", true), interaction.options.getString("content", true));
        const body = embed(COLOR.petition, `請願 第${petition.number}号「${petition.title}」`)
          .setDescription(truncate(petition.content, 3000))
          .addFields(field("提出者", mention(actor.discordId), true), field("署名の締切", withRelative(petition.expiresAt)))
          .setFooter({ text: submitted ? "必要署名数に達したため国会へ送付されました" : "/petition sign またはWebで署名できます" });
        await replyEmbed(interaction, body, { components: [linkRow("Webで署名する", petitionsPath)] });
        return;
      }

      case "sign": {
        const result = await signPetition(actor.guildId, actor.discordId, interaction.options.getInteger("petition", true));
        const body = embed(COLOR.petition, `請願 第${result.petition.number}号「${result.petition.title}」に署名`).setDescription(
          result.submitted
            ? `署名が ${result.signatures}筆に達し、国会へ法案として送付されました！`
            : `現在 ${result.signatures}／${result.threshold}筆`,
        );
        await replyEmbed(interaction, body);
        return;
      }

      case "list": {
        const { petitions, threshold } = await listPetitions(actor.guildId, actor.discordId);
        const body = embed(COLOR.petition, "請願一覧").setDescription(
          petitions.length === 0
            ? "請願はまだありません。`/petition create` で作成できます。"
            : petitions
                .map(
                  (p) =>
                    `**第${p.number}号**「${truncate(p.title, 50)}」${p.signatureCount}/${threshold}筆 — ${PETITION_STATUS_LABEL[p.status as PetitionStatus]}${p.signedByViewer ? "（署名済み）" : ""}`,
                )
                .join("\n"),
        );
        await replyEmbed(interaction, body, { components: [linkRow("Webで見る", petitionsPath)] });
        return;
      }

      case "info": {
        const detail = await petitionDetail(actor.guildId, interaction.options.getInteger("petition", true));
        if (!detail) fail("請願が見つかりません。");
        const { petition, threshold } = detail;
        const body = embed(COLOR.petition, `請願 第${petition.number}号「${petition.title}」`)
          .setDescription(truncate(petition.content, 2500))
          .addFields(
            field("状態", PETITION_STATUS_LABEL[petition.status as PetitionStatus], true),
            field("署名", `${petition.signatures.length}/${threshold}筆`, true),
            field("提出者", mention(petition.creator.discordId), true),
            field("締切", petition.status === "OPEN" ? withRelative(petition.expiresAt) : discordTime(petition.expiresAt, "D")),
            field("署名者", joinNames(petition.signatures.map((s) => mention(s.citizen.discordId)), "なし")),
          );
        if (petition.bill) body.addFields(field("国会", `第${petition.bill.number}号議案として送付済み`));
        await replyEmbed(interaction, body, { components: [linkRow("Webで見る", petitionsPath)] });
        return;
      }
    }
  },

  async autocomplete(interaction) {
    if (routeOf(interaction) === "sign") return suggestPetitions(interaction, ["OPEN"]);
    return suggestPetitions(interaction);
  },
};
