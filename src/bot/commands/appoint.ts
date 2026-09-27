import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { ensureGuild, getCitizenOrThrow } from "../services/citizen";
import * as govService from "../services/government";
import { POSITION_TYPES, POSITION_LABELS } from "../../lib/constants";

export const data = new SlashCommandBuilder()
  .setName("appoint")
  .setDescription("役職任命コマンド")
  .addSubcommand((sub) =>
    sub
      .setName("minister")
      .setDescription("大臣を任命する（議員のみ）")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("任命するユーザー").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("title").setDescription("大臣の肩書き（例: イベント担当大臣）").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("aide")
      .setDescription("補佐官を任命する（議員のみ）")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("任命するユーザー").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("judge")
      .setDescription("裁判官を任命する（管理者or議員）")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("任命するユーザー").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("dismiss")
      .setDescription("役職を解任する（管理者or議員）")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("解任するユーザー").setRequired(true)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId || !interaction.guild) return;
  await ensureGuild(interaction.guild);

  const subcommand = interaction.options.getSubcommand();
  switch (subcommand) {
    case "minister": return handleAppoint(interaction, POSITION_TYPES.MINISTER);
    case "aide": return handleAppoint(interaction, POSITION_TYPES.AIDE);
    case "judge": return handleAppoint(interaction, POSITION_TYPES.JUDGE);
    case "dismiss": return handleDismiss(interaction);
  }
}

async function handleAppoint(interaction: ChatInputCommandInteraction, type: string) {
  const appointer = await getCitizenOrThrow(interaction.user.id, interaction.guildId!);

  const isAdmin = interaction.guild!.members.cache
    .get(interaction.user.id)
    ?.permissions.has(PermissionFlagsBits.Administrator);
  const isRep = await govService.hasPosition(appointer.id, interaction.guildId!, POSITION_TYPES.REPRESENTATIVE);

  if (!isAdmin && !isRep) {
    await interaction.reply({ content: "管理者または国民代表のみ任命できます。", ephemeral: true });
    return;
  }

  const targetUser = interaction.options.getUser("user", true);
  const target = await getCitizenOrThrow(targetUser.id, interaction.guildId!);

  let title: string;
  if (type === POSITION_TYPES.MINISTER) {
    title = interaction.options.getString("title", true);
  } else if (type === POSITION_TYPES.AIDE) {
    title = "補佐官";
  } else {
    title = "裁判官";
  }

  await govService.appointPosition(interaction.guildId!, target.id, type, title, appointer.id);

  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle("👑 役職任命")
    .setDescription(`<@${targetUser.id}> が **${title}** に任命されました。`)
    .addFields(
      { name: "役職種別", value: POSITION_LABELS[type] || type, inline: true },
      { name: "任命者", value: `<@${interaction.user.id}>`, inline: true }
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleDismiss(interaction: ChatInputCommandInteraction) {
  const appointer = await getCitizenOrThrow(interaction.user.id, interaction.guildId!);

  const isAdmin = interaction.guild!.members.cache
    .get(interaction.user.id)
    ?.permissions.has(PermissionFlagsBits.Administrator);
  const isRep = await govService.hasPosition(appointer.id, interaction.guildId!, POSITION_TYPES.REPRESENTATIVE);

  if (!isAdmin && !isRep) {
    await interaction.reply({ content: "管理者または国民代表のみ解任できます。", ephemeral: true });
    return;
  }

  const targetUser = interaction.options.getUser("user", true);
  const target = await getCitizenOrThrow(targetUser.id, interaction.guildId!);

  const { prisma } = await import("../../lib/prisma");
  const positions = await prisma.position.findMany({
    where: { citizenId: target.id, guildId: interaction.guildId!, isActive: true },
  });

  if (positions.length === 0) {
    await interaction.reply({ content: "対象ユーザーは現在役職に就いていません。", ephemeral: true });
    return;
  }

  for (const pos of positions) {
    await govService.dismissPosition(pos.id);
  }

  await interaction.reply(`<@${targetUser.id}> の全役職を解任しました。`);
}
