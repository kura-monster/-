import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { prisma } from "../src/lib/prisma";
import { castBallot, standForElection, startElection } from "../src/services/election";
import { runDueTasks } from "../src/services/scheduler";
import { GUILD, activeKeys, actor, daysLater, discordIdOf, register, seatRepresentatives, setupGuild } from "./helpers";

const T0 = new Date("2026-09-10T00:00:00Z");

describe("スケジューラ", () => {
  beforeEach(() => setupGuild({ seats: 1, termDays: 30, registrationDays: 2, votingDays: 3 }));

  it("選挙は期限ごとに自動で進み、確定する", async () => {
    for (const name of ["a", "b", "v"]) await register(name, T0);
    const election = await startElection(actor("admin", true), { kind: "GENERAL" }, T0);
    await standForElection(actor("a"), undefined, T0);
    await standForElection(actor("b"), undefined, T0);
    await runDueTasks(daysLater(T0, 1));
    assert.equal((await prisma.election.findUniqueOrThrow({ where: { id: election.id } })).status, "REGISTRATION");
    await runDueTasks(daysLater(T0, 2));
    assert.equal((await prisma.election.findUniqueOrThrow({ where: { id: election.id } })).status, "VOTING");
    const b = await prisma.candidate.findFirstOrThrow({ where: { electionId: election.id, citizen: { discordId: discordIdOf("b") } } });
    await castBallot(GUILD, discordIdOf("v"), election.id, b.id, daysLater(T0, 3));
    await runDueTasks(daysLater(T0, 5));
    assert.equal((await prisma.election.findUniqueOrThrow({ where: { id: election.id } })).status, "COMPLETED");
    assert.deepEqual(await activeKeys("b"), ["REPRESENTATIVE"]);
  });

  it("任期満了の前に総選挙を一度だけ自動告示し、満了で失職させる", async () => {
    await seatRepresentatives(["rep"], T0);
    await runDueTasks(daysLater(T0, 20));
    assert.equal(await prisma.election.count({ where: { guildId: GUILD, status: "REGISTRATION" } }), 0);

    await runDueTasks(daysLater(T0, 26));
    const auto = await prisma.election.findFirstOrThrow({ where: { guildId: GUILD, status: "REGISTRATION" } });
    assert.match(auto.description ?? "", /自動告示/);

    // 立候補者ゼロで不成立になっても、同じ任期に対して告示を繰り返さない。
    await runDueTasks(daysLater(T0, 28));
    assert.equal((await prisma.election.findUniqueOrThrow({ where: { id: auto.id } })).status, "CANCELLED");
    await runDueTasks(daysLater(T0, 29));
    assert.equal(await prisma.election.count({ where: { guildId: GUILD, status: { in: ["REGISTRATION", "VOTING"] } } }), 0);

    await runDueTasks(daysLater(T0, 31));
    assert.deepEqual(await activeKeys("rep"), []);
    const notice = await prisma.gazetteEntry.findFirst({ where: { guildId: GUILD, title: "任期満了" } });
    assert.ok(notice);
  });
});
