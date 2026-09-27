import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
} from "discord.js";
import { ensureGuild, getCitizenOrThrow } from "../services/citizen";
import { hasPosition } from "../services/government";
import * as trialService from "../services/trial";
import { TRIAL_STATUS_LABELS, POSITION_TYPES } from "../../lib/constants";

export const data = new SlashCommandBuilder()
  .setName("trial")
  .setDescription("裁判システムコマンド")
  .addSubcommand((sub) =>
    sub
      .setName("file")
      .setDescription("裁判を提訴する")
      .addUserOption((opt) =>
        opt.setName("defendant").setDescription("被告").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("title").setDescription("件名").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("description").setDescription("訴状の内容").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("judge")
      .setDescription("裁判の担当裁判官に志願する（裁判官のみ）")
      .addStringOption((opt) =>
        opt.setName("id").setDescription("裁判ID").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("verdict")
      .setDescription("判決を下す（担当裁判官のみ）")
      .addStringOption((opt) =>
        opt.setName("id").setDescription("裁判ID").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("verdict").setDescription("判決内容").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("進行中の裁判一覧を表示する")
  )
  .addSubcommand((sub) =>
    sub
      .setName("detail")
      .setDescription("裁判の詳細を表示する")
      .addStringOption((opt) =>
        opt.setName("id").setDescription("裁判ID").setRequired(true)
      )
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.guildId || !interaction.guild) return;
  await ensureGuild(interaction.guild);

  const subcommand = interaction.options.getSubcommand();
  switch (subcommand) {
    case "file": return handleFile(interaction);
    case "judge": return handleJudge(interaction);
    case "verdict": return handleVerdict(interaction);
    case "list": return handleList(interaction);
    case "detail": return handleDetail(interaction);
  }
}

async function handleFile(interaction: ChatInputCommandInteraction) {
  const plaintiff = await getCitizenOrThrow(interaction.user.id, interaction.guildId!);
  const defendantUser = interaction.options.getUser("defendant", true);
  const defendant = await getCitizenOrThrow(defendantUser.id, interaction.guildId!);

  const title = interaction.options.getString("title", true);
  const description = interaction.options.getString("description", true);

  const trial = await trialService.fileTrial(
    interaction.guildId!, plaintiff.id, defendant.id, title, description
  );

  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("⚖️ 裁判提訴")
    .setDescription(`**${title}**`)
    .addFields(
      { name: "原告", value: `<@${interaction.user.id}>`, inline: true },
      { name: "被告", value: `<@${defendantUser.id}>`, inline: true },
      { name: "裁判ID", value: trial.id, inline: true },
      { name: "訴状", value: description }
    )
    .setFooter({ text: "裁判官は /trial judge で担当を志願できます" })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleJudge(interaction: ChatInputCommandInteraction) {
  const citizen = await getCitizenOrThrow(interaction.user.id, interaction.guildId!);
  if (!(await hasPosition(citizen.id, interaction.guildId!, POSITION_TYPES.JUDGE))) {
    await interaction.reply({ content: "裁判官のみ担当を志願できます。", ephemeral: true });
    return;
  }

  const trialId = interaction.options.getString("id", true);
  try {
    const trial = await trialService.assignJudge(trialId, citizen.id);
    await interaction.reply(`⚖️ <@${interaction.user.id}> が裁判「${trial.title}」の担当裁判官に就任しました。`);
  } catch (e) {
    await interaction.reply({ content: (e as Error).message, ephemeral: true });
  }
}

async function handleVerdict(interaction: ChatInputCommandInteraction) {
  const citizen = await getCitizenOrThrow(interaction.user.id, interaction.guildId!);

  const trialId = interaction.options.getString("id", true);
  const verdict = interaction.options.getString("verdict", true);

  try {
    const trial = await trialService.issueVerdict(trialId, citizen.id, verdict);
    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle(`⚖️ 判決: ${trial.title}`)
      .addFields(
        { name: "原告", value: `<@${trial.plaintiff.discordId}>`, inline: true },
        { name: "被告", value: `<@${trial.defendant.discordId}>`, inline: true },
        { name: "裁判官", value: `<@${trial.judge!.discordId}>`, inline: true },
        { name: "判決", value: verdict }
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (e) {
    await interaction.reply({ content: (e as Error).message, ephemeral: true });
  }
}

async function handleList(interaction: ChatInputCommandInteraction) {
  const trials = await trialService.getActiveTrial(interaction.guildId!);

  if (trials.length === 0) {
    await interaction.reply({ content: "現在進行中の裁判はありません。", ephemeral: true });
    return;
  }

  const list = trials.map((t) => {
    const status = TRIAL_STATUS_LABELS[t.status] || t.status;
    const judge = t.judge ? `裁判官: <@${t.judge.discordId}>` : "裁判官: 未定";
    return `**${t.title}** (${status})\n  原告: <@${t.plaintiff.discordId}> vs 被告: <@${t.defendant.discordId}>\n  ${judge} | ID: \`${t.id}\``;
  }).join("\n\n");

  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("⚖️ 進行中の裁判一覧")
    .setDescription(list)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

async function handleDetail(interaction: ChatInputCommandInteraction) {
  const trial = await trialService.getTrial(interaction.options.getString("id", true));
  if (!trial) {
    await interaction.reply({ content: "裁判が見つかりません。", ephemeral: true });
    return;
  }

  const status = TRIAL_STATUS_LABELS[trial.status] || trial.status;

  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle(`⚖️ ${trial.title}`)
    .addFields(
      { name: "ステータス", value: status, inline: true },
      { name: "原告", value: `<@${trial.plaintiff.discordId}>`, inline: true },
      { name: "被告", value: `<@${trial.defendant.discordId}>`, inline: true },
      { name: "裁判官", value: trial.judge ? `<@${trial.judge.discordId}>` : "未定", inline: true },
      { name: "訴状", value: trial.description }
    )
    .setTimestamp();

  if (trial.verdict) {
    embed.addFields({ name: "判決", value: trial.verdict });
  }

  await interaction.reply({ embeds: [embed] });
}
