import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
import { prisma } from "../../lib/prisma";
import { DomainError, fail } from "../../core/errors";
import { POSITION_KEYS, POSITIONS, type PositionKey } from "../../core/positions";
import {
  ADMIN_APPOINTABLE,
  adminAppoint,
  adminDismiss,
  dissolveParliament,
  revokeCitizenship,
  sanctionBill,
  vetoBill,
  type AdminAppointable,
} from "../../services/admin";
import { restoreCitizenship } from "../../services/citizen";
import { formatSetting, getGuild, settingField, updateChannels, updateSettings, type SettingKey, type SettingsInput } from "../../services/guild";
import { holderOf } from "../../services/positions";
import { actorFrom, identityOf, targetOf } from "../context";
import { diagnose } from "../diagnostics";
import { ensureManagedRoles, syncAllMembers } from "../roles";
import { COLOR, embed, field, limitLines, mention, replyEmbed, withRelative } from "../ui";
import { suggestBills } from "./autocomplete";
import { routeOf, type BotCommand } from "./types";

const SETTING_OPTIONS: { option: string; key: SettingKey }[] = [
  { option: "seats", key: "seats" },
  { option: "term_days", key: "termDays" },
  { option: "registration_days", key: "registrationDays" },
  { option: "voting_days", key: "votingDays" },
  { option: "bill_voting_days", key: "billVotingDays" },
  { option: "sanction_days", key: "sanctionDays" },
  { option: "petition_threshold", key: "petitionThreshold" },
  { option: "petition_days", key: "petitionDays" },
  { option: "appeal_hours", key: "appealHours" },
  { option: "min_account_age_days", key: "minAccountAgeDays" },
  { option: "min_membership_days", key: "minMembershipDays" },
  { option: "admin_participation", key: "allowAdminParticipation" },
  { option: "enforce_penalties", key: "enforcePenalties" },
  { option: "auto_election", key: "autoElection" },
];

function withSettings(s: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  for (const { option, key } of SETTING_OPTIONS) {
    const def = settingField(key);
    if ("boolean" in def) s.addBooleanOption((o) => o.setName(option).setDescription(def.label));
    else s.addIntegerOption((o) => o.setName(option).setDescription(`${def.label}（${def.unit}）`).setMinValue(def.min).setMaxValue(def.max));
  }
  return s;
}

const billOption = (s: SlashCommandSubcommandBuilder, description: string) =>
  s.addIntegerOption((o) => o.setName("bill").setDescription(description).setRequired(true).setAutocomplete(true).setMinValue(1));

export const adminCommand: BotCommand = {
  audience: "admin",
  data: new SlashCommandBuilder()
    .setName("admin")
    .setDescription("管理者専用（管理者派閥の権限。すべての操作は官報に記録されます）")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName("setup")
        .setDescription("初期設定: チャンネル・役職ロールの作成・元首の任命・ロール同期")
        .addChannelOption((o) =>
          o.setName("announce_channel").setDescription("官報を掲載するチャンネル").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addChannelOption((o) =>
          o.setName("debate_channel").setDescription("法案ごとに議論スレッドを作るチャンネル").addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum),
        )
        .addChannelOption((o) =>
          o.setName("court_channel").setDescription("事件ごとに審理スレッドを作るチャンネル").addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum),
        )
        .addChannelOption((o) =>
          o
            .setName("election_channel")
            .setDescription("投票開始を案内するチャンネル（省略時は官報チャンネル）")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((s) => s.setName("sync").setDescription("役職ロールを再作成し、全メンバーのロールを同期する"))
    .addSubcommand((s) => s.setName("diagnose").setDescription("Botの権限・ロール順位・チャンネル設定を診断する"))
    .addSubcommand((s) => withSettings(s.setName("settings").setDescription("国の制度を変更する（何も指定しないと現在の値を表示）")))
    .addSubcommand((s) =>
      s
        .setName("appoint")
        .setDescription("元首・管理官・最高裁判所長官・選挙管理委員を任命する")
        .addStringOption((o) =>
          o
            .setName("position")
            .setDescription("任命する役職")
            .setRequired(true)
            .addChoices(...ADMIN_APPOINTABLE.map((key) => ({ name: POSITIONS[key].label, value: key }))),
        )
        .addUserOption((o) => o.setName("user").setDescription("任命する人（未登録なら市民登録も行います）").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("dismiss")
        .setDescription("役職から罷免する（緊急措置。理由とともに官報に記録）")
        .addUserOption((o) => o.setName("user").setDescription("罷免する人").setRequired(true))
        .addStringOption((o) =>
          o
            .setName("position")
            .setDescription("罷免する役職")
            .setRequired(true)
            .addChoices(...POSITION_KEYS.map((key) => ({ name: POSITIONS[key].label, value: key }))),
        )
        .addStringOption((o) => o.setName("reason").setDescription("理由（官報に掲載）").setRequired(true).setMaxLength(300)),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("bill")
        .setDescription("国会で可決された法案の裁可・拒否権")
        .addSubcommand((s) => billOption(s.setName("sanction").setDescription("可決された法案を裁可して成立させる"), "裁可待ちの法案"))
        .addSubcommand((s) =>
          billOption(s.setName("veto").setDescription("拒否権を行使する（国会は3分の2で再可決できます）"), "裁可待ちの法案").addStringOption((o) =>
            o.setName("reason").setDescription("拒否の理由（官報に掲載）").setRequired(true).setMaxLength(500),
          ),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("dissolve")
        .setDescription("議会を解散して総選挙を告示する")
        .addStringOption((o) => o.setName("reason").setDescription("解散の理由（官報に掲載）").setRequired(true).setMaxLength(300))
        .addBooleanOption((o) => o.setName("confirm").setDescription("本当に解散する場合は True").setRequired(true)),
    )
    .addSubcommandGroup((g) =>
      g
        .setName("citizen")
        .setDescription("市民権の管理（サブアカウント・荒らし対策）")
        .addSubcommand((s) =>
          s
            .setName("revoke")
            .setDescription("市民権を停止する（全役職を失い、再登録もできなくなります）")
            .addUserOption((o) => o.setName("user").setDescription("対象者").setRequired(true))
            .addStringOption((o) => o.setName("reason").setDescription("理由（官報に掲載）").setRequired(true).setMaxLength(300)),
        )
        .addSubcommand((s) =>
          s
            .setName("restore")
            .setDescription("市民権の停止を解除する")
            .addUserOption((o) => o.setName("user").setDescription("対象者").setRequired(true)),
        ),
    ),

  async execute(interaction) {
    const actor = await actorFrom(interaction);
    if (!actor.isAdmin) fail("このコマンドは管理者専用です。");

    switch (routeOf(interaction)) {
      case "setup": {
        await interaction.deferReply();
        const channel = (name: string) => interaction.options.getChannel(name)?.id;
        const guild = await updateChannels(actor, {
          announceChannelId: channel("announce_channel"),
          debateChannelId: channel("debate_channel"),
          courtChannelId: channel("court_channel"),
          electionChannelId: channel("election_channel"),
        });
        const roles = await ensureManagedRoles(interaction.guild);

        let sovereign: string;
        const current = await holderOf(prisma, actor.guildId, "SOVEREIGN");
        if (current) {
          sovereign = `${mention(current.citizen.discordId)}（在任中）`;
        } else {
          const owner = await interaction.guild.fetchOwner();
          try {
            await adminAppoint(actor, "SOVEREIGN", { ...identityOf(owner.user, owner), isDiscordAdmin: true });
            sovereign = `サーバーオーナー ${mention(owner.id)} を元首に任命しました`;
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            sovereign = `未任命（${error.message}）`;
          }
        }

        const sync = await syncAllMembers(interaction.guild).catch((error: unknown) => ({
          synced: 0,
          errors: [`メンバー一覧を取得できませんでした（Developer Portal で SERVER MEMBERS INTENT を有効にしてください）: ${String(error)}`],
        }));
        const checks = await diagnose(interaction.guild);
        const show = (id: string | null) => (id ? `<#${id}>` : "未設定");

        const body = embed(COLOR.admin, "⚙️ 民主主義Bot 初期設定")
          .addFields(
            field(
              "チャンネル",
              [
                `官報: ${show(guild.announceChannelId)}`,
                `議事堂: ${show(guild.debateChannelId)}`,
                `裁判所: ${show(guild.courtChannelId)}`,
                `選挙: ${show(guild.electionChannelId)}`,
              ].join("\n"),
            ),
            field(
              "役職ロール",
              [
                `作成: ${roles.created.length > 0 ? roles.created.join("、") : "なし"}`,
                `既存: ${roles.existing}件`,
                ...roles.failed.map((f) => `⚠️ ${f}`),
              ].join("\n"),
            ),
            field("元首", sovereign),
            field("ロール同期", [`${sync.synced}名を同期`, ...sync.errors.map((e) => `⚠️ ${e}`)].join("\n")),
            field("診断", limitLines(checks)),
            field(
              "次のステップ",
              [
                "1. 市民に `/citizen register` で登録してもらう",
                "2. `/election manage start kind:総選挙` で最初の選挙を告示",
                "3. 必要に応じて `/admin appoint` で最高裁判所長官・選挙管理委員長を任命",
                "4. `/admin settings` で議員定数や任期を調整",
              ].join("\n"),
            ),
          );
        await replyEmbed(interaction, body);
        return;
      }

      case "sync": {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const roles = await ensureManagedRoles(interaction.guild);
        const sync = await syncAllMembers(interaction.guild);
        await replyEmbed(
          interaction,
          embed(COLOR.admin, "🔄 ロール同期").addFields(
            field("役職ロール", [`作成: ${roles.created.join("、") || "なし"}`, `既存: ${roles.existing}件`, ...roles.failed.map((f) => `⚠️ ${f}`)].join("\n")),
            field("メンバー", [`${sync.synced}名を同期`, ...sync.errors.map((e) => `⚠️ ${e}`)].join("\n")),
          ),
        );
        return;
      }

      case "diagnose": {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const checks = await diagnose(interaction.guild);
        await replyEmbed(interaction, embed(COLOR.admin, "🩺 診断結果").setDescription(checks.join("\n")));
        return;
      }

      case "settings": {
        const input: SettingsInput = {};
        for (const { option, key } of SETTING_OPTIONS) {
          const value = "boolean" in settingField(key) ? interaction.options.getBoolean(option) : interaction.options.getInteger(option);
          if (value !== null) (input as Record<string, number | boolean>)[key] = value;
        }
        if (Object.keys(input).length === 0) {
          const guild = await getGuild(prisma, actor.guildId);
          const lines = SETTING_OPTIONS.map(({ option, key }) => `${settingField(key).label}: **${formatSetting(key, guild[key])}**（\`${option}\`）`);
          await replyEmbed(interaction, embed(COLOR.admin, "⚙️ 現在の制度").setDescription(lines.join("\n")), { ephemeral: true });
          return;
        }
        const { changes } = await updateSettings(actor, input);
        await replyEmbed(
          interaction,
          embed(COLOR.admin, "⚙️ 制度の改正").setDescription(changes.length > 0 ? changes.map((c) => `・${c}`).join("\n") : "変更はありませんでした。"),
        );
        return;
      }

      case "appoint": {
        const key = interaction.options.getString("position", true) as AdminAppointable;
        const target = targetOf(interaction, "user");
        await adminAppoint(actor, key, { ...target.identity, isDiscordAdmin: target.isDiscordAdmin });
        await replyEmbed(
          interaction,
          embed(COLOR.admin, `${POSITIONS[key].emoji} ${POSITIONS[key].label}の任命`).setDescription(`${mention(target.user.id)} を${POSITIONS[key].label}に任命しました。`),
        );
        return;
      }

      case "dismiss": {
        const key = interaction.options.getString("position", true) as PositionKey;
        const target = targetOf(interaction, "user");
        const ended = await adminDismiss(actor, target.user.id, key, interaction.options.getString("reason", true));
        await replyEmbed(
          interaction,
          embed(COLOR.danger, "🛡️ 管理者権限による罷免").setDescription(ended.map((p) => `${mention(p.citizen.discordId)}: ${p.title}（${p.endReason}）`).join("\n")),
        );
        return;
      }

      case "bill sanction": {
        const bill = await sanctionBill(actor, interaction.options.getInteger("bill", true));
        await replyEmbed(interaction, embed(COLOR.success, `✅ 第${bill.number}号「${bill.title}」裁可・成立`).setDescription("法律として成立しました。内閣は `/cabinet implement` で施行を記録できます。"));
        return;
      }

      case "bill veto": {
        const bill = await vetoBill(actor, interaction.options.getInteger("bill", true), interaction.options.getString("reason", true));
        await replyEmbed(
          interaction,
          embed(COLOR.danger, `🚫 第${bill.number}号「${bill.title}」拒否権行使`).setDescription(
            `理由: ${bill.vetoReason}\n国会は \`/parliament bill override\` で再議決（出席議員の3分の2以上）を発議できます。`,
          ),
        );
        return;
      }

      case "dissolve": {
        if (!interaction.options.getBoolean("confirm", true)) fail("中止しました。解散する場合は confirm を True にしてください。");
        const election = await dissolveParliament(actor, interaction.options.getString("reason", true));
        await replyEmbed(
          interaction,
          embed(COLOR.danger, "🏛️ 議会解散").setDescription(`すべての議員が失職し、${election.title}が告示されました。`).addFields(
            field("立候補の締切", withRelative(election.registrationEndsAt)),
            field("投票の締切", withRelative(election.votingEndsAt)),
          ),
        );
        return;
      }

      case "citizen revoke": {
        const target = targetOf(interaction, "user");
        const result = await revokeCitizenship(actor, target.identity, interaction.options.getString("reason", true));
        await replyEmbed(
          interaction,
          embed(COLOR.danger, "⛔ 市民権の停止").setDescription(
            `${mention(target.user.id)} の市民権を停止しました。${result.ended.length > 0 ? `\n失職: ${result.ended.map((p) => p.title).join("、")}` : ""}`,
          ),
        );
        return;
      }

      case "citizen restore": {
        const target = targetOf(interaction, "user");
        await restoreCitizenship(actor, target.user.id);
        await replyEmbed(interaction, embed(COLOR.success, "市民権停止の解除").setDescription(`${mention(target.user.id)} は再び市民登録できます。`));
        return;
      }
    }
  },

  async autocomplete(interaction) {
    if (routeOf(interaction).startsWith("bill ")) await suggestBills(interaction, ["PASSED"], ["ORDINARY"]);
  },
};
