import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { prisma } from "../src/lib/prisma";
import { registerRoleMembers } from "../src/services/admin";
import { removeCitizenship, type RegistrationInput } from "../src/services/citizen";
import { REQUIRED_BOT_PERMISSIONS } from "../src/bot/permissions";
import { run, type FakePerson } from "./discord-harness";
import { fakeDiscord, userIdCreatedAt } from "./fake-guild";
import { GUILD, LONG_AGO, actor, discordIdOf, recordEvents, register, resetDb, setupGuild } from "./helpers";

const NOW = new Date("2026-09-01T00:00:00Z");
const member = (name: string, accountCreatedAt = LONG_AGO): RegistrationInput => ({
  discordId: discordIdOf(name),
  displayName: name,
  avatarUrl: null,
  accountCreatedAt,
  joinedAt: LONG_AGO,
});

describe("市民の一括登録（サービス）", () => {
  beforeEach(() => setupGuild());

  it("ロールの保持者をまとめて登録し、登録済み・条件を満たさない人・市民権停止中の人は登録しない", async () => {
    await register("alice", NOW);
    await register("dave", NOW);
    await removeCitizenship(GUILD, member("dave"), "SELF", {}, NOW);
    await removeCitizenship(GUILD, member("mallory"), "REVOKED", { reason: "荒らし", actorName: "admin" }, NOW);
    const recorded = recordEvents();

    const result = await registerRoleMembers(
      actor("admin", true),
      "メンバー",
      [member("alice"), member("bob"), member("carol", new Date("2026-08-30T00:00:00Z")), member("mallory"), member("dave")],
      {},
      NOW,
    );
    recorded.stop();

    assert.deepEqual(result.registered.map((c) => c.displayName), ["bob", "dave"]);
    assert.equal(result.alreadyRegistered, 1);
    assert.deepEqual(result.skipped, [
      { displayName: "carol", reason: "アカウント作成から7日未満", waivable: true },
      { displayName: "mallory", reason: "市民権停止中", waivable: false },
    ]);
    const roleSyncs = recorded.events.flatMap((e) => (e.type === "rolesChanged" ? e.discordIds : []));
    assert.deepEqual(roleSyncs.sort(), [discordIdOf("bob"), discordIdOf("dave")]);

    const gazette = await prisma.gazetteEntry.findMany({ where: { guildId: GUILD, title: { startsWith: "市民の一括登録" } } });
    assert.equal(gazette.length, 1, "one gazette entry for the whole batch");
    assert.equal(gazette[0].title, "市民の一括登録（2名）");
    assert.match(gazette[0].body, /ロール「メンバー」を持つメンバーを市民登録しました。\n市民番号 \d+　bob\n市民番号 \d+　dave/);
  });

  it("条件の無視を指定すると新しいアカウントも登録できるが、市民権停止は解除しない", async () => {
    await removeCitizenship(GUILD, member("mallory"), "REVOKED", { reason: "荒らし", actorName: "admin" }, NOW);
    const result = await registerRoleMembers(
      actor("admin", true),
      "新人",
      [member("carol", new Date("2026-08-31T00:00:00Z")), member("mallory")],
      { waiveRequirements: true },
      NOW,
    );
    assert.deepEqual(result.registered.map((c) => c.displayName), ["carol"]);
    assert.deepEqual(result.skipped.map((s) => s.displayName), ["mallory"]);
    const entry = await prisma.gazetteEntry.findFirstOrThrow({ where: { guildId: GUILD, title: { startsWith: "市民の一括登録" } } });
    assert.match(entry.body, /アカウント年齢・在籍期間の条件を適用せず/);
  });

  it("管理者以外は実行できず、誰も登録されなければ官報に載せない", async () => {
    await assert.rejects(registerRoleMembers(actor("alice"), "メンバー", [member("bob")], {}, NOW), /管理者専用/);
    await register("bob", NOW);
    const result = await registerRoleMembers(actor("admin", true), "メンバー", [member("bob")], {}, NOW);
    assert.equal(result.alreadyRegistered, 1);
    assert.equal(await prisma.gazetteEntry.count({ where: { guildId: GUILD, title: { startsWith: "市民の一括登録" } } }), 0);
  });
});

describe("市民の一括登録（/admin citizen register）", () => {
  const GUILD_ID = "900000000000000301";
  const ROLE = { id: "900000000000000400", name: "メンバー" };
  const OLD = new Date("2020-01-01T00:00:00Z");
  const people = {
    alice: userIdCreatedAt(OLD, 1),
    bob: userIdCreatedAt(new Date(Date.now() - 86_400_000), 2),
    carol: userIdCreatedAt(OLD, 3),
    helper: userIdCreatedAt(OLD, 4),
  };
  const admin: FakePerson = { name: "admin", admin: true };
  let discord: ReturnType<typeof fakeDiscord>;
  const citizens = async () =>
    (await prisma.citizen.findMany({ where: { guildId: GUILD_ID, active: true }, orderBy: { number: "asc" } })).map((c) => c.displayName);

  before(async () => {
    await resetDb();
    discord = fakeDiscord(GUILD_ID, REQUIRED_BOT_PERMISSIONS, {
      roles: [ROLE],
      members: [
        { id: people.alice, name: "alice", roles: [ROLE.id] },
        { id: people.bob, name: "bob", roles: [ROLE.id] },
        { id: people.carol, name: "carol" },
        { id: people.helper, name: "helper-bot", roles: [ROLE.id], bot: true },
      ],
    });
  });
  after(() => discord.client.destroy());

  it("ロールを持つ人だけを登録し、Bot は除き、新しいアカウントは理由とともに知らせる", async () => {
    const reply = await run(admin, "admin", "citizen register", { role: discord.guild.roles.cache.get(ROLE.id)! }, { guild: discord.guild });
    assert.equal(reply.error, false, reply.text);
    assert.match(reply.text, /<@&900000000000000400> を持つメンバー 2名（Bot を除く）/);
    assert.match(reply.text, /登録した市民（1名）\n<@\d+>　市民番号 1/);
    assert.match(reply.text, /登録できなかった人（1名）\nbob: アカウント作成から7日未満/);
    assert.match(reply.text, /ignore_requirements:True/);
    assert.deepEqual(await citizens(), ["alice"]);
  });

  it("条件を無視すれば残りも登録でき、登録済みの人は数えるだけ", async () => {
    const reply = await run(admin, "admin", "citizen register", { role: discord.guild.roles.cache.get(ROLE.id)!, ignore_requirements: true }, { guild: discord.guild });
    assert.match(reply.text, /登録した市民（1名）/);
    assert.match(reply.text, /登録済み\n1名/);
    assert.deepEqual(await citizens(), ["alice", "bob"]);
  });

  it("@everyone を指定すると、全メンバー（Bot を除く）が対象になる", async () => {
    const reply = await run(admin, "admin", "citizen register", { role: discord.guild.roles.everyone }, { guild: discord.guild });
    assert.match(reply.text, /を持つメンバー 4名（Bot を除く）/);
    assert.deepEqual(await citizens(), ["alice", "bob", "オーナー", "carol"]);
  });

  it("管理者以外は実行できない", async () => {
    const reply = await run({ name: "alice" }, "admin", "citizen register", { role: discord.guild.roles.everyone }, { guild: discord.guild });
    assert.equal(reply.error, true);
  });
});
