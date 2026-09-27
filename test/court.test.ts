import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { prisma } from "../src/lib/prisma";
import { adminAppoint } from "../src/services/admin";
import { cabinetAppoint } from "../src/services/cabinet";
import {
  appealCase,
  assignJudge,
  fileCase,
  issueFinalRuling,
  issueVerdict,
  respondToCase,
  takeCase,
  withdrawCase,
} from "../src/services/court";
import { voteForOffice } from "../src/services/parliament";
import { runDueTasks } from "../src/services/scheduler";
import { GUILD, actor, discordIdOf, flush, recordEvents, register, seatRepresentatives, setupGuild } from "./helpers";

const T0 = new Date("2026-08-20T00:00:00Z");
const hoursLater = (hours: number) => new Date(T0.getTime() + hours * 3_600_000);

async function caseStatus(number: number) {
  return prisma.courtCase.findUniqueOrThrow({ where: { guildId_number: { guildId: GUILD, number } } });
}

describe("裁判所", () => {
  beforeEach(async () => {
    await setupGuild({ appealHours: 24 });
    await seatRepresentatives(["pm", "r2"], T0);
    for (const name of ["plaintiff", "defendant", "judge1", "judge2"]) await register(name, T0);
    await voteForOffice(actor("pm"), "PRIME_MINISTER", discordIdOf("pm"));
    await voteForOffice(actor("r2"), "PRIME_MINISTER", discordIdOf("pm"));
    await cabinetAppoint(actor("pm"), "JUDGE", { discordId: discordIdOf("judge1"), isDiscordAdmin: false }, undefined);
    await cabinetAppoint(actor("pm"), "JUDGE", { discordId: discordIdOf("judge2"), isDiscordAdmin: false }, undefined);
  });

  it("提訴→担当→判決→上告期間経過で確定し、制裁の執行が要求される", async () => {
    await assert.rejects(fileCase(actor("plaintiff"), discordIdOf("plaintiff"), "t", "c", T0), /自分自身/);
    const filed = await fileCase(actor("plaintiff"), discordIdOf("defendant"), "暴言事件", "#雑談で暴言", T0);
    await assert.rejects(fileCase(actor("plaintiff"), discordIdOf("defendant"), "t", "c", T0), /係属中の事件/);
    await respondToCase(actor("defendant"), filed.number, "冗談のつもりでした");
    await assert.rejects(takeCase(actor("plaintiff"), filed.number), /裁判官のみ/);
    await takeCase(actor("judge1"), filed.number);
    await assert.rejects(takeCase(actor("judge2"), filed.number), /すでに担当裁判官/);

    const ruling = { result: "PLAINTIFF_WINS" as const, ruling: "発言は規約違反", penalty: "TIMEOUT_1H" as const };
    await assert.rejects(issueVerdict(actor("judge2"), filed.number, ruling, T0), /担当裁判官ではありません/);
    await assert.rejects(
      issueVerdict(actor("judge1"), filed.number, { ...ruling, result: "DEFENDANT_WINS" }, T0),
      /原告勝訴の場合のみ/,
    );
    await issueVerdict(actor("judge1"), filed.number, ruling, T0);
    assert.equal((await caseStatus(filed.number)).status, "VERDICT");

    const rec = recordEvents();
    await runDueTasks(hoursLater(12));
    assert.equal((await caseStatus(filed.number)).status, "VERDICT");
    await runDueTasks(hoursLater(25));
    await flush();
    rec.stop();
    const final = await caseStatus(filed.number);
    assert.equal(final.status, "FINAL");
    assert.equal(final.penaltyStatus, "PENDING");
    assert.ok(rec.events.some((e) => e.type === "penaltyDue" && e.caseId === filed.id));
  });

  it("上告は長官が審理し、長官不在なら原審以外の裁判官が審理する", async () => {
    const filed = await fileCase(actor("plaintiff"), discordIdOf("defendant"), "名誉毀損", "...", T0);
    await takeCase(actor("judge1"), filed.number);
    await issueVerdict(actor("judge1"), filed.number, { result: "PLAINTIFF_WINS", ruling: "警告相当", penalty: "WARNING" }, T0);
    await assert.rejects(appealCase(actor("judge2"), filed.number, "...", hoursLater(1)), /当事者/);
    await appealCase(actor("defendant"), filed.number, "事実誤認", hoursLater(1));

    const dismissal = { result: "DEFENDANT_WINS" as const, ruling: "原判決破棄", penalty: "NONE" as const };
    await assert.rejects(issueFinalRuling(actor("judge1"), filed.number, dismissal, hoursLater(2)), /原審を担当していない/);
    const decided = await issueFinalRuling(actor("judge2"), filed.number, dismissal, hoursLater(2));
    assert.equal(decided.status, "FINAL");
    assert.equal(decided.penaltyStatus, null);

    const second = await fileCase(actor("defendant"), discordIdOf("plaintiff"), "反訴", "...", T0);
    await adminAppoint(actor("admin", true), "CHIEF_JUSTICE", { discordId: discordIdOf("chief"), displayName: "chief", avatarUrl: null, isDiscordAdmin: false });
    await assignJudge(actor("chief"), second.number, discordIdOf("judge1"));
    await issueVerdict(actor("judge1"), second.number, { result: "PLAINTIFF_WINS", ruling: "...", penalty: "WARNING" }, T0);
    await appealCase(actor("plaintiff"), second.number, "...", hoursLater(1));
    await assert.rejects(issueFinalRuling(actor("judge2"), second.number, dismissal, hoursLater(2)), /最高裁判所長官が言い渡します/);
    const upheld = await issueFinalRuling(actor("chief"), second.number, { result: "PLAINTIFF_WINS", ruling: "原判決維持", penalty: "WARNING" }, hoursLater(2));
    assert.equal(upheld.penaltyStatus, "EXECUTED");
  });

  it("自動執行が無効ならタイムアウトは執行されない / 原告は判決前に取り下げられる", async () => {
    await prisma.guild.update({ where: { id: GUILD }, data: { enforcePenalties: false } });
    const filed = await fileCase(actor("plaintiff"), discordIdOf("defendant"), "荒らし", "...", T0);
    await takeCase(actor("judge1"), filed.number);
    await issueVerdict(actor("judge1"), filed.number, { result: "PLAINTIFF_WINS", ruling: "...", penalty: "TIMEOUT_1D" }, T0);
    await runDueTasks(hoursLater(30));
    assert.equal((await caseStatus(filed.number)).penaltyStatus, "SKIPPED");

    const other = await fileCase(actor("defendant"), discordIdOf("plaintiff"), "別件", "...", T0);
    await assert.rejects(withdrawCase(actor("plaintiff"), other.number), /原告のみ/);
    await withdrawCase(actor("defendant"), other.number);
    assert.equal((await caseStatus(other.number)).status, "WITHDRAWN");
  });

  it("当事者は自分の事件を担当できない", async () => {
    await cabinetAppoint(actor("pm"), "JUDGE", { discordId: discordIdOf("plaintiff"), isDiscordAdmin: false }, undefined);
    const filed = await fileCase(actor("plaintiff"), discordIdOf("defendant"), "利益相反", "...", T0);
    await assert.rejects(takeCase(actor("plaintiff"), filed.number), /利益相反/);
  });
});
