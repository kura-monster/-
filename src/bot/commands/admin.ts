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
import { MEMBERS_ONLY_OFFICES, POSITION_KEYS, POSITIONS, type PositionKey } from "../../core/positions";
import { roleTag } from "../../core/text";
import {
  ADMIN_APPOINTABLE,
  adminAppoint,
  adminDismiss,
  dissolveParliament,
  registerRoleMembers,
  revokeCitizenship,
  sanctionBill,
  vetoBill,
  type AdminAppointable,
} from "../../services/admin";
import { restoreCitizenship } from "../../services/citizen";
import { startElection } from "../../services/election";
import { formatSetting, getGuild, settingField, updateChannels, updateSettings, type SettingKey, type SettingsInput } from "../../services/guild";
import { actorFrom, identityOf, targetOf } from "../context";
import { diagnose } from "../diagnostics";
import { ensureManagedRoles, syncAllMembers } from "../roles";
import {
  CATEGORY_NAME,
  DEBATER_KEYS,
  appointOwnerAsSovereign,
  channelSettingsOf,
  ensureCountryChannels,
  missingForAutoSetup,
  planChannels,
  postWelcome,
  syncRolesReport,
  welcomeEmbed,
} from "../setup";
import { COLOR, embed, field, limitLines, linkRow, mention, replyEmbed, withRelative } from "../ui";
import { suggestBills } from "./autocomplete";
import { ELECTION_TARGET_CHOICES, electionInputOf } from "./election";
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

/**
 * Elections that make sense right after setting up: there are no representatives yet to stand for 首相・議長・副議長,
 * and a ministry needs a portfolio that this option cannot take.
 */
const FIRST_ELECTION_CHOICES = ELECTION_TARGET_CHOICES.filter(
  (choice) => choice.value !== "BY" && choice.value !== "MINISTER" && !MEMBERS_ONLY_OFFICES.includes(choice.value as PositionKey),
);

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
    .addSubcommand((s) =>
      s
        .setName("autosetup")
        .setDescription("オートセットアップ: チャンネル・権限・役職ロール・元首・案内をまとめて自動で設定する")
        .addStringOption((o) =>
          o
            .setName("first_election")
            .setDescription("最初に告示する選挙（省略すると告示しない）")
            .addChoices(...FIRST_ELECTION_CHOICES),
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
        .setDescription("市民の一括登録と、市民権の管理（サブアカウント・荒らし対策）")
        .addSubcommand((s) =>
          s
            .setName("register")
            .setDescription("指定したロールを持つメンバー全員を市民登録する（Bot を除く）")
            .addRoleOption((o) => o.setName("role").setDescription("このロールを持つ全員を登録（@everyone なら全メンバー）").setRequired(true))
            .addBooleanOption((o) =>
              o.setName("ignore_requirements").setDescription("アカウント年齢・在籍期間の条件を無視する（省略すると条件を守る）"),
            ),
        )
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
        const sovereign = await appointOwnerAsSovereign(interaction.guild, actor);
        const sync = await syncRolesReport(interaction.guild);
        const checks = await diagnose(interaction.guild);
        const show = (id: string | null) => (id ? `<#${id}>` : "未設定");

        const body = embed(COLOR.admin, "民主主義Bot｜初期設定")
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
                ...roles.failed.map((f) => `\`失敗\` ${f}`),
              ].join("\n"),
            ),
            field(roleTag("元首"), sovereign),
            field("ロール同期", sync),
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

      case "autosetup": {
        await interaction.deferReply();
        const guild = interaction.guild;
        const me = guild.members.me ?? (await guild.members.fetchMe());
        const lacking = missingForAutoSetup(me.permissions);
        if (lacking.length > 0) {
          fail(`Bot に「${lacking.join("」「")}」の権限がありません。サーバー設定で Bot のロールに付与するか、起動ログの招待URLから Bot を招待し直してください。`);
        }

        const roles = await ensureManagedRoles(guild);
        const managed = await prisma.managedRole.findMany({ where: { guildId: guild.id } });
        const roleOf = (key: string) => managed.find((r) => r.key === key)?.roleId;
        const plans = planChannels({
          everyone: guild.roles.everyone.id,
          bot: me.id,
          citizen: roleOf("CITIZEN"),
          debaters: DEBATER_KEYS.map(roleOf).filter((id): id is string => Boolean(id)),
        });
        const configured = channelSettingsOf(await getGuild(prisma, actor.guildId));
        const channels = await ensureCountryChannels(guild, configured, plans);
        const settings = channelSettingsOf(
          await updateChannels(actor, Object.fromEntries(channels.outcomes.flatMap((o) => (o.channelId ? [[o.plan.slot, o.channelId]] : [])))),
        );
        const sovereign = await appointOwnerAsSovereign(guild, actor);
        const sync = await syncRolesReport(guild);

        const announce = channels.outcomes.find((o) => o.plan.slot === "announceChannelId");
        const announceChannel = announce?.channelId ? guild.channels.cache.get(announce.channelId) : undefined;
        const welcome =
          announce?.status === "created" && announceChannel?.isTextBased()
            ? await postWelcome(announceChannel, welcomeEmbed(guild, settings), [linkRow("Webダッシュボードを開く", `/g/${guild.id}`)])
            : "官報チャンネルが既存のため投稿していません";

        let election: string | null = null;
        const firstElection = interaction.options.getString("first_election");
        if (firstElection) {
          try {
            const started = await startElection(actor, electionInputOf(firstElection));
            election = `${started.title}を告示しました（立候補の締切: ${withRelative(started.registrationEndsAt)}）`;
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            election = `告示しませんでした（${error.message}）`;
          }
        }
        const checks = await diagnose(guild);

        const STATUS = { created: "作成", existing: "既存" } as const;
        const channelLines = [
          `カテゴリー: ${CATEGORY_NAME}（${channels.categoryCreated ? "作成" : channels.category ? "既存" : "なし"}）`,
          ...channels.outcomes.map((o) =>
            o.status === "failed" ? `\`失敗\` ${o.plan.name}: ${o.error}` : `${o.plan.name}: <#${o.channelId}>（${STATUS[o.status]}）`,
          ),
        ];
        const body = embed(COLOR.admin, "民主主義Bot｜オートセットアップ").addFields(
          field("チャンネル", channelLines.join("\n")),
          field(
            "役職ロール",
            [`作成: ${roles.created.length > 0 ? roles.created.join("、") : "なし"}`, `既存: ${roles.existing}件`, ...roles.failed.map((f) => `\`失敗\` ${f}`)].join("\n"),
          ),
          field(roleTag("元首"), sovereign),
          field("ロール同期", sync),
          field("はじめにの案内", welcome),
          ...(election ? [field("最初の選挙", election)] : []),
          field("診断", limitLines(checks)),
          field(
            "次のステップ",
            [
              "1. 市民に `/citizen register` で登録してもらう（参加方法は官報の案内に掲載）。`/admin citizen register` でロールごとにまとめて登録も可",
              ...(election ? [] : ["2. `/election manage start kind:総選挙` で最初の選挙を告示"]),
              "・必要に応じて `/admin appoint` で最高裁判所長官・選挙管理委員長を任命",
              "・`/admin settings` で議員定数や任期を調整",
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
          embed(COLOR.admin, "ロール同期").addFields(
            field("役職ロール", [`作成: ${roles.created.join("、") || "なし"}`, `既存: ${roles.existing}件`, ...roles.failed.map((f) => `\`失敗\` ${f}`)].join("\n")),
            field("メンバー", [`${sync.synced}名を同期`, ...sync.errors.map((e) => `\`失敗\` ${e}`)].join("\n")),
          ),
        );
        return;
      }

      case "diagnose": {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const checks = await diagnose(interaction.guild);
        await replyEmbed(interaction, embed(COLOR.admin, "診断結果").setDescription(checks.join("\n")));
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
          await replyEmbed(interaction, embed(COLOR.admin, "現在の制度").setDescription(lines.join("\n")), { ephemeral: true });
          return;
        }
        const { changes } = await updateSettings(actor, input);
        await replyEmbed(
          interaction,
          embed(COLOR.admin, "制度の改正").setDescription(changes.length > 0 ? changes.map((c) => `・${c}`).join("\n") : "変更はありませんでした。"),
        );
        return;
      }

      case "appoint": {
        const key = interaction.options.getString("position", true) as AdminAppointable;
        const target = targetOf(interaction, "user");
        await adminAppoint(actor, key, { ...target.identity, isDiscordAdmin: target.isDiscordAdmin });
        await replyEmbed(
          interaction,
          embed(COLOR.admin, `人事｜${POSITIONS[key].label}の任命`).setDescription(`${mention(target.user.id)} を ${roleTag(POSITIONS[key].label)} に任命しました。`),
        );
        return;
      }

      case "dismiss": {
        const key = interaction.options.getString("position", true) as PositionKey;
        const target = targetOf(interaction, "user");
        const ended = await adminDismiss(actor, target.user.id, key, interaction.options.getString("reason", true));
        await replyEmbed(
          interaction,
          embed(COLOR.danger, "管理者権限による罷免").setDescription(ended.map((p) => `${mention(p.citizen.discordId)} ${roleTag(p.title)}（${p.endReason}）`).join("\n")),
        );
        return;
      }

      case "bill sanction": {
        const bill = await sanctionBill(actor, interaction.options.getInteger("bill", true));
        await replyEmbed(interaction, embed(COLOR.success, `第${bill.number}号「${bill.title}」裁可・成立`).setDescription("法律として成立しました。内閣は `/cabinet implement` で施行を記録できます。"));
        return;
      }

      case "bill veto": {
        const bill = await vetoBill(actor, interaction.options.getInteger("bill", true), interaction.options.getString("reason", true));
        await replyEmbed(
          interaction,
          embed(COLOR.danger, `第${bill.number}号「${bill.title}」拒否権行使`).setDescription(
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
          embed(COLOR.danger, "議会解散").setDescription(`すべての議員が失職し、${election.title}が告示されました。`).addFields(
            field("立候補の締切", withRelative(election.registrationEndsAt)),
            field("投票の締切", withRelative(election.votingEndsAt)),
          ),
        );
        return;
      }

      case "citizen register": {
        await interaction.deferReply();
        const role = interaction.options.getRole("role", true);
        const waive = interaction.options.getBoolean("ignore_requirements") ?? false;
        const members = await interaction.guild.members
          .fetch()
          .catch(() => fail("メンバー一覧を取得できませんでした。Developer Portal の Bot 設定で「SERVER MEMBERS INTENT」を有効にしてください。"));
        const holders = [...members.values()].filter((member) => !member.user.bot && member.roles.cache.has(role.id));
        const result = await registerRoleMembers(
          actor,
          role.name,
          holders.map((member) => ({ ...identityOf(member.user, member), accountCreatedAt: member.user.createdAt, joinedAt: member.joinedAt })),
          { waiveRequirements: waive },
        );
        const body = embed(COLOR.admin, "市民の一括登録")
          .setDescription(`${role} を持つメンバー ${holders.length}名（Bot を除く）`)
          .addFields(
            field(
              `登録した市民（${result.registered.length}名）`,
              limitLines(result.registered.map((c) => `${mention(c.discordId)}　市民番号 ${c.number}`)),
            ),
            field("登録済み", `${result.alreadyRegistered}名`, true),
            field(`登録できなかった人（${result.skipped.length}名）`, limitLines(result.skipped.map((s) => `${s.displayName}: ${s.reason}`))),
          );
        if (!waive && result.skipped.some((s) => s.waivable)) {
          body.setFooter({ text: "アカウント年齢・在籍期間の条件を無視して登録するには ignore_requirements:True を指定してください" });
        }
        await replyEmbed(interaction, body);
        return;
      }

      case "citizen revoke": {
        const target = targetOf(interaction, "user");
        const result = await revokeCitizenship(actor, target.identity, interaction.options.getString("reason", true));
        await replyEmbed(
          interaction,
          embed(COLOR.danger, "市民権の停止").setDescription(
            `${mention(target.user.id)} の市民権を停止しました。${result.ended.length > 0 ? `\n失職: ${result.ended.map((p) => roleTag(p.title)).join(" ")}` : ""}`,
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
