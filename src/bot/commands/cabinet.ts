import { InteractionContextType, SlashCommandBuilder } from "discord.js";
import { POSITIONS, positionDef } from "../../core/positions";
import {
  cabinetAppoint,
  cabinetDismiss,
  cabinetResign,
  cabinetRoster,
  implementLaw,
  issueStatement,
  type CabinetAppointable,
  type CabinetDismissable,
} from "../../services/cabinet";
import { actorFrom, targetOf } from "../context";
import { COLOR, embed, field, limitLines, mention, renderTokens, replyEmbed } from "../ui";
import { suggestBills, suggestMinistries } from "./autocomplete";
import { routeOf, type BotCommand } from "./types";

export const cabinetCommand: BotCommand = {
  audience: "public",
  data: new SlashCommandBuilder()
    .setName("cabinet")
    .setDescription("内閣（閣僚の任命・談話・法律の施行）")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName("appoint")
        .setDescription("閣僚または裁判官を任命する（内閣総理大臣）")
        .addStringOption((o) =>
          o
            .setName("position")
            .setDescription("任命する役職")
            .setRequired(true)
            .addChoices(
              { name: "副総理", value: "DEPUTY_PRIME_MINISTER" },
              { name: "内閣官房長官", value: "CHIEF_CABINET_SECRETARY" },
              { name: "国務大臣（担当分野を指定）", value: "MINISTER" },
              { name: "裁判官", value: "JUDGE" },
            ),
        )
        .addUserOption((o) => o.setName("user").setDescription("任命する市民").setRequired(true))
        .addStringOption((o) =>
          o.setName("title").setDescription("国務大臣の担当（例: 外務大臣）").setAutocomplete(true).setMaxLength(40),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("dismiss")
        .setDescription("閣僚を罷免する（内閣総理大臣）")
        .addUserOption((o) => o.setName("user").setDescription("罷免する閣僚").setRequired(true))
        .addStringOption((o) =>
          o
            .setName("position")
            .setDescription("罷免する役職")
            .setRequired(true)
            .addChoices(
              { name: "副総理", value: "DEPUTY_PRIME_MINISTER" },
              { name: "内閣官房長官", value: "CHIEF_CABINET_SECRETARY" },
              { name: "国務大臣", value: "MINISTER" },
            ),
        ),
    )
    .addSubcommand((s) => s.setName("list").setDescription("内閣の名簿を表示する"))
    .addSubcommand((s) => s.setName("resign").setDescription("内閣総辞職する（内閣総理大臣）"))
    .addSubcommand((s) =>
      s
        .setName("statement")
        .setDescription("談話を官報に掲載する（内閣総理大臣・内閣官房長官）")
        .addStringOption((o) => o.setName("title").setDescription("件名").setRequired(true).setMaxLength(80))
        .addStringOption((o) => o.setName("content").setDescription("本文").setRequired(true).setMaxLength(1500)),
    )
    .addSubcommand((s) =>
      s
        .setName("implement")
        .setDescription("成立した法律を施行済みとして記録する（閣僚・管理者）")
        .addIntegerOption((o) => o.setName("bill").setDescription("成立した法律").setRequired(true).setAutocomplete(true).setMinValue(1))
        .addStringOption((o) => o.setName("note").setDescription("施行内容のメモ").setMaxLength(500)),
    ),

  async execute(interaction) {
    const actor = await actorFrom(interaction);

    switch (routeOf(interaction)) {
      case "appoint": {
        const key = interaction.options.getString("position", true) as CabinetAppointable;
        const target = targetOf(interaction, "user");
        const position = await cabinetAppoint(
          actor,
          key,
          { discordId: target.user.id, isDiscordAdmin: target.isDiscordAdmin },
          interaction.options.getString("title") ?? undefined,
        );
        await replyEmbed(
          interaction,
          embed(COLOR.cabinet, `${POSITIONS[key].emoji} ${position.title}の任命`).setDescription(
            `内閣総理大臣 ${mention(actor.discordId)} が ${mention(target.user.id)} を **${position.title}** に任命しました。`,
          ),
        );
        return;
      }

      case "dismiss": {
        const key = interaction.options.getString("position", true) as CabinetDismissable;
        const target = targetOf(interaction, "user");
        const position = await cabinetDismiss(actor, target.user.id, key);
        await replyEmbed(
          interaction,
          embed(COLOR.warning, `${position.title}の罷免`).setDescription(`${mention(target.user.id)} を${position.title}から罷免しました。`),
        );
        return;
      }

      case "list": {
        const { members, judges } = await cabinetRoster(actor.guildId);
        const pm = members.find((m) => m.key === "PRIME_MINISTER");
        const body = embed(COLOR.cabinet, pm ? `🎌 ${pm.citizen.displayName}内閣` : "🎌 内閣（首相不在）")
          .setDescription(pm ? null : "国会の `/parliament elect` で内閣総理大臣を指名してください。")
          .addFields(
            field("閣僚", limitLines(members.map((m) => `${positionDef(m.key).emoji} ${m.title}: ${mention(m.citizen.discordId)}`))),
            field("裁判所", limitLines(judges.map((j) => `${j.title}: ${mention(j.citizen.discordId)}`))),
          );
        await replyEmbed(interaction, body);
        return;
      }

      case "resign": {
        const ended = await cabinetResign(actor);
        await replyEmbed(
          interaction,
          embed(COLOR.danger, "🎌 内閣総辞職").setDescription(
            `${ended.map((p) => `${p.title}: ${mention(p.citizen.discordId)}`).join("\n")}\n\n国会は \`/parliament elect\` で新しい内閣総理大臣を指名してください。`,
          ),
        );
        return;
      }

      case "statement": {
        const entry = await issueStatement(actor, interaction.options.getString("title", true), interaction.options.getString("content", true));
        await replyEmbed(interaction, embed(COLOR.cabinet, `📣 ${entry.title}`).setDescription(renderTokens(entry.body)).setFooter({ text: `官報 第${entry.number}号に掲載` }));
        return;
      }

      case "implement": {
        const bill = await implementLaw(actor, interaction.options.getInteger("bill", true), interaction.options.getString("note") ?? undefined);
        await replyEmbed(
          interaction,
          embed(COLOR.success, `✅ 第${bill.number}号「${bill.title}」施行`).setDescription(bill.implementedNote ?? "施行を記録しました。"),
        );
        return;
      }
    }
  },

  async autocomplete(interaction) {
    const route = routeOf(interaction);
    if (route === "appoint") return suggestMinistries(interaction);
    if (route === "implement") return suggestBills(interaction, ["ENACTED"]);
  },
};
