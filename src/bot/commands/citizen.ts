import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
} from "discord.js";
import { registerCitizen, getCitizen } from "../services/citizen";
import { POSITION_LABELS } from "../../lib/constants";

export const data = new SlashCommandBuilder()
  .setName("citizen")
  .setDescription("市民関連コマンド")
  .addSubcommand((sub) =>
    sub.setName("register").setDescription("市民として登録する")
  )
  .addSubcommand((sub) =>
    sub
      .setName("info")
      .setDescription("市民情報を表示する")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("対象ユーザー")
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "register") {
    await handleRegister(interaction);
  } else if (subcommand === "info") {
    await handleInfo(interaction);
  }
}

async function handleRegister(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) return;

  const citizen = await registerCitizen(interaction.user.id, interaction.guildId);

  const embed = new EmbedBuilder()
    .setColor(0x00ae86)
    .setTitle("🏛️ 市民登録完了")
    .setDescription(`<@${interaction.user.id}> さんが市民として登録されました。`)
    .addFields(
      { name: "市民ID", value: citizen.id, inline: true },
      { name: "登録日", value: citizen.joinedAt.toLocaleDateString("ja-JP"), inline: true }
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleInfo(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId) return;

  const targetUser = interaction.options.getUser("user") || interaction.user;
  const citizen = await getCitizen(targetUser.id, interaction.guildId);

  if (!citizen) {
    await interaction.reply({ content: "この方は市民登録されていません。", ephemeral: true });
    return;
  }

  const member = interaction.guild?.members.cache.get(targetUser.id) as GuildMember | undefined;

  const positionText =
    citizen.positions.length > 0
      ? citizen.positions
          .map((p) => `${POSITION_LABELS[p.type] || p.type}: ${p.title}`)
          .join("\n")
      : "なし";

  const embed = new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle(`🪪 市民情報: ${member?.displayName || targetUser.username}`)
    .setThumbnail(targetUser.displayAvatarURL())
    .addFields(
      { name: "市民ID", value: citizen.id, inline: true },
      { name: "登録日", value: citizen.joinedAt.toLocaleDateString("ja-JP"), inline: true },
      { name: "現在の役職", value: positionText }
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
