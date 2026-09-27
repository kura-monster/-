import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { prisma } from "../src/lib/prisma";
import { adminAppoint, revokeCitizenship } from "../src/services/admin";
import { cabinetAppoint } from "../src/services/cabinet";
import { citizenProfile, registerCitizen, removeCitizenship, restoreCitizenship } from "../src/services/citizen";
import { voteForOffice } from "../src/services/parliament";
import { appointAide } from "../src/services/parliament";
import { GUILD, activeKeys, actor, daysLater, discordIdOf, register, seatRepresentatives, setupGuild } from "./helpers";

describe("市民登録", () => {
  before(() => setupGuild({ minAccountAgeDays: 7, minMembershipDays: 3 }));

  it("アカウント年齢とサーバー在籍日数を満たさないと登録できない", async () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const base = { discordId: "fresh", displayName: "新人", avatarUrl: null };
    await assert.rejects(
      registerCitizen(GUILD, { ...base, accountCreatedAt: daysLater(now, -2), joinedAt: daysLater(now, -30) }, now),
      /アカウントの作成から 7 日/,
    );
    await assert.rejects(
      registerCitizen(GUILD, { ...base, accountCreatedAt: daysLater(now, -30), joinedAt: daysLater(now, -1) }, now),
      /参加から 3 日/,
    );
    const { citizen } = await registerCitizen(GUILD, { ...base, accountCreatedAt: daysLater(now, -30), joinedAt: daysLater(now, -5) }, now);
    assert.equal(citizen.number, 1);
    await assert.rejects(
      registerCitizen(GUILD, { ...base, accountCreatedAt: daysLater(now, -30), joinedAt: daysLater(now, -5) }, now),
      /すでに市民番号 1/,
    );
  });
});

describe("市民権の喪失", () => {
  before(async () => {
    await setupGuild();
    await seatRepresentatives(["alice", "bob", "carol"]);
    await register("dave");
    await voteForOffice(actor("alice"), "SPEAKER", discordIdOf("alice"));
    await voteForOffice(actor("bob"), "SPEAKER", discordIdOf("alice"));
    await appointAide(actor("alice"), discordIdOf("dave"), false);
  });

  it("議員が市民登録を抹消すると議長職と補佐官も連鎖して終わる", async () => {
    assert.deepEqual(await activeKeys("alice"), ["REPRESENTATIVE", "SPEAKER"]);
    assert.deepEqual(await activeKeys("dave"), ["AIDE"]);
    const result = await removeCitizenship(GUILD, { discordId: discordIdOf("alice"), displayName: "alice", avatarUrl: null }, "SELF");
    assert.ok(result);
    assert.deepEqual(await activeKeys("alice"), []);
    assert.deepEqual(await activeKeys("dave"), []);
    const entry = await prisma.gazetteEntry.findFirst({ where: { guildId: GUILD, title: { contains: "市民の離脱" } } });
    assert.ok(entry?.body.includes("補佐官"));
  });

  it("停止された市民権は回復されるまで再登録できない", async () => {
    await revokeCitizenship(actor("admin", true), { discordId: discordIdOf("bob"), displayName: "bob", avatarUrl: null }, "サブアカウント");
    await assert.rejects(register("bob"), /市民権が停止/);
    await assert.rejects(restoreCitizenship(actor("carol"), discordIdOf("bob")), /管理者のみ/);
    await restoreCitizenship(actor("admin", true), discordIdOf("bob"));
    const again = await register("bob");
    assert.equal(again.active, true);
  });

  it("未登録ユーザーの市民権停止は将来の登録を防ぐ", async () => {
    await revokeCitizenship(actor("admin", true), { discordId: discordIdOf("troll"), displayName: "troll", avatarUrl: null }, "荒らし");
    await assert.rejects(register("troll"), /市民権が停止/);
  });

  it("プロフィールに経歴が残る", async () => {
    const profile = await citizenProfile(GUILD, discordIdOf("alice"));
    assert.ok(profile);
    assert.equal(profile.current.length, 0);
    assert.ok(profile.history.some((p) => p.key === "SPEAKER" && p.endReason?.includes("議員の失職")));
    assert.equal(profile.electedCount, 1);
  });
});

describe("派閥の分離", () => {
  before(async () => {
    await setupGuild();
    await seatRepresentatives(["pm", "rep2"]);
    await register("adminUser");
    await voteForOffice(actor("pm"), "PRIME_MINISTER", discordIdOf("pm"));
    await voteForOffice(actor("rep2"), "PRIME_MINISTER", discordIdOf("pm"));
  });

  it("Discord管理者は既定では国民代表派閥の役職に就けない", async () => {
    await assert.rejects(
      cabinetAppoint(actor("pm"), "MINISTER", { discordId: discordIdOf("adminUser"), isDiscordAdmin: true }, "外務"),
      /管理者派閥/,
    );
    await prisma.guild.update({ where: { id: GUILD }, data: { allowAdminParticipation: true } });
    await cabinetAppoint(actor("pm"), "MINISTER", { discordId: discordIdOf("adminUser"), isDiscordAdmin: true }, "外務");
    assert.deepEqual(await activeKeys("adminUser"), ["MINISTER"]);
  });

  it("管理官は元首と兼任できない", async () => {
    const target = { discordId: discordIdOf("owner"), displayName: "owner", avatarUrl: null, isDiscordAdmin: true };
    await adminAppoint(actor("admin", true), "SOVEREIGN", target);
    await assert.rejects(adminAppoint(actor("admin", true), "ADMINISTRATOR", target), /元首は他の役職を兼任できません/);
  });
});
