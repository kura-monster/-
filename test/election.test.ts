import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { prisma } from "../src/lib/prisma";
import { adminAppoint } from "../src/services/admin";
import { cabinetAppoint } from "../src/services/cabinet";
import { removeCitizenship } from "../src/services/citizen";
import {
  castBallot,
  closeRegistration,
  electionViewForVoter,
  finalizeElection,
  standForElection,
  startElection,
  withdrawCandidacy,
} from "../src/services/election";
import { submitBill, voteForOffice } from "../src/services/parliament";
import {
  GUILD,
  activeKeys,
  actor,
  daysLater,
  discordIdOf,
  flush,
  recordEvents,
  register,
  seatRepresentatives,
  setupGuild,
} from "./helpers";

const T0 = new Date("2026-07-01T00:00:00Z");

async function candidateId(electionId: string, name: string): Promise<string> {
  const c = await prisma.candidate.findFirstOrThrow({ where: { electionId, citizen: { discordId: discordIdOf(name) } } });
  return c.id;
}

describe("選挙の告示と立候補", () => {
  beforeEach(() => setupGuild({ seats: 2 }));

  it("告示できるのは選挙管理委員会か管理者だけ", async () => {
    await register("citizen1", T0);
    await assert.rejects(startElection(actor("citizen1"), { kind: "GENERAL" }, T0), /選挙管理委員長/);
    await adminAppoint(actor("admin", true), "ELECTION_COMMISSIONER", { discordId: discordIdOf("ec"), displayName: "ec", avatarUrl: null, isDiscordAdmin: false });
    const election = await startElection(actor("ec"), { kind: "GENERAL" }, T0);
    assert.equal(election.seats, 2);
    assert.equal(election.title, "第1回 総選挙");
    await assert.rejects(startElection(actor("admin", true), { kind: "GENERAL" }, T0), /進行中の選挙/);
  });

  it("立候補資格: 管理者・選挙管理委員は立候補できない", async () => {
    await register("alice", T0);
    await startElection(actor("admin", true), { kind: "GENERAL" }, T0);
    await assert.rejects(standForElection(actor("alice", true), undefined, T0), /管理者派閥/);
    await adminAppoint(actor("admin", true), "ELECTION_COMMISSION_MEMBER", { discordId: discordIdOf("ecm"), displayName: "ecm", avatarUrl: null, isDiscordAdmin: false });
    await assert.rejects(standForElection(actor("ecm"), undefined, T0), /選挙管理委員会は中立/);
    await standForElection(actor("alice"), "チャンネルを増やします", T0);
    await assert.rejects(standForElection(actor("alice"), undefined, T0), /すでに立候補/);
    await withdrawCandidacy(actor("alice"), T0);
    await standForElection(actor("alice"), "再挑戦", T0);
  });

  it("立候補者なしは不成立、定数以下は無投票当選", async () => {
    const empty = await startElection(actor("admin", true), { kind: "GENERAL" }, T0);
    assert.equal((await closeRegistration(GUILD, empty.id, T0))?.status, "CANCELLED");

    await register("alice", T0);
    const election = await startElection(actor("admin", true), { kind: "GENERAL" }, T0);
    await standForElection(actor("alice"), undefined, T0);
    const closed = await closeRegistration(GUILD, election.id, T0);
    assert.equal(closed?.status, "COMPLETED");
    const seat = await prisma.position.findFirstOrThrow({ where: { key: "REPRESENTATIVE", endedAt: null } });
    assert.equal(seat.expiresAt?.getTime(), daysLater(T0, 30).getTime());
  });
});

describe("投票と開票", () => {
  let electionId: string;

  beforeEach(async () => {
    await setupGuild({ seats: 2 });
    for (const name of ["alice", "bob", "carol", "v1", "v2", "v3"]) await register(name, T0);
    const election = await startElection(actor("admin", true), { kind: "GENERAL" }, T0);
    electionId = election.id;
    for (const name of ["alice", "bob", "carol"]) await standForElection(actor(name), undefined, T0);
  });

  it("定数を超える立候補で投票が始まり、選挙人名簿と二重投票を守る", async () => {
    const rec = recordEvents();
    const registrationEnd = daysLater(T0, 2);
    const opened = await closeRegistration(GUILD, electionId, registrationEnd);
    await flush();
    rec.stop();
    assert.equal(opened?.status, "VOTING");
    assert.ok(rec.events.some((e) => e.type === "electionVotingOpened"));

    const during = daysLater(T0, 3);
    await register("late", during);
    await assert.rejects(castBallot(GUILD, discordIdOf("late"), electionId, await candidateId(electionId, "alice"), during), /選挙人名簿/);
    await castBallot(GUILD, discordIdOf("v1"), electionId, await candidateId(electionId, "alice"), during);
    await assert.rejects(castBallot(GUILD, discordIdOf("v1"), electionId, await candidateId(electionId, "bob"), during), /すでに投票済み/);
    await assert.rejects(castBallot(GUILD, discordIdOf("v2"), electionId, "no-such-candidate", during), /候補者が見つかりません/);
    await assert.rejects(castBallot("other-guild", discordIdOf("v2"), electionId, await candidateId(electionId, "alice"), during), /市民登録/);

    const view = await electionViewForVoter(GUILD, discordIdOf("v1"), during);
    assert.equal(view.viewer?.voted, true);
    assert.equal(view.viewer?.canVote, false);
    assert.ok(view.current?.candidates.every((c) => c.voteCount === null), "開票前に得票数を公開しない");
  });

  it("秘密投票: 投票記録と票は結びつかない", async () => {
    await closeRegistration(GUILD, electionId, daysLater(T0, 2));
    await castBallot(GUILD, discordIdOf("v1"), electionId, await candidateId(electionId, "bob"), daysLater(T0, 3));
    const ballotColumns = Object.keys(await prisma.ballot.findFirstOrThrow({ where: { electionId } }));
    assert.deepEqual(ballotColumns.sort(), ["candidateId", "electionId", "id"]);
    assert.equal(await prisma.voterRecord.count({ where: { electionId } }), 1);
  });

  it("得票順に当選し、総選挙で旧議会・内閣が総辞職し議案は廃案になる", async () => {
    await setupGuild({ seats: 2 });
    await seatRepresentatives(["old1", "old2"], T0);
    await voteForOffice(actor("old1"), "PRIME_MINISTER", discordIdOf("old1"), T0);
    await voteForOffice(actor("old2"), "PRIME_MINISTER", discordIdOf("old1"), T0);
    await register("minister", T0);
    await cabinetAppoint(actor("old1"), "MINISTER", { discordId: discordIdOf("minister"), isDiscordAdmin: false }, "外務", T0);
    await submitBill(actor("old2"), { title: "旧法案", content: "内容" }, T0);

    for (const name of ["alice", "bob", "carol", "v1", "v2", "v3"]) await register(name, T0);
    const election = await startElection(actor("admin", true), { kind: "GENERAL" }, T0);
    for (const name of ["alice", "bob", "carol"]) await standForElection(actor(name), undefined, T0);
    await closeRegistration(GUILD, election.id, daysLater(T0, 2));
    const t = daysLater(T0, 3);
    await castBallot(GUILD, discordIdOf("v1"), election.id, await candidateId(election.id, "alice"), t);
    await castBallot(GUILD, discordIdOf("v2"), election.id, await candidateId(election.id, "alice"), t);
    await castBallot(GUILD, discordIdOf("v3"), election.id, await candidateId(election.id, "carol"), t);
    await castBallot(GUILD, discordIdOf("old1"), election.id, await candidateId(election.id, "bob"), t);
    await castBallot(GUILD, discordIdOf("old2"), election.id, await candidateId(election.id, "carol"), t);

    const result = await finalizeElection(GUILD, election.id, daysLater(T0, 5));
    assert.equal(result?.decision.lotteryUsed, false);
    assert.deepEqual(await activeKeys("alice"), ["REPRESENTATIVE"]);
    assert.deepEqual(await activeKeys("carol"), ["REPRESENTATIVE"]);
    assert.deepEqual(await activeKeys("bob"), []);
    assert.deepEqual(await activeKeys("old1"), [], "旧首相は総辞職");
    assert.deepEqual(await activeKeys("minister"), [], "閣僚も総辞職");
    const bill = await prisma.bill.findFirstOrThrow({ where: { title: "旧法案" } });
    assert.equal(bill.status, "LAPSED");
    const alice = await prisma.candidate.findFirstOrThrow({ where: { electionId: election.id, citizen: { discordId: discordIdOf("alice") } } });
    assert.equal(alice.voteCount, 2);
  });

  it("選挙期間中に市民でなくなった候補者は失格", async () => {
    await closeRegistration(GUILD, electionId, daysLater(T0, 2));
    const t = daysLater(T0, 3);
    await castBallot(GUILD, discordIdOf("v1"), electionId, await candidateId(electionId, "alice"), t);
    await castBallot(GUILD, discordIdOf("v2"), electionId, await candidateId(electionId, "bob"), t);
    await castBallot(GUILD, discordIdOf("v3"), electionId, await candidateId(electionId, "carol"), t);
    await removeCitizenship(GUILD, { discordId: discordIdOf("alice"), displayName: "alice", avatarUrl: null }, "LEFT_SERVER");
    await finalizeElection(GUILD, electionId, daysLater(T0, 5));
    assert.deepEqual(await activeKeys("alice"), []);
    assert.deepEqual(await activeKeys("bob"), ["REPRESENTATIVE"]);
    assert.deepEqual(await activeKeys("carol"), ["REPRESENTATIVE"]);
  });
});

describe("補欠選挙", () => {
  beforeEach(() => setupGuild({ seats: 3 }));

  it("欠員数が定数となり、当選者の任期は残任期間", async () => {
    await seatRepresentatives(["a", "b"], T0);
    await prisma.guild.update({ where: { id: GUILD }, data: { seats: 3 } });
    const existing = await prisma.position.findFirstOrThrow({ where: { key: "REPRESENTATIVE", endedAt: null } });

    await register("newcomer", T0);
    const later = daysLater(T0, 10);
    const by = await startElection(actor("admin", true), { kind: "BY" }, later);
    assert.equal(by.seats, 1);
    await assert.rejects(standForElection(actor("a"), undefined, later), /現職の議員は補欠選挙/);
    await standForElection(actor("newcomer"), undefined, later);
    await closeRegistration(GUILD, by.id, daysLater(later, 2));
    const seat = await prisma.position.findFirstOrThrow({ where: { key: "REPRESENTATIVE", endedAt: null, citizen: { discordId: discordIdOf("newcomer") } } });
    assert.equal(seat.expiresAt?.getTime(), existing.expiresAt?.getTime());
    await assert.rejects(startElection(actor("admin", true), { kind: "BY" }, later), /欠員がない/);
  });
});
