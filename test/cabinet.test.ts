import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { prisma } from "../src/lib/prisma";
import { sanctionBill } from "../src/services/admin";
import { cabinetAppoint, cabinetDismiss, cabinetResign, implementLaw, issueStatement } from "../src/services/cabinet";
import { castBillVote, openBillVote, submitBill, voteForOffice } from "../src/services/parliament";
import { GUILD, activeKeys, actor, discordIdOf, register, seatRepresentatives, setupGuild } from "./helpers";

const T0 = new Date("2026-08-10T00:00:00Z");
const target = (name: string) => ({ discordId: discordIdOf(name), isDiscordAdmin: false });

describe("内閣", () => {
  beforeEach(async () => {
    await setupGuild();
    await seatRepresentatives(["pm", "speaker"], T0);
    for (const name of ["m1", "m2", "ccs", "someone"]) await register(name, T0);
    await voteForOffice(actor("pm"), "PRIME_MINISTER", discordIdOf("pm"));
    await voteForOffice(actor("speaker"), "PRIME_MINISTER", discordIdOf("pm"));
    await voteForOffice(actor("pm"), "SPEAKER", discordIdOf("speaker"));
    await voteForOffice(actor("speaker"), "SPEAKER", discordIdOf("speaker"));
  });

  it("首相だけが閣僚を任命でき、大臣名は正規化され重複できない", async () => {
    await assert.rejects(cabinetAppoint(actor("speaker"), "MINISTER", target("m1"), "外務"), /内閣総理大臣のみ/);
    const position = await cabinetAppoint(actor("pm"), "MINISTER", target("m1"), "外務");
    assert.equal(position.title, "外務大臣");
    await assert.rejects(cabinetAppoint(actor("pm"), "MINISTER", target("m2"), "外務大臣"), /すでに在任者/);
    await assert.rejects(cabinetAppoint(actor("pm"), "MINISTER", target("m2"), "  "), /担当分野/);
    await assert.rejects(cabinetAppoint(actor("pm"), "DEPUTY_PRIME_MINISTER", target("m1"), undefined), /閣僚ポストは1人1つ/);
    await assert.rejects(cabinetAppoint(actor("pm"), "MINISTER", target("speaker"), "財務"), /立法と行政の分離/);
  });

  it("罷免・談話・総辞職", async () => {
    await cabinetAppoint(actor("pm"), "CHIEF_CABINET_SECRETARY", target("ccs"), undefined);
    await cabinetAppoint(actor("pm"), "MINISTER", target("m1"), "デジタル");
    await cabinetAppoint(actor("pm"), "JUDGE", target("someone"), undefined);

    await assert.rejects(issueStatement(actor("m1"), "所信", "..."), /内閣総理大臣と内閣官房長官/);
    const statement = await issueStatement(actor("ccs"), "記者会見", "本日の閣議決定について");
    assert.match(statement.title, /内閣官房長官談話/);

    await cabinetDismiss(actor("pm"), discordIdOf("m1"), "MINISTER");
    assert.deepEqual(await activeKeys("m1"), []);

    await cabinetResign(actor("pm"));
    assert.deepEqual(await activeKeys("pm"), ["REPRESENTATIVE"]);
    assert.deepEqual(await activeKeys("ccs"), []);
    assert.deepEqual(await activeKeys("someone"), ["JUDGE"]);
  });

  it("成立した法律の施行は閣僚か管理者が記録する", async () => {
    await cabinetAppoint(actor("pm"), "MINISTER", target("m1"), "総務");
    const bill = await submitBill(actor("m1"), { title: "チャンネル整理法", content: "..." }, T0);
    assert.equal(bill.origin, "CABINET");
    await openBillVote(actor("speaker"), bill.number, undefined, T0);
    await castBillVote(actor("pm"), bill.number, "FOR", T0);
    await castBillVote(actor("speaker"), bill.number, "FOR", T0);
    await assert.rejects(implementLaw(actor("m1"), bill.number, undefined), /成立済みの法律ではありません/);
    await sanctionBill(actor("admin", true), bill.number);
    await assert.rejects(implementLaw(actor("someone"), bill.number, undefined), /閣僚または管理者/);
    await implementLaw(actor("m1"), bill.number, "チャンネルを3つ統合しました");
    const stored = await prisma.bill.findUniqueOrThrow({ where: { guildId_number: { guildId: GUILD, number: bill.number } } });
    assert.equal(stored.status, "IMPLEMENTED");
  });
});
