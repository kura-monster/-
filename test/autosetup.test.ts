import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { OverwriteType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { prisma } from "../src/lib/prisma";
import { POSITIONS } from "../src/core/positions";
import { REQUIRED_BOT_PERMISSIONS } from "../src/bot/permissions";
import { CATEGORY_NAME, DEBATER_KEYS, planChannels } from "../src/bot/setup";
import { run, type FakePerson } from "./discord-harness";
import { BOT, fakeDiscord, type Call } from "./fake-guild";
import { resetDb } from "./helpers";

const P = PermissionFlagsBits;
const bits = (...flags: bigint[]) => PermissionsBitField.resolve(flags).toString();
const admin: FakePerson = { name: "admin", admin: true };


const channelPosts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.route.endsWith("/channels"));
const messagePosts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.route.endsWith("/messages"));

describe("オートセットアップ（/admin autosetup）", () => {
  const GUILD_ID = "900000000000000001";
  let discord: ReturnType<typeof fakeDiscord>;

  before(async () => {
    await resetDb();
    discord = fakeDiscord(GUILD_ID, REQUIRED_BOT_PERMISSIONS);
  });
  after(() => discord.client.destroy());

  it("チャンネルの権限: 投稿は Bot と関係する役職だけ、閲覧はサーバーの設定に任せる", () => {
    const plans = planChannels({ everyone: "e", bot: "b", citizen: "c", debaters: ["r1", "r2"] });
    assert.deepEqual(plans.map((p) => p.name), ["官報", "議事堂", "裁判所", "選挙"]);
    for (const plan of plans) {
      const everyone = plan.overwrites.find((o) => o.id === "e") as unknown as { allow?: unknown; deny: bigint[] };
      assert.deepEqual(everyone.deny, [P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads]);
      assert.equal(everyone.allow, undefined, "reading is not opened up to @everyone");
      const bot = plan.overwrites.find((o) => o.id === "b") as unknown as { type: OverwriteType; allow: bigint[] };
      assert.equal(bot.type, OverwriteType.Member);
      assert.ok([P.ViewChannel, P.SendMessages, P.CreatePublicThreads].every((bit) => bot.allow.includes(bit)));
    }
    const speakers = (name: string) => plans.find((p) => p.name === name)?.overwrites.filter((o) => !["e", "b"].includes(o.id as string)).map((o) => o.id);
    assert.deepEqual(speakers("議事堂"), ["r1", "r2"]);
    assert.deepEqual(speakers("裁判所"), ["c"]);
    assert.deepEqual(speakers("官報"), []);
    assert.ok(DEBATER_KEYS.every((key) => POSITIONS[key].faction !== "NEUTRAL"));
    assert.ok(DEBATER_KEYS.includes("REPRESENTATIVE") && DEBATER_KEYS.includes("SOVEREIGN") && !DEBATER_KEYS.includes("JUDGE"));
  });

  it("1回で、カテゴリー・4チャンネル（権限つき）・役職ロール・元首・案内・総選挙まで設定する", async () => {
    const reply = await run(admin, "admin", "autosetup", { first_election: "GENERAL" }, { guild: discord.guild });
    assert.equal(reply.error, false, reply.text);
    assert.match(reply.text, /オートセットアップ/);
    assert.match(reply.text, new RegExp(`カテゴリー: ${CATEGORY_NAME.replace(/[{}]/g, "\\$&")}（作成）`));
    for (const name of ["官報", "議事堂", "裁判所", "選挙"]) assert.match(reply.text, new RegExp(`${name}: <#\\d+>（作成）`));
    assert.match(reply.text, /サーバーオーナー <@900000000000000010> を \{`元首`\} に任命しました/);
    assert.match(reply.text, /第1回 総選挙を告示しました/);
    assert.match(reply.text, /`OK` チャンネルの管理/);

    const posts = channelPosts(discord.calls);
    assert.equal(posts.length, 5);
    const [category, ...texts] = posts;
    assert.deepEqual([category.body?.type, category.body?.name], [4, CATEGORY_NAME]);
    const categoryId = (await discord.guild.channels.cache.find((c) => c.name === CATEGORY_NAME))?.id;
    for (const post of texts) {
      assert.equal(post.body?.type, 0);
      assert.equal(post.body?.parent_id, categoryId);
      const overwrites = post.body?.permission_overwrites as { id: string; type: number; allow: string; deny: string }[];
      assert.deepEqual(overwrites[0], { id: GUILD_ID, type: 0, allow: "0", deny: bits(P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads) });
      // Discord refuses overwrites for permissions the bot does not hold itself.
      for (const overwrite of overwrites) {
        const used = BigInt(overwrite.allow) | BigInt(overwrite.deny);
        assert.equal(used & ~PermissionsBitField.resolve(REQUIRED_BOT_PERMISSIONS), 0n, `${post.body?.name}: ${overwrite.id}`);
      }
      assert.equal(overwrites[1].id, BOT);
      assert.equal(overwrites[1].type, 1);
    }

    const managed = await prisma.managedRole.findMany({ where: { guildId: GUILD_ID } });
    const roleIds = (keys: string[]) => managed.filter((r) => keys.includes(r.key)).map((r) => r.roleId).sort();
    const threadSpeakers = (name: string) =>
      (texts.find((t) => t.body?.name === name)?.body?.permission_overwrites as { id: string; allow: string }[])
        .filter((o) => o.allow === bits(P.SendMessagesInThreads))
        .map((o) => o.id)
        .sort();
    assert.deepEqual(threadSpeakers("議事堂"), roleIds(DEBATER_KEYS));
    assert.deepEqual(threadSpeakers("裁判所"), roleIds(["CITIZEN"]));

    const settings = await prisma.guild.findUniqueOrThrow({ where: { id: GUILD_ID } });
    const idOf = (name: string) => discord.guild.channels.cache.find((c) => c.name === name)?.id;
    assert.deepEqual(
      [settings.announceChannelId, settings.debateChannelId, settings.courtChannelId, settings.electionChannelId],
      [idOf("官報"), idOf("議事堂"), idOf("裁判所"), idOf("選挙")],
    );

    const welcome = messagePosts(discord.calls);
    assert.equal(welcome.length, 1);
    assert.equal(welcome[0].route, `/channels/${settings.announceChannelId}/messages`);
    const text = JSON.stringify(welcome[0].body);
    assert.match(text, /オート国｜はじめに/);
    assert.match(text, /citizen register/);
    assert.doesNotMatch(text, /\p{Extended_Pictographic}/u);
    assert.equal(managed.length, 15);
  });

  it("もう一度実行しても、既存のチャンネルを使い、案内も重ねて投稿しない", async () => {
    discord.calls.length = 0;
    const reply = await run(admin, "admin", "autosetup", {}, { guild: discord.guild });
    assert.equal(reply.error, false, reply.text);
    for (const name of ["官報", "議事堂", "裁判所", "選挙"]) assert.match(reply.text, new RegExp(`${name}: <#\\d+>（既存）`));
    assert.match(reply.text, /（在任中）/);
    assert.deepEqual(channelPosts(discord.calls), []);
    assert.deepEqual(messagePosts(discord.calls), []);
  });

  it("データベースを作り直しても、カテゴリー内の同名チャンネルを使い直す", async () => {
    await prisma.guild.update({ where: { id: GUILD_ID }, data: { announceChannelId: null, debateChannelId: null, courtChannelId: null, electionChannelId: null } });
    discord.calls.length = 0;
    const reply = await run(admin, "admin", "autosetup", {}, { guild: discord.guild });
    assert.match(reply.text, /官報: <#\d+>（既存）/);
    assert.deepEqual(channelPosts(discord.calls), []);
  });

  it("Bot に「チャンネルの管理」権限がなければ、何も作らずに理由を伝える", async () => {
    const withoutChannels = fakeDiscord("900000000000000003", REQUIRED_BOT_PERMISSIONS.filter((bit) => bit !== P.ManageChannels));
    try {
      const reply = await run(admin, "admin", "autosetup", {}, { guild: withoutChannels.guild });
      assert.equal(reply.error, true);
      assert.match(reply.text, /Bot に「チャンネルの管理」の権限がありません/);
      assert.deepEqual(withoutChannels.calls, []);
    } finally {
      await withoutChannels.client.destroy();
    }
  });
});
