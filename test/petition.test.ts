import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { prisma } from "../src/lib/prisma";
import { createPetition, listPetitions, signPetition } from "../src/services/petition";
import { runDueTasks } from "../src/services/scheduler";
import { GUILD, actor, daysLater, discordIdOf, register, setupGuild } from "./helpers";

const T0 = new Date("2026-09-01T00:00:00Z");

describe("請願", () => {
  beforeEach(async () => {
    await setupGuild({ petitionThreshold: 3, petitionDays: 7 });
    for (const name of ["creator", "s1", "s2", "s3"]) await register(name, T0);
  });

  it("必要署名数に達すると請願由来の法案として国会へ送付される", async () => {
    const { petition, submitted } = await createPetition(actor("creator"), "深夜のボイスチャット開放", "内容", T0);
    assert.equal(submitted, false);
    await assert.rejects(signPetition(GUILD, discordIdOf("creator"), petition.number, T0), /署名済み/);
    await assert.rejects(signPetition(GUILD, discordIdOf("nobody"), petition.number, T0), /市民登録/);
    const first = await signPetition(GUILD, discordIdOf("s1"), petition.number, T0);
    assert.equal(first.signatures, 2);
    const second = await signPetition(GUILD, discordIdOf("s2"), petition.number, T0);
    assert.equal(second.submitted, true);

    const bill = await prisma.bill.findFirstOrThrow({ where: { petitionId: petition.id } });
    assert.equal(bill.origin, "PETITION");
    assert.equal(bill.status, "DELIBERATION");
    await assert.rejects(signPetition(GUILD, discordIdOf("s3"), petition.number, T0), /受け付けていません/);

    const list = await listPetitions(GUILD, discordIdOf("s1"));
    assert.equal(list.petitions[0].signedByViewer, true);
    assert.equal(list.petitions[0].signatureCount, 3);
  });

  it("期限までに集まらなければ期限切れ、同時に受付中にできるのは3件まで", async () => {
    const { petition } = await createPetition(actor("creator"), "A", "...", T0);
    await createPetition(actor("creator"), "B", "...", T0);
    await createPetition(actor("creator"), "C", "...", T0);
    await assert.rejects(createPetition(actor("creator"), "D", "...", T0), /3件まで/);
    await runDueTasks(daysLater(T0, 8));
    const expired = await prisma.petition.findUniqueOrThrow({ where: { id: petition.id } });
    assert.equal(expired.status, "EXPIRED");
  });
});
