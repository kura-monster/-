import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client, ClientUser, GatewayIntentBits, OverwriteType, PermissionFlagsBits, PermissionsBitField, type Guild } from "discord.js";
import { prisma } from "../src/lib/prisma";
import { POSITIONS } from "../src/core/positions";
import { REQUIRED_BOT_PERMISSIONS } from "../src/bot/permissions";
import { CATEGORY_NAME, DEBATER_KEYS, planChannels } from "../src/bot/setup";
import { run, type FakePerson } from "./discord-harness";
import { resetDb } from "./helpers";

const P = PermissionFlagsBits;
const bits = (...flags: bigint[]) => PermissionsBitField.resolve(flags).toString();
const BOT = "1553617566004412517";
const OWNER = "900000000000000010";
const admin: FakePerson = { name: "admin", admin: true };

interface Call {
  method: string;
  route: string;
  body?: Record<string, unknown>;
}

/**
 * A real discord.js Guild whose REST calls are answered here instead of by Discord, so the test sees exactly what
 * the auto setup would send (channel types, parents, permission overwrites as bitfields, messages).
 */
function fakeDiscord(guildId: string, botPermissions: bigint[]) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  const User = ClientUser as unknown as new (client: Client, data: object) => ClientUser;
  client.user = new User(client, { id: BOT, username: "民主主義BOT", discriminator: "2514", bot: true, avatar: null });
  const now = new Date().toISOString();
  const users: Record<string, object> = {
    [BOT]: { id: BOT, username: "民主主義BOT", discriminator: "2514", bot: true, avatar: null },
    [OWNER]: { id: OWNER, username: "owner", discriminator: "0", global_name: "オーナー", avatar: null },
  };
  const member = (id: string, roles: string[]) => ({ user: users[id], roles, joined_at: now, deaf: false, mute: false, flags: 0 });
  const roles: Record<string, unknown>[] = [
    { id: guildId, name: "@everyone", permissions: bits(P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.SendMessagesInThreads), position: 0, color: 0, hoist: false, managed: false, mentionable: false, flags: 0 },
    { id: "900000000000000002", name: "民主主義BOT", permissions: bits(...botPermissions), position: 50, color: 0, hoist: false, managed: true, mentionable: false, flags: 0, tags: { bot_id: BOT } },
  ];
  const guild = (client.guilds as unknown as { _add(data: object): Guild })._add({
    id: guildId,
    name: "オート国",
    owner_id: OWNER,
    unavailable: false,
    member_count: 2,
    roles,
    channels: [{ id: "900000000000000020", type: 0, name: "雑談", guild_id: guildId, position: 0, permission_overwrites: [] }],
    members: [member(BOT, ["900000000000000002"]), member(OWNER, [])],
    emojis: [],
    stickers: [],
    features: [],
  });

  // Asking for every member goes over the gateway, which this client never opened.
  const fetchMembers = guild.members.fetch.bind(guild.members);
  guild.members.fetch = ((options?: unknown) => (options === undefined ? Promise.resolve(guild.members.cache) : fetchMembers(options as never))) as never;

  let next = 900000000000001000n;
  const calls: Call[] = [];
  const answer = (method: string, route: string, body?: Record<string, unknown>): unknown => {
    calls.push({ method, route, body });
    const id = String(next++);
    if (method === "GET" && route === `/guilds/${guildId}/roles`) return roles;
    if (method === "POST" && route === `/guilds/${guildId}/roles`) {
      const role = { id, name: body?.name, permissions: String(body?.permissions ?? "0"), position: roles.length, color: 0, hoist: Boolean(body?.hoist), managed: false, mentionable: false, flags: 0 };
      roles.push(role);
      return role;
    }
    if (method === "POST" && route === `/guilds/${guildId}/channels`) {
      return { id, guild_id: guildId, type: body?.type, name: body?.name, topic: body?.topic ?? null, parent_id: body?.parent_id ?? null, position: 1, permission_overwrites: body?.permission_overwrites ?? [] };
    }
    const memberRoute = route.match(new RegExp(`^/guilds/${guildId}/members/(\\d+)$`));
    if (method === "PATCH" && memberRoute) return member(memberRoute[1], (body?.roles as string[]) ?? []);
    const messageRoute = route.match(/^\/channels\/(\d+)\/messages$/);
    if (method === "POST" && messageRoute) {
      return { id, channel_id: messageRoute[1], author: users[BOT], content: "", embeds: body?.embeds ?? [], components: [], attachments: [], mentions: [], mention_roles: [], pinned: false, tts: false, type: 0, timestamp: now };
    }
    throw new Error(`unexpected Discord call: ${method} ${route}`);
  };
  // Serialized both ways like the real REST client does (bitfields become strings through toJSON).
  const json = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  for (const method of ["get", "post", "put", "patch", "delete"] as const) {
    (client.rest as unknown as Record<string, unknown>)[method] = async (route: string, options: { body?: Record<string, unknown> } = {}) =>
      json(answer(method.toUpperCase(), route, json(options.body)));
  }
  return { client, guild, calls };
}

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
    const reply = await run(admin, "admin", "autosetup", { first_election: true }, { guild: discord.guild });
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
