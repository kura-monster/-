import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { ensureGuild, getCitizenOrThrow } from "../services/citizen";
import { hasPosition } from "../services/government";
import * as policyService from "../services/policy";
import { PROPOSAL_STATUS_LABELS, PROPOSAL_STATUS } from "../../lib/constants";

export const data = new SlashCommandBuilder()
  .setName("propose")
  .setDescription("政策提案関連コマンド")
  .addSubcommand((sub) =>
    sub
      .setName("submit")
      .setDescription("新しい政策を提案する（議員のみ）")
      .addStringOption((opt) =>
        opt.setName("title").setDescription("提案タイトル").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("content").setDescription("提案内容").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("政策提案一覧を表示する")
  )
  .addSubcommand((sub) =>
    sub
      .setName("detail")
      .setDescription("提案の詳細を表示する")
      .addStringOption((opt) =>
        opt.setName("id").setDescription("提案ID").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("vote")
      .setDescription("政策提案に投票する（議員のみ）")
      .addStringOption((opt) =>
        opt.setName("id").setDescription("提案ID").setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("stance")
          .setDescription("賛否")
          .setRequired(true)
          .addChoices(
            { name: "賛成", value: "for" },
            { name: "反対", value: "against" }
          )
      )
      .addStringOption((opt) =>
        opt.setName("reason").setDescription("理由")
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("start_vote")
      .setDescription("提案の投票を開始する（議員のみ）")
      .addStringOption((opt) =>
        opt.setName("id").setDescription("提案ID").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt.setName("days").setDescription("投票日数").setRequired(true).setMinValue(1).setMaxValue(14)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("close")
      .setDescription("提案の投票を締め切り結果を確定する（議員のみ）")
      .addStringOption((opt) =>
        opt.setName("id").setDescription("提案ID").setRequired(true)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId || !interaction.guild) return;
  await ensureGuild(interaction.guild);

  const subcommand = interaction.options.getSubcommand();
  switch (subcommand) {
    case "submit": return handleSubmit(interaction);
    case "list": return handleList(interaction);
    case "detail": return handleDetail(interaction);
    case "vote": return handleVote(interaction);
    case "start_vote": return handleStartVote(interaction);
    case "close": return handleClose(interaction);
  }
}

async function handleSubmit(interaction: ChatInputCommandInteraction) {
  const citizen = await getCitizenOrThrow(interaction.user.id, interaction.guildId!);
  if (!(await hasPosition(citizen.id, interaction.guildId!, "REPRESENTATIVE"))) {
    await interaction.reply({ content: "政策提案は国民代表（議員）のみ可能です。", ephemeral: true });
    return;
  }

  const title = interaction.options.getString("title", true);
  const content = interaction.options.getString("content", true);
  const proposal = await policyService.createProposal(interaction.guildId!, citizen.id, title, content);

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("📋 新規政策提案")
    .setDescription(`**${title}**`)
    .addFields(
      { name: "提案内容", value: content },
      { name: "提案者", value: `<@${interaction.user.id}>`, inline: true },
      { name: "提案ID", value: proposal.id, inline: true },
      { name: "ステータス", value: "議論中", inline: true }
    )
    .setFooter({ text: "議論後 /propose start_vote で投票を開始できます" })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleList(interaction: ChatInputCommandInteraction) {
  const proposals = await policyService.listProposals(interaction.guildId!);

  if (proposals.length === 0) {
    await interaction.reply({ content: "現在の政策提案はありません。", ephemeral: true });
    return;
  }

  const list = proposals.map((p) => {
    const status = PROPOSAL_STATUS_LABELS[p.status] || p.status;
    const votes = p.votes.length > 0
      ? ` [賛成:${p.votes.filter(v => v.inFavor).length}/反対:${p.votes.filter(v => !v.inFavor).length}]`
      : "";
    return `**${p.title}** (${status})${votes}\n  ID: \`${p.id}\` | 提案者: <@${p.proposer.discordId}>`;
  }).join("\n\n");

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("📋 政策提案一覧")
    .setDescription(list)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleDetail(interaction: ChatInputCommandInteraction) {
  const proposal = await policyService.getProposal(interaction.options.getString("id", true));
  if (!proposal) {
    await interaction.reply({ content: "提案が見つかりません。", ephemeral: true });
    return;
  }

  const forVotes = proposal.votes.filter((v) => v.inFavor);
  const againstVotes = proposal.votes.filter((v) => !v.inFavor);

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`📋 ${proposal.title}`)
    .addFields(
      { name: "内容", value: proposal.content },
      { name: "ステータス", value: PROPOSAL_STATUS_LABELS[proposal.status] || proposal.status, inline: true },
      { name: "提案者", value: `<@${proposal.proposer.discordId}>`, inline: true },
      { name: "賛成", value: `${forVotes.length}票`, inline: true },
      { name: "反対", value: `${againstVotes.length}票`, inline: true }
    )
    .setTimestamp();

  if (forVotes.length > 0) {
    embed.addFields({
      name: "賛成票の理由",
      value: forVotes.map((v) => `<@${v.citizen.discordId}>: ${v.reason || "理由なし"}`).join("\n"),
    });
  }
  if (againstVotes.length > 0) {
    embed.addFields({
      name: "反対票の理由",
      value: againstVotes.map((v) => `<@${v.citizen.discordId}>: ${v.reason || "理由なし"}`).join("\n"),
    });
  }

  await interaction.reply({ embeds: [embed] });
}

async function handleVote(interaction: ChatInputCommandInteraction) {
  const citizen = await getCitizenOrThrow(interaction.user.id, interaction.guildId!);
  if (!(await hasPosition(citizen.id, interaction.guildId!, "REPRESENTATIVE"))) {
    await interaction.reply({ content: "投票は国民代表（議員）のみ可能です。", ephemeral: true });
    return;
  }

  const proposalId = interaction.options.getString("id", true);
  const stance = interaction.options.getString("stance", true);
  const reason = interaction.options.getString("reason") || undefined;

  try {
    await policyService.voteOnProposal(proposalId, citizen.id, stance === "for", reason);
  } catch (e) {
    await interaction.reply({ content: (e as Error).message, ephemeral: true });
    return;
  }

  const label = stance === "for" ? "賛成" : "反対";
  await interaction.reply(`<@${interaction.user.id}> が **${label}** に投票しました。${reason ? `\n理由: ${reason}` : ""}`);
}

async function handleStartVote(interaction: ChatInputCommandInteraction) {
  const citizen = await getCitizenOrThrow(interaction.user.id, interaction.guildId!);
  if (!(await hasPosition(citizen.id, interaction.guildId!, "REPRESENTATIVE"))) {
    await interaction.reply({ content: "議員のみ実行できます。", ephemeral: true });
    return;
  }

  const proposalId = interaction.options.getString("id", true);
  const days = interaction.options.getInteger("days", true);

  const proposal = await policyService.getProposal(proposalId);
  if (!proposal || proposal.status !== PROPOSAL_STATUS.DISCUSSION) {
    await interaction.reply({ content: "議論中の提案のみ投票を開始できます。", ephemeral: true });
    return;
  }

  await policyService.startProposalVoting(proposalId, days);
  await interaction.reply(`📊 **${proposal.title}** の投票が開始されました（${days}日間）`);
}

async function handleClose(interaction: ChatInputCommandInteraction) {
  const citizen = await getCitizenOrThrow(interaction.user.id, interaction.guildId!);
  if (!(await hasPosition(citizen.id, interaction.guildId!, "REPRESENTATIVE"))) {
    await interaction.reply({ content: "議員のみ実行できます。", ephemeral: true });
    return;
  }

  const proposalId = interaction.options.getString("id", true);

  try {
    const result = await policyService.finalizeProposal(proposalId);
    const statusLabel = PROPOSAL_STATUS_LABELS[result.status] || result.status;
    const emoji = result.status === PROPOSAL_STATUS.APPROVED ? "✅" : "❌";
    await interaction.reply(`${emoji} **${result.title}** の投票が締め切られました。結果: **${statusLabel}**`);
  } catch (e) {
    await interaction.reply({ content: (e as Error).message, ephemeral: true });
  }
}
