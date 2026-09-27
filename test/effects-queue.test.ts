import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { attachDiscordEffects, setEffectTimeoutsForTests } from "../src/bot/effects";
import { REQUIRED_BOT_PERMISSIONS } from "../src/bot/permissions";
import { run, type FakePerson } from "./discord-harness";
import { fakeDiscord, userIdCreatedAt } from "./fake-guild";
import { resetDb } from "./helpers";

const admin: FakePerson = { name: "admin", admin: true };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Discord への反映の順番待ち", () => {
  const GUILD_ID = "900000000000000501";
  const members = Array.from({ length: 15 }, (_, i) => ({ id: userIdCreatedAt(new Date("2020-01-01"), i + 1), name: `member${i + 1}` }));
  let discord: ReturnType<typeof fakeDiscord>;
  let detach: () => void;
  const rest = () => discord.client.rest as unknown as Record<string, (route: string, options?: { body?: unknown }) => Promise<unknown>>;
  const gazettePosted = (title: string) =>
    discord.calls.some((c) => c.method === "POST" && c.route.endsWith("/messages") && JSON.stringify(c.body ?? {}).includes(title));

  before(async () => {
    await resetDb();
    discord = fakeDiscord(GUILD_ID, REQUIRED_BOT_PERMISSIONS, { members });
    detach = attachDiscordEffects(discord.client);
    await run(admin, "admin", "autosetup", {}, { guild: discord.guild });
    await wait(200);
  });
  after(() => {
    setEffectTimeoutsForTests();
    detach();
    discord.client.destroy();
  });

  it("大勢のロール付与が進んでいても、官報の投稿は待たされない", async () => {
    // Discord answers member updates slowly under its rate limit: 300ms each, 15 members = 4.5s.
    const patch = rest().patch;
    rest().patch = async (route, options) => {
      await wait(300);
      return patch(route, options);
    };
    try {
      await run(admin, "admin", "citizen register", { role: discord.guild.roles.everyone }, { guild: discord.guild });
      discord.calls.length = 0;
      await run(admin, "election", "manage start", { kind: "GENERAL" }, { guild: discord.guild });
      await wait(1000);
      assert.ok(gazettePosted("第1回 総選挙 告示"), "the election notice is posted within a second");
      assert.ok(discord.calls.filter((c) => c.method === "PATCH").length < members.length, "while role updates are still under way");
    } finally {
      rest().patch = patch;
      await run(admin, "election", "manage cancel", { reason: "テスト" }, { guild: discord.guild });
      await wait(5000);
    }
  });

  it("投稿が止まったままになっても、後の投稿は一定時間で先に進む", async () => {
    setEffectTimeoutsForTests({ post: 300, member: 300 });
    const post = rest().post;
    rest().post = async (route, options) => {
      if (route.endsWith("/messages") && JSON.stringify(options?.body ?? {}).includes("第2回 総選挙 告示")) return new Promise(() => undefined);
      return post(route, options);
    };
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => void warnings.push(message);
    try {
      discord.calls.length = 0;
      await run(admin, "election", "manage start", { kind: "GENERAL" }, { guild: discord.guild });
      await run(admin, "election", "manage cancel", { reason: "止まった投稿の後" }, { guild: discord.guild });
      await wait(800);
      assert.ok(gazettePosted("第2回 総選挙 中止"), "the post after the hung one still goes out");
      assert.ok(warnings.some((w) => /300 秒|0.3 秒/.test(w) && w.includes("次の投稿に進みます")), warnings.join("\n"));
    } finally {
      rest().post = post;
      console.warn = warn;
    }
  });
});
