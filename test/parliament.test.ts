import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { prisma } from "../src/lib/prisma";
import { adminAppoint, dissolveParliament, sanctionBill, vetoBill } from "../src/services/admin";
import { cabinetAppoint } from "../src/services/cabinet";
import {
  castBillVote,
  moveImpeachment,
  moveNoConfidence,
  moveOverride,
  openBillVote,
  submitBill,
  voteForOffice,
  withdrawBill,
} from "../src/services/parliament";
import { runDueTasks } from "../src/services/scheduler";
import { GUILD, activeKeys, actor, daysLater, discordIdOf, flush, recordEvents, register, seatRepresentatives, setupGuild } from "./helpers";

const T0 = new Date("2026-08-01T00:00:00Z");

async function billStatus(number: number): Promise<string> {
  const bill = await prisma.bill.findUniqueOrThrow({ where: { guildId_number: { guildId: GUILD, number } } });
  return bill.status;
}

describe("院内選挙", () => {
  beforeEach(async () => {
    await setupGuild();
    await seatRepresentatives(["a", "b", "c"], T0);
    await register("outsider", T0);
  });

  it("過半数の得票で議長が決まる", async () => {
    await assert.rejects(voteForOffice(actor("outsider"), "SPEAKER", discordIdOf("a")), /国民代表（議員）のみ/);
    await assert.rejects(voteForOffice(actor("a"), "SPEAKER", discordIdOf("outsider")), /議員しか選ばれません/);
    const first = await voteForOffice(actor("a"), "SPEAKER", discordIdOf("b"));
    assert.equal(first.elected, null);
    assert.equal(first.majority, 2);
    const second = await voteForOffice(actor("c"), "SPEAKER", discordIdOf("b"));
    assert.equal(second.elected?.displayName, "b");
    assert.deepEqual(await activeKeys("b"), ["REPRESENTATIVE", "SPEAKER"]);
    await assert.rejects(voteForOffice(actor("a"), "SPEAKER", discordIdOf("c")), /在任中/);
  });

  it("議長は首相に指名できない（立法と行政の分離）", async () => {
    await voteForOffice(actor("a"), "SPEAKER", discordIdOf("b"));
    await voteForOffice(actor("c"), "SPEAKER", discordIdOf("b"));
    await assert.rejects(voteForOffice(actor("a"), "PRIME_MINISTER", discordIdOf("b")), /立法と行政の分離/);
  });
});

describe("法案の審議・採決・裁可", () => {
  beforeEach(async () => {
    await setupGuild({ sanctionDays: 3, billVotingDays: 2 });
    await seatRepresentatives(["speaker", "r2", "r3"], T0);
    await register("citizen", T0);
    await voteForOffice(actor("speaker"), "SPEAKER", discordIdOf("speaker"));
    await voteForOffice(actor("r2"), "SPEAKER", discordIdOf("speaker"));
  });

  it("議員が提出し、議長が採決を開始し、全員投票で即時に可決→裁可で成立", async () => {
    await assert.rejects(submitBill(actor("citizen"), { title: "x", content: "y" }), /請願/);
    const rec = recordEvents();
    const bill = await submitBill(actor("r2"), { title: "雑談チャンネル新設法", content: "#雑談2 を作る" }, T0);
    await flush();
    rec.stop();
    assert.ok(rec.events.some((e) => e.type === "billCreated"));
    assert.equal(bill.origin, "MEMBER");

    await assert.rejects(openBillVote(actor("r3"), bill.number, undefined, T0), /議長・副議長のみ/);
    await openBillVote(actor("speaker"), bill.number, undefined, T0);
    await assert.rejects(castBillVote(actor("citizen"), bill.number, "FOR", T0), /議員）のみ/);
    await castBillVote(actor("r2"), bill.number, "FOR", T0);
    await castBillVote(actor("r3"), bill.number, "AGAINST", T0);
    await castBillVote(actor("r3"), bill.number, "FOR", T0);
    const last = await castBillVote(actor("speaker"), bill.number, "ABSTAIN", T0);
    assert.equal(last.decision?.status, "PASSED");
    assert.equal(await billStatus(bill.number), "PASSED");

    await assert.rejects(sanctionBill(actor("r2"), bill.number), /管理者専用/);
    await sanctionBill(actor("admin", true), bill.number);
    assert.equal(await billStatus(bill.number), "ENACTED");
  });

  it("可否同数は議長決裁、定足数不足は否決", async () => {
    const tie = await submitBill(actor("r2"), { title: "同数法", content: "..." }, T0);
    await openBillVote(actor("speaker"), tie.number, undefined, T0);
    await castBillVote(actor("speaker"), tie.number, "FOR", T0);
    await castBillVote(actor("r2"), tie.number, "AGAINST", T0);
    const decided = await castBillVote(actor("r3"), tie.number, "ABSTAIN", T0);
    assert.equal(decided.decision?.status, "PASSED");
    assert.equal(decided.decision?.tally.tieBreak, "SPEAKER_FOR");

    await prisma.guild.update({ where: { id: GUILD }, data: { seats: 6 } });
    await seatRepresentatives(["q1", "q2", "q3", "q4", "q5", "q6"], T0);
    const quorum = await submitBill(actor("q1"), { title: "定足数法", content: "..." }, T0);
    await openBillVote(actor("q1"), quorum.number, 1, T0);
    await castBillVote(actor("q1"), quorum.number, "FOR", T0);
    await runDueTasks(daysLater(T0, 2));
    const bill = await prisma.bill.findUniqueOrThrow({ where: { guildId_number: { guildId: GUILD, number: quorum.number } } });
    assert.equal(bill.status, "REJECTED");
    assert.equal(bill.outcomeNote, "定足数不足");
  });

  it("拒否権→3分の2で再可決、放置された可決法案は期限後に自動成立", async () => {
    const vetoed = await submitBill(actor("r2"), { title: "再議決法", content: "..." }, T0);
    await openBillVote(actor("speaker"), vetoed.number, undefined, T0);
    for (const name of ["speaker", "r2", "r3"]) await castBillVote(actor(name), vetoed.number, "FOR", T0);
    await vetoBill(actor("admin", true), vetoed.number, "時期尚早");
    assert.equal(await billStatus(vetoed.number), "VETOED");
    await moveOverride(actor("r3"), vetoed.number, undefined, T0);
    await castBillVote(actor("speaker"), vetoed.number, "FOR", T0);
    await castBillVote(actor("r2"), vetoed.number, "FOR", T0);
    const override = await castBillVote(actor("r3"), vetoed.number, "AGAINST", T0);
    assert.equal(override.decision?.status, "ENACTED");
    await assert.rejects(vetoBill(actor("admin", true), vetoed.number, "again"), /裁可待ち/);

    const ignored = await submitBill(actor("r2"), { title: "放置法", content: "..." }, T0);
    await openBillVote(actor("speaker"), ignored.number, undefined, T0);
    for (const name of ["speaker", "r2", "r3"]) await castBillVote(actor(name), ignored.number, "FOR", T0);
    await runDueTasks(daysLater(T0, 2));
    assert.equal(await billStatus(ignored.number), "PASSED");
    await runDueTasks(daysLater(T0, 4));
    assert.equal(await billStatus(ignored.number), "ENACTED");
  });

  it("撤回は提出者が採決前にのみ行える", async () => {
    const bill = await submitBill(actor("r2"), { title: "撤回法", content: "..." }, T0);
    await assert.rejects(withdrawBill(actor("r3"), bill.number), /提出者のみ/);
    await withdrawBill(actor("r2"), bill.number);
    assert.equal(await billStatus(bill.number), "WITHDRAWN");
  });
});

describe("不信任・弾劾・解散", () => {
  beforeEach(async () => {
    await setupGuild();
    await seatRepresentatives(["pm", "r2", "r3"], T0);
    await register("minister", T0);
    await register("judge", T0);
    await voteForOffice(actor("pm"), "PRIME_MINISTER", discordIdOf("pm"));
    await voteForOffice(actor("r2"), "PRIME_MINISTER", discordIdOf("pm"));
    await cabinetAppoint(actor("pm"), "MINISTER", { discordId: discordIdOf("minister"), isDiscordAdmin: false }, "防衛", T0);
    await cabinetAppoint(actor("pm"), "JUDGE", { discordId: discordIdOf("judge"), isDiscordAdmin: false }, undefined, T0);
  });

  it("内閣不信任決議の可決で内閣が総辞職する", async () => {
    const motion = await moveNoConfidence(actor("r2"), "公約違反", T0);
    assert.equal(motion.status, "VOTING");
    await assert.rejects(moveNoConfidence(actor("r3"), "重複", T0), /採決中の内閣不信任決議案/);
    await castBillVote(actor("r2"), motion.number, "FOR", T0);
    await castBillVote(actor("r3"), motion.number, "FOR", T0);
    await castBillVote(actor("pm"), motion.number, "AGAINST", T0);
    assert.deepEqual(await activeKeys("pm"), ["REPRESENTATIVE"]);
    assert.deepEqual(await activeKeys("minister"), []);
    assert.deepEqual(await activeKeys("judge"), ["JUDGE"], "裁判官は内閣と運命を共にしない");
  });

  it("弾劾は3分の2で罷免、元首・管理官は対象外", async () => {
    const motion = await moveImpeachment(actor("r2"), discordIdOf("judge"), "不公正な判決", T0);
    assert.equal(motion.requiredMajority, "TWO_THIRDS");
    await castBillVote(actor("r2"), motion.number, "FOR", T0);
    await castBillVote(actor("r3"), motion.number, "FOR", T0);
    await castBillVote(actor("pm"), motion.number, "AGAINST", T0);
    assert.deepEqual(await activeKeys("judge"), []);

    await adminAppoint(actor("admin", true), "SOVEREIGN", { discordId: discordIdOf("king"), displayName: "king", avatarUrl: null, isDiscordAdmin: true });
    await assert.rejects(moveImpeachment(actor("r2"), discordIdOf("king"), "..."), /元首・管理官は対象外/);
  });

  it("解散で議員は失職し総選挙が告示され、内閣は選挙確定まで職務を継続する", async () => {
    await submitBill(actor("r2"), { title: "審議中法案", content: "..." }, T0);
    await assert.rejects(dissolveParliament(actor("r2"), "..."), /管理者専用/);
    const election = await dissolveParliament(actor("admin", true), "民意を問う", T0);
    assert.equal(election.kind, "GENERAL");
    assert.deepEqual(await activeKeys("r2"), []);
    assert.deepEqual(await activeKeys("pm"), ["PRIME_MINISTER"]);
    assert.deepEqual(await activeKeys("minister"), ["MINISTER"]);
    const lapsed = await prisma.bill.findFirstOrThrow({ where: { title: "審議中法案" } });
    assert.equal(lapsed.status, "LAPSED");
  });
});
