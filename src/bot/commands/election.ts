import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} from "discord.js";
import { ensureGuild, getCitizenOrThrow } from "../services/citizen";
import * as electionService from "../services/election";
import { ELECTION_STATUS_LABELS } from "../../lib/constants";

export const data = new SlashCommandBuilder()
  .setName("election")
  .setDescription("選挙関連コマンド")
  .addSubcommand((sub) =>
    sub
      .setName("start")
      .setDescription("新しい選挙を開始する（管理者のみ）")
      .addStringOption((opt) =>
        opt.setName("title").setDescription("選挙タイトル").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt.setName("seats").setDescription("当選枠数").setRequired(true).setMinValue(1).setMaxValue(20)
      )
      .addIntegerOption((opt) =>
        opt.setName("registration_days").setDescription("立候補受付日数").setRequired(true).setMinValue(1).setMaxValue(30)
      )
      .addIntegerOption((opt) =>
        opt.setName("voting_days").setDescription("投票日数").setRequired(true).setMinValue(1).setMaxValue(30)
      )
      .addStringOption((opt) =>
        opt.setName("description").setDescription("選挙の説明")
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("register")
      .setDescription("立候補する")
      .addStringOption((opt) =>
        opt.setName("manifesto").setDescription("公約（マニフェスト）")
      )
  )
  .addSubcommand((sub) =>
    sub.setName("status").setDescription("現在の選挙状況を表示する")
  )
  .addSubcommand((sub) =>
    sub.setName("advance").setDescription("選挙フェーズを進める（管理者のみ）")
  )
  .addSubcommand((sub) =>
    sub.setName("finalize").setDescription("選挙を即時終了し結果を確定する（管理者のみ）")
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId || !interaction.guild) return;
  await ensureGuild(interaction.guild);

  const subcommand = interaction.options.getSubcommand();

  switch (subcommand) {
    case "start": return handleStart(interaction);
    case "register": return handleRegister(interaction);
    case "status": return handleStatus(interaction);
    case "advance": return handleAdvance(interaction);
    case "finalize": return handleFinalize(interaction);
  }
}

async function handleStart(interaction: ChatInputCommandInteraction) {
  const member = interaction.guild!.members.cache.get(interaction.user.id);
  if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "管理者のみ選挙を開始できます。", ephemeral: true });
    return;
  }

  const existing = await electionService.getActiveElection(interaction.guildId!);
  if (existing) {
    await interaction.reply({ content: "既に進行中の選挙があります。", ephemeral: true });
    return;
  }

  const title = interaction.options.getString("title", true);
  const seats = interaction.options.getInteger("seats", true);
  const regDays = interaction.options.getInteger("registration_days", true);
  const voteDays = interaction.options.getInteger("voting_days", true);
  const description = interaction.options.getString("description") || undefined;

  const election = await electionService.createElection(
    interaction.guildId!, title, seats, regDays, voteDays, description
  );

  const embed = new EmbedBuilder()
    .setColor(0xff6b35)
    .setTitle("🗳️ 選挙告示")
    .setDescription(`**${title}**\n${description || ""}`)
    .addFields(
      { name: "当選枠", value: `${seats}名`, inline: true },
      { name: "立候補受付", value: `${regDays}日間`, inline: true },
      { name: "投票期間", value: `${voteDays}日間`, inline: true },
      { name: "立候補締切", value: election.registrationEnd.toLocaleString("ja-JP"), inline: false },
      { name: "投票締切", value: election.votingEnd.toLocaleString("ja-JP"), inline: false }
    )
    .setFooter({ text: `/election register で立候補できます` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleRegister(interaction: ChatInputCommandInteraction) {
  const citizen = await getCitizenOrThrow(interaction.user.id, interaction.guildId!);

  const election = await electionService.getActiveElection(interaction.guildId!);
  if (!election) {
    await interaction.reply({ content: "現在進行中の選挙がありません。", ephemeral: true });
    return;
  }

  const manifesto = interaction.options.getString("manifesto") || undefined;

  try {
    await electionService.registerCandidate(election.id, citizen.id, manifesto);
  } catch (e) {
    await interaction.reply({ content: (e as Error).message, ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x00ae86)
    .setTitle("📝 立候補受理")
    .setDescription(`<@${interaction.user.id}> さんが **${election.title}** に立候補しました！`)
    .setTimestamp();

  if (manifesto) {
    embed.addFields({ name: "公約", value: manifesto });
  }

  await interaction.reply({ embeds: [embed] });
}

async function handleStatus(interaction: ChatInputCommandInteraction) {
  const election = await electionService.getActiveElection(interaction.guildId!);
  if (!election) {
    await interaction.reply({ content: "現在進行中の選挙がありません。", ephemeral: true });
    return;
  }

  const statusLabel = ELECTION_STATUS_LABELS[election.status] || election.status;

  const candidateList = election.candidates.length > 0
    ? election.candidates.map((c, i) => {
        const voteCount = election.status === "VOTING" ? ` (${c.votes.length}票)` : "";
        return `${i + 1}. <@${c.citizen.discordId}>${voteCount}${c.manifesto ? `\n   公約: ${c.manifesto}` : ""}`;
      }).join("\n")
    : "まだ立候補者がいません";

  const embed = new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle(`🗳️ ${election.title}`)
    .setDescription(election.description || "")
    .addFields(
      { name: "ステータス", value: statusLabel, inline: true },
      { name: "当選枠", value: `${election.seats}名`, inline: true },
      { name: "総投票数", value: `${election.votes.length}票`, inline: true },
      { name: "候補者一覧", value: candidateList }
    )
    .setTimestamp();

  if (election.status === "VOTING") {
    const webUrl = process.env.WEB_BASE_URL || "http://localhost:3000";
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel("Webで投票する")
        .setStyle(ButtonStyle.Link)
        .setURL(`${webUrl}/elections/${election.id}`)
    );
    await interaction.reply({ embeds: [embed], components: [row] });
  } else {
    await interaction.reply({ embeds: [embed] });
  }
}

async function handleAdvance(interaction: ChatInputCommandInteraction) {
  const member = interaction.guild!.members.cache.get(interaction.user.id);
  if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "管理者のみ実行できます。", ephemeral: true });
    return;
  }

  const election = await electionService.getActiveElection(interaction.guildId!);
  if (!election) {
    await interaction.reply({ content: "現在進行中の選挙がありません。", ephemeral: true });
    return;
  }

  const result = await electionService.advanceElection(election.id);
  if (!result) {
    await interaction.reply({ content: "選挙の更新に失敗しました。", ephemeral: true });
    return;
  }

  const statusLabel = ELECTION_STATUS_LABELS[result.status] || result.status;
  await interaction.reply(`選挙のステータスが **${statusLabel}** に更新されました。`);
}

async function handleFinalize(interaction: ChatInputCommandInteraction) {
  const member = interaction.guild!.members.cache.get(interaction.user.id);
  if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "管理者のみ実行できます。", ephemeral: true });
    return;
  }

  const election = await electionService.getActiveElection(interaction.guildId!);
  if (!election) {
    await interaction.reply({ content: "現在進行中の選挙がありません。", ephemeral: true });
    return;
  }

  const result = await electionService.finalizeElection(election.id);

  const ranked = (result.candidates as Array<{ citizen: { discordId: string }; votes: unknown[] }>)
    .map((c) => ({ candidate: c, voteCount: c.votes.length }))
    .sort((a, b) => b.voteCount - a.voteCount);

  const resultText = ranked
    .map((r, i) => {
      const elected = i < result.seats ? "🏆 " : "　 ";
      return `${elected}${i + 1}位: <@${r.candidate.citizen.discordId}> (${r.voteCount}票)`;
    })
    .join("\n");

  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle(`🎉 選挙結果: ${result.title}`)
    .setDescription(resultText)
    .addFields(
      { name: "総投票数", value: `${result.votes.length}票` },
      { name: "当選者数", value: `${Math.min(ranked.length, result.seats)}名` }
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
