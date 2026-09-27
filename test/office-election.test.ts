import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { prisma } from "../src/lib/prisma";
import { cabinetAppoint } from "../src/services/cabinet";
import { castBallot, closeRegistration, finalizeElection, standForElection, startElection } from "../src/services/election";
import { voteForOffice } from "../src/services/parliament";
import { run, type FakePerson } from "./discord-harness";
import { GUILD, activeKeys, actor, daysLater, discordIdOf, register, seatRepresentatives, setupGuild } from "./helpers";

const T0 = new Date("2026-08-01T00:00:00Z");
const T1 = daysLater(T0, 1);
const admin = actor("admin", true);

async function vote(electionId: string, votes: Record<string, string>) {
  for (const [voter, choice] of Object.entries(votes)) {
    const candidate = await prisma.candidate.findFirstOrThrow({ where: { electionId, citizen: { discordId: discordIdOf(choice) } } });
    await castBallot(GUILD, discordIdOf(voter), electionId, candidate.id, T1);
  }
}

async function positionOf(name: string, key: string) {
  return prisma.position.findFirst({ where: { guildId: GUILD, key, citizen: { discordId: discordIdOf(name) } }, orderBy: { startedAt: "desc" } });
}

/** alice, bob and carol sit in parliament and elect bob Prime Minister (two votes are a majority of three). */
async function parliamentWithPrimeMinister() {
  await seatRepresentatives(["alice", "bob", "carol"], T0);
  for (const name of ["alice", "bob"]) await voteForOffice(actor(name), "PRIME_MINISTER", discordIdOf("bob"), T0);
  for (const name of ["dave", "eve", "frank"]) await register(name, T0);
}

describe("役職選挙", () => {
  beforeEach(() => setupGuild({ seats: 3 }));

  it("首相の選挙: 候補は議員だけ。当選者が首相になり、前の首相の内閣は総辞職する", async () => {
    await parliamentWithPrimeMinister();
    await cabinetAppoint(actor("bob"), "MINISTER", { discordId: discordIdOf("dave"), isDiscordAdmin: false }, "外務");

    const election = await startElection(admin, { kind: "OFFICE", position: "PRIME_MINISTER" }, T0);
    assert.deepEqual([election.title, election.kind, election.position, election.seats], ["第2回 内閣総理大臣選挙", "OFFICE", "PRIME_MINISTER", 1]);
    await assert.rejects(standForElection(actor("eve"), undefined, T0), /内閣総理大臣に立候補できるのは現職の議員だけです/);
    await standForElection(actor("alice"), "改革を進めます", T0);
    await standForElection(actor("bob"), "続投します", T0);

    assert.equal((await closeRegistration(GUILD, election.id, T1))?.status, "VOTING");
    await vote(election.id, { alice: "alice", carol: "alice", eve: "alice", bob: "bob", dave: "bob" });
    await finalizeElection(GUILD, election.id, T1);

    assert.deepEqual(await activeKeys("alice"), ["PRIME_MINISTER", "REPRESENTATIVE"]);
    assert.equal((await positionOf("alice", "PRIME_MINISTER"))?.source, "ELECTION");
    assert.equal((await positionOf("bob", "PRIME_MINISTER"))?.endReason, "選挙による交代");
    assert.equal((await positionOf("dave", "MINISTER"))?.endReason, "内閣総辞職");
    const gazette = await prisma.gazetteEntry.findMany({ where: { guildId: GUILD }, orderBy: { number: "asc" } });
    assert.ok(gazette.some((g) => g.title === "bob内閣 総辞職"));
    const result = gazette.find((g) => g.title === "第2回 内閣総理大臣選挙 当選確定");
    assert.match(result?.body ?? "", /当選　alice　3票/);
    assert.match(result?.body ?? "", /bob は \{`内閣総理大臣`\} を退任しました/);
  });

  it("首相の選挙で現職が再選されれば、内閣はそのまま", async () => {
    await parliamentWithPrimeMinister();
    await cabinetAppoint(actor("bob"), "MINISTER", { discordId: discordIdOf("dave"), isDiscordAdmin: false }, "外務");
    const election = await startElection(admin, { kind: "OFFICE", position: "PRIME_MINISTER" }, T0);
    await standForElection(actor("bob"), undefined, T0);
    await closeRegistration(GUILD, election.id, T1);
    assert.deepEqual(await activeKeys("bob"), ["PRIME_MINISTER", "REPRESENTATIVE"]);
    assert.equal((await positionOf("bob", "PRIME_MINISTER"))?.endedAt, null);
    assert.deepEqual(await activeKeys("dave"), ["MINISTER"]);
  });

  it("国務大臣の選挙: 担当分野が必要。同じ大臣の現職とは交代し、別の大臣を務める当選者はそちらを辞める", async () => {
    await parliamentWithPrimeMinister();
    await cabinetAppoint(actor("bob"), "MINISTER", { discordId: discordIdOf("dave"), isDiscordAdmin: false }, "外務");
    await cabinetAppoint(actor("bob"), "MINISTER", { discordId: discordIdOf("eve"), isDiscordAdmin: false }, "財務大臣");

    await assert.rejects(startElection(admin, { kind: "OFFICE", position: "MINISTER" }, T0), /担当分野/);
    const election = await startElection(admin, { kind: "OFFICE", position: "MINISTER", portfolio: "外務" }, T0);
    assert.deepEqual([election.title, election.positionTitle], ["第2回 外務大臣選挙", "外務大臣"]);
    await standForElection(actor("dave"), undefined, T0);
    await standForElection(actor("eve"), undefined, T0);
    await closeRegistration(GUILD, election.id, T1);
    await vote(election.id, { alice: "eve", bob: "eve", carol: "dave" });
    await finalizeElection(GUILD, election.id, T1);

    const eve = await prisma.position.findMany({ where: { guildId: GUILD, citizen: { discordId: discordIdOf("eve") } } });
    assert.deepEqual(Object.fromEntries(eve.map((p) => [p.title, p.endReason])), { 財務大臣: "外務大臣への就任に伴う退任", 外務大臣: null });
    assert.equal((await positionOf("dave", "MINISTER"))?.endReason, "選挙による交代");
  });

  it("裁判官の選挙: 欠員を補う。人数は欠員まで、現職や兼任できない人は立候補できない", async () => {
    await parliamentWithPrimeMinister();
    await cabinetAppoint(actor("bob"), "JUDGE", { discordId: discordIdOf("dave"), isDiscordAdmin: false }, undefined);

    await assert.rejects(startElection(admin, { kind: "OFFICE", position: "JUDGE", seats: 9 }, T0), /1〜8名/);
    const election = await startElection(admin, { kind: "OFFICE", position: "JUDGE", seats: 2 }, T0);
    assert.equal(election.seats, 2);
    await assert.rejects(standForElection(actor("dave"), undefined, T0), /同じ役職にすでに就いています/);
    await assert.rejects(standForElection(actor("alice"), undefined, T0), /司法の独立/);
    await standForElection(actor("eve"), undefined, T0);
    await standForElection(actor("frank"), undefined, T0);

    assert.equal((await closeRegistration(GUILD, election.id, T1))?.status, "COMPLETED", "unopposed");
    assert.deepEqual(await activeKeys("eve"), ["JUDGE"]);
    assert.deepEqual(await activeKeys("frank"), ["JUDGE"]);
    assert.equal(await prisma.position.count({ where: { guildId: GUILD, key: "JUDGE", endedAt: null } }), 3);
  });

  it("管理者は中立の役職には立候補できるが、国民代表派閥の役職にはできない", async () => {
    await register("admin", T0);
    const justice = await startElection(admin, { kind: "OFFICE", position: "CHIEF_JUSTICE" }, T0);
    await standForElection(admin, undefined, T0);
    await closeRegistration(GUILD, justice.id, T1);
    assert.deepEqual(await activeKeys("admin"), ["CHIEF_JUSTICE"]);

    await startElection(admin, { kind: "OFFICE", position: "CHIEF_CABINET_SECRETARY" }, T1);
    await assert.rejects(standForElection(admin, undefined, T1), /管理者派閥/);
  });

  it("元首・管理官・補佐官は選挙で選べない", async () => {
    for (const position of ["SOVEREIGN", "ADMINISTRATOR", "AIDE", "REPRESENTATIVE"] as const) {
      await assert.rejects(startElection(admin, { kind: "OFFICE", position }, T0), /選挙で選べません/, position);
    }
  });
});

describe("役職選挙のコマンド", () => {
  const adminPerson: FakePerson = { name: "admin", admin: true };
  beforeEach(() => setupGuild({ seats: 3 }));

  it("/election manage start で役職を選んで告示し、状況に選ぶ役職が表示される", async () => {
    const started = await run(adminPerson, "election", "manage start", { kind: "CHIEF_JUSTICE" });
    assert.equal(started.error, false, started.text);
    assert.match(started.text, /第1回 最高裁判所長官選挙｜告示/);
    assert.match(started.text, /\{`最高裁判所長官`\}（1名）/);

    const status = await run({ name: "citizen" }, "election", "status");
    assert.match(status.text, /選ぶ役職\n\{`最高裁判所長官`\}（1名）/);
  });

  it("国務大臣は担当分野、議員の選挙は総選挙・補欠選挙で告示する", async () => {
    const missing = await run(adminPerson, "election", "manage start", { kind: "MINISTER" });
    assert.equal(missing.error, true);
    assert.match(missing.text, /担当分野/);
    const ministry = await run(adminPerson, "election", "manage start", { kind: "MINISTER", portfolio: "デジタル" });
    assert.match(ministry.text, /第1回 デジタル大臣選挙｜告示/);
    await run(adminPerson, "election", "manage cancel", { reason: "テスト" });
    const general = await run(adminPerson, "election", "manage start", { kind: "GENERAL" });
    assert.match(general.text, /第2回 総選挙｜告示/);
    assert.match(general.text, /\{`国民代表（議員）`\}（定数3名）/);
  });
});
