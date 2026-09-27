import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ChannelType, EmbedBuilder, type Client } from "discord.js";
import { prisma } from "../src/lib/prisma";
import { attachDiscordEffects } from "../src/bot/effects";
import { cabinetAppoint } from "../src/services/cabinet";
import { fileCase, issueVerdict, takeCase } from "../src/services/court";
import { submitBill, voteForOffice } from "../src/services/parliament";
import { runDueTasks } from "../src/services/scheduler";
import { GUILD, actor, discordIdOf, register, seatRepresentatives, setupGuild } from "./helpers";

/** A stand-in for the few discord.js surfaces the adapter touches. */
function fakeDiscord() {
  const posts: { channel: string; title?: string; content?: string }[] = [];
  const threads: { parent: string; name: string }[] = [];
  const roleChanges: { member: string; add?: string[]; remove?: string[] }[] = [];
  const timeouts: { member: string; ms: number }[] = [];
  const memberRoles = new Map<string, Set<string>>();

  const record = (channel: string, message: { content?: string; embeds?: EmbedBuilder[] }) =>
    posts.push({ channel, content: message.content, title: message.embeds?.[0]?.toJSON().title });
  const thread = (id: string) => ({ id, type: ChannelType.PublicThread, isSendable: () => true, send: async (m: never) => record(id, m) });
  const textChannel = (id: string) => ({
    id,
    type: ChannelType.GuildText,
    isSendable: () => true,
    send: async (message: { content?: string; embeds?: EmbedBuilder[] }) => {
      record(id, message);
      return {
        startThread: async ({ name }: { name: string }) => {
          const threadId = `${id}-thread-${threads.length + 1}`;
          threads.push({ parent: id, name });
          channels.set(threadId, thread(threadId));
          return { id: threadId };
        },
      };
    },
  });
  const forumChannel = (id: string) => ({
    id,
    type: ChannelType.GuildForum,
    isSendable: () => false,
    threads: {
      create: async ({ name, message }: { name: string; message: { embeds?: EmbedBuilder[] } }) => {
        const threadId = `${id}-post-${threads.length + 1}`;
        threads.push({ parent: id, name });
        record(threadId, message);
        channels.set(threadId, thread(threadId));
        return { id: threadId };
      },
    },
  });
  const channels = new Map<string, unknown>([
    ["announce", textChannel("announce")],
    ["debate", textChannel("debate")],
    ["court", forumChannel("court")],
  ]);

  const member = (id: string) => {
    const roles = memberRoles.get(id) ?? new Set<string>();
    memberRoles.set(id, roles);
    return {
      id,
      moderatable: true,
      roles: {
        cache: { has: (roleId: string) => roles.has(roleId) },
        add: async (ids: string[]) => {
          ids.forEach((r) => roles.add(r));
          roleChanges.push({ member: id, add: ids });
        },
        remove: async (ids: string[]) => {
          ids.forEach((r) => roles.delete(r));
          roleChanges.push({ member: id, remove: ids });
        },
      },
      timeout: async (ms: number) => {
        timeouts.push({ member: id, ms });
      },
    };
  };
  const guild = {
    id: GUILD,
    roles: { cache: { has: (roleId: string) => roleId.startsWith("role-") } },
    members: { fetch: async (id: string) => member(id) },
  };
  const client = {
    guilds: { cache: new Map([[GUILD, guild]]) },
    channels: { fetch: async (id: string) => channels.get(id) ?? null },
  };
  return { client: client as unknown as Client, posts, threads, roleChanges, timeouts, memberRoles };
}

async function eventually(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

describe("Discordへの反映（アダプタ）", () => {
  let discord: ReturnType<typeof fakeDiscord>;
  let detach: () => void;

  before(async () => {
    await setupGuild();
    await prisma.guild.update({
      where: { id: GUILD },
      data: { announceChannelId: "announce", debateChannelId: "debate", courtChannelId: "court" },
    });
    await prisma.managedRole.createMany({
      data: [
        { guildId: GUILD, key: "CITIZEN", roleId: "role-citizen" },
        { guildId: GUILD, key: "REPRESENTATIVE", roleId: "role-rep" },
        { guildId: GUILD, key: "SPEAKER", roleId: "role-speaker" },
        { guildId: GUILD, key: "JUDGE", roleId: "role-judge" },
      ],
    });
    discord = fakeDiscord();
    detach = attachDiscordEffects(discord.client);
  });

  after(() => detach());

  it("市民登録・当選・議長就任でDiscordロールが付き、官報が告知チャンネルに順番どおり載る", async () => {
    await seatRepresentatives(["alice", "bob"]);
    await voteForOffice(actor("alice"), "SPEAKER", discordIdOf("alice"));
    await voteForOffice(actor("bob"), "SPEAKER", discordIdOf("alice"));
    const alice = discordIdOf("alice");
    await eventually(() => discord.memberRoles.get(alice)?.has("role-speaker") ?? false, "speaker role");
    assert.deepEqual([...(discord.memberRoles.get(alice) ?? [])].sort(), ["role-citizen", "role-rep", "role-speaker"]);

    const entries = await prisma.gazetteEntry.findMany({ where: { guildId: GUILD }, orderBy: { number: "asc" } });
    await eventually(() => discord.posts.filter((p) => p.channel === "announce").length >= entries.length, "gazette posts");
    const titles = discord.posts.filter((p) => p.channel === "announce").map((p) => p.title);
    assert.deepEqual(
      titles,
      entries.map((e) => `官報 第${e.number}号｜${e.title}`),
    );
    for (const post of discord.posts) assert.doesNotMatch(`${post.title ?? ""}${post.content ?? ""}`, /\p{Extended_Pictographic}/u);
  });

  it("法案ごとに議論スレッドを作り、スレッドIDを保存する", async () => {
    const bill = await submitBill(actor("bob"), { title: "スレッド法", content: "議論の場を作る" });
    await eventually(async () => Boolean((await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } })).threadId), "bill thread");
    assert.ok(discord.threads.some((t) => t.parent === "debate" && t.name === `第${bill.number}号 スレッド法`));
  });

  it("確定したタイムアウト判決をDiscordで執行し、結果を記録する", async () => {
    for (const name of ["plaintiff", "defendant", "judge"]) await register(name);
    await voteForOffice(actor("alice"), "PRIME_MINISTER", discordIdOf("bob"));
    await voteForOffice(actor("bob"), "PRIME_MINISTER", discordIdOf("bob"));
    await cabinetAppoint(actor("bob"), "JUDGE", { discordId: discordIdOf("judge"), isDiscordAdmin: false }, undefined);
    const filed = await fileCase(actor("plaintiff"), discordIdOf("defendant"), "荒らし事件", "スパム投稿");
    await eventually(async () => Boolean((await prisma.courtCase.findUniqueOrThrow({ where: { id: filed.id } })).threadId), "case forum post");
    assert.ok(discord.threads.some((t) => t.parent === "court"));

    await takeCase(actor("judge"), filed.number);
    const now = new Date();
    await issueVerdict(actor("judge"), filed.number, { result: "PLAINTIFF_WINS", ruling: "スパムは禁止", penalty: "TIMEOUT_1H" }, now);
    await runDueTasks(new Date(now.getTime() + 25 * 3_600_000));
    await eventually(async () => (await prisma.courtCase.findUniqueOrThrow({ where: { id: filed.id } })).penaltyStatus === "EXECUTED", "penalty executed");
    assert.deepEqual(discord.timeouts, [{ member: discordIdOf("defendant"), ms: 3_600_000 }]);
    assert.ok(discord.memberRoles.get(discordIdOf("judge"))?.has("role-judge"));
  });
});
