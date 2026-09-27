import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from "discord.js";
import { ensureGuild } from "../services/citizen";
import { getGovernment } from "../services/government";
import { prisma } from "../../lib/prisma";

export const data = new SlashCommandBuilder()
  .setName("government")
  .setDescription("政府構成関連コマンド")
  .addSubcommand((sub) =>
    sub.setName("show").setDescription("現在の政府構成を表示する")
  )
  .addSubcommand((sub) =>
    sub
      .setName("setup")
      .setDescription("民主主義Botの初期設定（管理者のみ）")
      .addChannelOption((opt) =>
        opt.setName("election_channel").setDescription("選挙チャンネル")
      )
      .addChannelOption((opt) =>
        opt.setName("debate_channel").setDescription("議論チャンネル")
      )
      .addChannelOption((opt) =>
        opt.setName("court_channel").setDescription("裁判チャンネル")
      )
      .addChannelOption((opt) =>
        opt.setName("announce_channel").setDescription("告知チャンネル")
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId || !interaction.guild) return;
  await ensureGuild(interaction.guild);

  const subcommand = interaction.options.getSubcommand();
  switch (subcommand) {
    case "show": return handleShow(interaction);
    case "setup": return handleSetup(interaction);
  }
}

async function handleShow(interaction: ChatInputCommandInteraction) {
  const gov = await getGovernment(interaction.guildId!);

  const formatPositions = (positions: typeof gov.representatives) => {
    if (positions.length === 0) return "なし";
    return positions
      .map((p) => `<@${p.citizen.discordId}> - ${p.title}`)
      .join("\n");
  };

  const guild = await prisma.guild.findUnique({ where: { id: interaction.guildId! } });

  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle(`🏛️ ${guild?.name || interaction.guild!.name} 政府構成`)
    .addFields(
      {
        name: `━━ 管理者派閥 ━━`,
        value: "サーバー管理者・オーナー",
      },
      {
        name: `🏛️ 国民代表（議員） [${gov.representatives.length}名]`,
        value: formatPositions(gov.representatives),
      },
      {
        name: `━━ 国民代表派閥 ━━`,
        value: "​",
      },
      {
        name: `👔 大臣 [${gov.ministers.length}名]`,
        value: formatPositions(gov.ministers),
      },
      {
        name: `📎 補佐官 [${gov.aides.length}名]`,
        value: formatPositions(gov.aides),
      },
      {
        name: `⚖️ 裁判官 [${gov.judges.length}名]`,
        value: formatPositions(gov.judges),
      }
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleSetup(interaction: ChatInputCommandInteraction) {
  const member = interaction.guild!.members.cache.get(interaction.user.id);
  if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "管理者のみ設定できます。", ephemeral: true });
    return;
  }

  const electionChannel = interaction.options.getChannel("election_channel");
  const debateChannel = interaction.options.getChannel("debate_channel");
  const courtChannel = interaction.options.getChannel("court_channel");
  const announceChannel = interaction.options.getChannel("announce_channel");

  const data: Record<string, string> = {};
  if (electionChannel) data.electionChannelId = electionChannel.id;
  if (debateChannel) data.debateChannelId = debateChannel.id;
  if (courtChannel) data.courtChannelId = courtChannel.id;
  if (announceChannel) data.announceChannelId = announceChannel.id;

  if (Object.keys(data).length === 0) {
    await interaction.reply({ content: "少なくとも1つのチャンネルを指定してください。", ephemeral: true });
    return;
  }

  await prisma.guild.update({
    where: { id: interaction.guildId! },
    data,
  });

  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle("⚙️ 設定更新")
    .setDescription("民主主義Botの設定が更新されました。")
    .setTimestamp();

  if (electionChannel) embed.addFields({ name: "選挙チャンネル", value: `<#${electionChannel.id}>`, inline: true });
  if (debateChannel) embed.addFields({ name: "議論チャンネル", value: `<#${debateChannel.id}>`, inline: true });
  if (courtChannel) embed.addFields({ name: "裁判チャンネル", value: `<#${courtChannel.id}>`, inline: true });
  if (announceChannel) embed.addFields({ name: "告知チャンネル", value: `<#${announceChannel.id}>`, inline: true });

  await interaction.reply({ embeds: [embed] });
}
