import { InteractionContextType, SlashCommandBuilder, type SlashCommandIntegerOption } from "discord.js";
import { fail } from "../../core/errors";
import {
  BILL_KIND_LABEL,
  BILL_ORIGIN_LABEL,
  MAJORITY_LABEL,
  OFFICE_LABEL,
  VOTE_CHOICE_LABEL,
  billStatusLabel,
  type BillKind,
  type BillOrigin,
  type Majority,
  type Office,
  type VoteChoice,
} from "../../core/constants";
import { describeTally } from "../../core/tally";
import { roleTag, truncate } from "../../core/text";
import {
  appointAide,
  billDetail,
  castBillVote,
  dismissAide,
  listBills,
  moveImpeachment,
  moveNoConfidence,
  moveOverride,
  openBillVote,
  parliamentRoster,
  submitBill,
  voteForOffice,
  withdrawBill,
  type BillFilter,
} from "../../services/parliament";
import { actorFrom, targetOf } from "../context";
import { COLOR, discordTime, embed, field, joinNames, limitLines, linkRow, mention, replyEmbed, withRelative } from "../ui";
import { suggestBills } from "./autocomplete";
import { routeOf, type BotCommand } from "./types";

const billOption = (description: string) => (o: SlashCommandIntegerOption) =>
  o.setName("bill").setDescription(description).setRequired(true).setAutocomplete(true).setMinValue(1);

export const parliamentCommand: BotCommand = {
  audience: "public",
  data: new SlashCommandBuilder()
    .setName("parliament")
    .setDescription("国会（法案・院内選挙・不信任・弾劾）")
    .setContexts(InteractionContextType.Guild)
    .addSubcommandGroup((g) =>
      g
        .setName("bill")
        .setDescription("法案")
        .addSubcommand((s) =>
          s
            .setName("submit")
            .setDescription("法案を提出する（議員・閣僚）")
            .addStringOption((o) => o.setName("title").setDescription("法案名").setRequired(true).setMaxLength(80))
            .addStringOption((o) => o.setName("content").setDescription("法案の内容").setRequired(true).setMaxLength(1500)),
        )
        .addSubcommand((s) =>
          s
            .setName("list")
            .setDescription("法案の一覧を表示する")
            .addStringOption((o) =>
              o
                .setName("filter")
                .setDescription("表示する範囲")
                .addChoices(
                  { name: "進行中", value: "open" },
                  { name: "成立・施行済", value: "enacted" },
                  { name: "否決・撤回・廃案", value: "closed" },
                  { name: "すべて", value: "all" },
                ),
            ),
        )
        .addSubcommand((s) => s.setName("info").setDescription("法案の詳細と投票記録（記名投票）").addIntegerOption(billOption("法案")))
        .addSubcommand((s) =>
          s
            .setName("open")
            .setDescription("採決を開始する（議長・副議長／議長不在時は議員）")
            .addIntegerOption(billOption("審議中の法案"))
            .addIntegerOption((o) => o.setName("days").setDescription("採決期間の日数（省略すると制度の値）").setMinValue(1).setMaxValue(14)),
        )
        .addSubcommand((s) =>
          s
            .setName("vote")
            .setDescription("採決に投票する（議員）")
            .addIntegerOption(billOption("採決中の法案"))
            .addStringOption((o) =>
              o
                .setName("choice")
                .setDescription("賛否")
                .setRequired(true)
                .addChoices({ name: "賛成", value: "FOR" }, { name: "反対", value: "AGAINST" }, { name: "棄権", value: "ABSTAIN" }),
            ),
        )
        .addSubcommand((s) => s.setName("withdraw").setDescription("自分が提出した法案を撤回する（採決前のみ）").addIntegerOption(billOption("審議中の法案")))
        .addSubcommand((s) =>
          s
            .setName("override")
            .setDescription("拒否権が行使された法案の再議決を発議する（3分の2以上で成立）")
            .addIntegerOption(billOption("拒否権が行使された法案"))
            .addIntegerOption((o) => o.setName("days").setDescription("採決期間の日数（省略すると制度の値）").setMinValue(1).setMaxValue(14)),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("elect")
        .setDescription("院内選挙に投票する（議長・副議長・内閣総理大臣の指名）")
        .addStringOption((o) =>
          o
            .setName("office")
            .setDescription("選ぶ役職")
            .setRequired(true)
            .addChoices(
              { name: "議長", value: "SPEAKER" },
              { name: "副議長", value: "VICE_SPEAKER" },
              { name: "内閣総理大臣（首班指名）", value: "PRIME_MINISTER" },
            ),
        )
        .addUserOption((o) => o.setName("candidate").setDescription("投票する議員").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("no-confidence")
        .setDescription("内閣不信任決議案を提出する（可決で内閣総辞職）")
        .addStringOption((o) => o.setName("reason").setDescription("理由").setRequired(true).setMaxLength(1000)),
    )
    .addSubcommand((s) =>
      s
        .setName("impeach")
        .setDescription("弾劾決議案を提出する（3分の2以上で全役職から罷免）")
        .addUserOption((o) => o.setName("target").setDescription("対象者").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("理由").setRequired(true).setMaxLength(1000)),
    )
    .addSubcommand((s) => s.setName("members").setDescription("議員名簿と院内選挙の状況を表示する"))
    .addSubcommandGroup((g) =>
      g
        .setName("aide")
        .setDescription("補佐官（議員が任命）")
        .addSubcommand((s) =>
          s
            .setName("appoint")
            .setDescription("補佐官を任命する（議員1人につき2名まで）")
            .addUserOption((o) => o.setName("user").setDescription("任命する市民").setRequired(true)),
        )
        .addSubcommand((s) =>
          s
            .setName("dismiss")
            .setDescription("自分の補佐官を解任する")
            .addUserOption((o) => o.setName("user").setDescription("解任する補佐官").setRequired(true)),
        ),
    ),

  async execute(interaction) {
    const actor = await actorFrom(interaction);
    const parliamentPath = `/g/${actor.guildId}/parliament`;
    const billNumber = () => interaction.options.getInteger("bill", true);

    switch (routeOf(interaction)) {
      case "bill submit": {
        const bill = await submitBill(actor, {
          title: interaction.options.getString("title", true),
          content: interaction.options.getString("content", true),
        });
        const body = embed(COLOR.parliament, `第${bill.number}号議案「${bill.title}」提出`)
          .setDescription(truncate(bill.content, 3000))
          .addFields(field("提出", `${BILL_ORIGIN_LABEL[bill.origin as BillOrigin]}（${mention(actor.discordId)}）`, true))
          .setFooter({ text: "議長が /parliament bill open で採決を開始します" });
        await replyEmbed(interaction, body);
        return;
      }

      case "bill list": {
        const filter = (interaction.options.getString("filter") ?? "open") as BillFilter;
        const bills = await listBills(actor.guildId, filter);
        const body = embed(COLOR.parliament, "法案一覧").setDescription(
          bills.length === 0
            ? "該当する法案はありません。"
            : bills
                .map(
                  (b) =>
                    `**第${b.number}号** ${BILL_KIND_LABEL[b.kind as BillKind]}「${truncate(b.title, 60)}」— ${billStatusLabel(b.status, b.kind)}${
                      b.status === "VOTING" && b.votingEndsAt ? `（締切 ${discordTime(b.votingEndsAt, "R")}）` : ""
                    }`,
                )
                .join("\n"),
        );
        await replyEmbed(interaction, body, { components: [linkRow("Webで見る", parliamentPath)] });
        return;
      }

      case "bill info": {
        const detail = await billDetail(actor.guildId, billNumber());
        if (!detail) fail("法案が見つかりません。");
        const { bill, votes, tally } = detail;
        const byChoice = (choice: VoteChoice) => joinNames(votes.filter((v) => v.choice === choice).map((v) => mention(v.citizen.discordId)), "なし");
        const body = embed(COLOR.parliament, `第${bill.number}号 ${BILL_KIND_LABEL[bill.kind as BillKind]}「${bill.title}」`)
          .setDescription(truncate(bill.content, 2500))
          .addFields(
            field("状態", billStatusLabel(bill.status, bill.kind), true),
            field("提出", `${BILL_ORIGIN_LABEL[bill.origin as BillOrigin]}（${mention(bill.proposer.discordId)}）`, true),
            field("可決要件", MAJORITY_LABEL[bill.requiredMajority as Majority], true),
          );
        if (bill.target) body.addFields(field("弾劾の対象", mention(bill.target.discordId), true));
        if (bill.round === 2) body.addFields(field("段階", "再議決", true));
        if (bill.status === "VOTING" && bill.votingEndsAt) body.addFields(field("採決の締切", withRelative(bill.votingEndsAt)));
        if (bill.status === "PASSED" && bill.sanctionDeadline) body.addFields(field("裁可期限", withRelative(bill.sanctionDeadline)));
        if (votes.length > 0) {
          body.addFields(
            field("集計", describeTally(tally)),
            field(`${VOTE_CHOICE_LABEL.FOR}`, byChoice("FOR")),
            field(`${VOTE_CHOICE_LABEL.AGAINST}`, byChoice("AGAINST")),
            field(`${VOTE_CHOICE_LABEL.ABSTAIN}`, byChoice("ABSTAIN")),
          );
        }
        if (bill.vetoReason) body.addFields(field("拒否権の理由", bill.vetoReason));
        if (bill.outcomeNote) body.addFields(field("結果", bill.outcomeNote));
        if (bill.implementedNote) body.addFields(field("施行", bill.implementedNote));
        if (bill.petition) body.addFields(field("請願", `請願 第${bill.petition.number}号から送付`));
        if (bill.threadId) body.addFields(field("議論", `<#${bill.threadId}>`));
        await replyEmbed(interaction, body, { components: [linkRow("Webで見る", parliamentPath)] });
        return;
      }

      case "bill open": {
        const bill = await openBillVote(actor, billNumber(), interaction.options.getInteger("days") ?? undefined);
        await replyEmbed(
          interaction,
          embed(COLOR.parliament, `第${bill.number}号「${bill.title}」採決開始`)
            .setDescription("議員は `/parliament bill vote` で投票してください。全員の投票がそろうと締切前でも集計されます。")
            .addFields(field("採決の締切", bill.votingEndsAt ? withRelative(bill.votingEndsAt) : "—")),
        );
        return;
      }

      case "bill vote": {
        const choice = interaction.options.getString("choice", true) as VoteChoice;
        const { bill, tally, decision } = await castBillVote(actor, billNumber(), choice);
        const body = embed(COLOR.parliament, `第${bill.number}号「${bill.title}」`)
          .setDescription(`${roleTag("国民代表（議員）")} ${mention(actor.discordId)} が \`${VOTE_CHOICE_LABEL[choice]}\` に投票しました（記名投票）。`)
          .addFields(field("現在の集計", describeTally(tally)));
        if (decision) body.addFields(field("結果", `全議員の投票がそろったため集計しました: **${billStatusLabel(decision.status, bill.kind)}**`));
        await replyEmbed(interaction, body);
        return;
      }

      case "bill withdraw": {
        const bill = await withdrawBill(actor, billNumber());
        await replyEmbed(interaction, embed(COLOR.neutral, `第${bill.number}号「${bill.title}」撤回`).setDescription("提出者により撤回されました。"));
        return;
      }

      case "bill override": {
        const bill = await moveOverride(actor, billNumber(), interaction.options.getInteger("days") ?? undefined);
        await replyEmbed(
          interaction,
          embed(COLOR.parliament, `第${bill.number}号「${bill.title}」再議決`)
            .setDescription("管理者派閥の拒否権に対する再議決です。出席議員の3分の2以上の賛成で成立します。")
            .addFields(field("採決の締切", bill.votingEndsAt ? withRelative(bill.votingEndsAt) : "—")),
        );
        return;
      }

      case "elect": {
        const office = interaction.options.getString("office", true) as Office;
        const candidate = interaction.options.getUser("candidate", true);
        const result = await voteForOffice(actor, office, candidate.id);
        const label = OFFICE_LABEL[office];
        const body = embed(result.elected ? COLOR.success : COLOR.parliament, result.elected ? `${label}に ${result.elected.displayName} を選出` : `${label}選挙`)
          .setDescription(`${mention(actor.discordId)} が ${roleTag(label)} の選挙で ${mention(candidate.id)} に投票しました（記名投票）。`)
          .addFields(
            field(
              "得票",
              limitLines(result.ranking.map((r) => `${mention(r.citizen.discordId)}　${r.votes}票`), "なし"),
            ),
            field("当選に必要な票数", `${result.majority}票（在籍議員 ${result.seated}名の過半数）`),
          );
        await replyEmbed(interaction, body);
        return;
      }

      case "no-confidence": {
        const bill = await moveNoConfidence(actor, interaction.options.getString("reason", true));
        await replyEmbed(
          interaction,
          embed(COLOR.danger, `第${bill.number}号 ${bill.title}`)
            .setDescription(`理由: ${bill.content}\n採決はすでに始まっています。可決されると内閣は総辞職します。`)
            .addFields(field("採決の締切", bill.votingEndsAt ? withRelative(bill.votingEndsAt) : "—")),
        );
        return;
      }

      case "impeach": {
        const target = targetOf(interaction, "target");
        const bill = await moveImpeachment(actor, target.user.id, interaction.options.getString("reason", true));
        await replyEmbed(
          interaction,
          embed(COLOR.danger, `第${bill.number}号 ${bill.title}`)
            .setDescription(`理由: ${bill.content}\n出席議員の3分の2以上の賛成で、対象者は全役職（${roleTag("元首")}・${roleTag("管理官")}を除く）から罷免されます。`)
            .addFields(field("採決の締切", bill.votingEndsAt ? withRelative(bill.votingEndsAt) : "—")),
        );
        return;
      }

      case "members": {
        const roster = await parliamentRoster(actor.guildId);
        const aidesOf = (citizenId: string) => roster.aides.filter((a) => a.appointedById === citizenId).map((a) => a.citizen.displayName);
        const body = embed(COLOR.parliament, `議員名簿（${roster.representatives.length}/${roster.seats}議席）`).addFields(
          field(roleTag("議長"), roster.speaker ? mention(roster.speaker.citizen.discordId) : "空席（`/parliament elect` で選出）", true),
          field(roleTag("副議長"), roster.viceSpeaker ? mention(roster.viceSpeaker.citizen.discordId) : "空席", true),
          field(
            roleTag("国民代表（議員）"),
            limitLines(
              roster.representatives.map((r) => {
                const aides = aidesOf(r.citizenId);
                return `${mention(r.citizen.discordId)}${r.expiresAt ? `　任期 ${discordTime(r.expiresAt, "d")}まで` : ""}${aides.length > 0 ? `　${roleTag("補佐官")} ${aides.join("、")}` : ""}`;
              }),
              "議員はいません（選挙を実施してください）",
            ),
          ),
        );
        const offices = new Map<string, Map<string, number>>();
        for (const vote of roster.officeVotes) {
          const tally = offices.get(vote.office) ?? new Map<string, number>();
          tally.set(vote.candidate.displayName, (tally.get(vote.candidate.displayName) ?? 0) + 1);
          offices.set(vote.office, tally);
        }
        for (const [office, tally] of offices) {
          body.addFields(
            field(`${roleTag(OFFICE_LABEL[office as Office])} 選挙（進行中）`, [...tally].map(([name, votes]) => `${name}: ${votes}票`).join("\n")),
          );
        }
        await replyEmbed(interaction, body);
        return;
      }

      case "aide appoint": {
        const target = targetOf(interaction, "user");
        const position = await appointAide(actor, target.user.id, target.isDiscordAdmin);
        await replyEmbed(interaction, embed(COLOR.success, "補佐官の任命").setDescription(`${mention(target.user.id)} を ${roleTag(position.title)} に任命しました。`));
        return;
      }

      case "aide dismiss": {
        const target = targetOf(interaction, "user");
        await dismissAide(actor, target.user.id);
        await replyEmbed(interaction, embed(COLOR.neutral, "補佐官の解任").setDescription(`${mention(target.user.id)} を ${roleTag("補佐官")} から解任しました。`));
        return;
      }
    }
  },

  async autocomplete(interaction) {
    switch (routeOf(interaction)) {
      case "bill info":
        return suggestBills(interaction);
      case "bill open":
      case "bill withdraw":
        return suggestBills(interaction, ["DELIBERATION"]);
      case "bill vote":
        return suggestBills(interaction, ["VOTING"]);
      case "bill override":
        return suggestBills(interaction, ["VETOED"]);
    }
  },
};
