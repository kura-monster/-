import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { ApplicationCommandOptionType, InteractionContextType, PermissionFlagsBits, type APIApplicationCommandOption } from "discord.js";
import { prisma } from "../src/lib/prisma";
import { ADMIN_COMMANDS, COMMANDS, PUBLIC_COMMANDS } from "../src/bot/commands";
import { MANAGED_KEYS, roleSpec } from "../src/bot/roles";
import { roleTag } from "../src/core/text";
import { autocomplete, run, type FakePerson } from "./discord-harness";
import { GUILD, setupGuild } from "./helpers";

const NAME = /^[-_\p{L}\p{N}]{1,32}$/u;

function charCount(options: readonly APIApplicationCommandOption[] | undefined): number {
  let total = 0;
  for (const option of options ?? []) {
    total += option.name.length + option.description.length;
    if ("choices" in option && option.choices) for (const c of option.choices) total += c.name.length + String(c.value).length;
    if ("options" in option) total += charCount(option.options);
  }
  return total;
}

function checkOptions(path: string, options: readonly APIApplicationCommandOption[] | undefined): void {
  const list = options ?? [];
  assert.ok(list.length <= 25, `${path}: 25 options max`);
  let seenOptional = false;
  for (const option of list) {
    const where = `${path} ${option.name}`;
    assert.match(option.name, NAME, `${where}: invalid name`);
    assert.equal(option.name, option.name.toLowerCase(), `${where}: name must be lowercase`);
    assert.ok(option.description.length >= 1 && option.description.length <= 100, `${where}: description 1-100 chars`);
    if (option.type === ApplicationCommandOptionType.Subcommand || option.type === ApplicationCommandOptionType.SubcommandGroup) {
      checkOptions(where, option.options);
      continue;
    }
    const required = "required" in option && option.required === true;
    assert.ok(!(required && seenOptional), `${where}: required options must come before optional ones`);
    if (!required) seenOptional = true;
    if ("choices" in option && option.choices) {
      assert.ok(option.choices.length <= 25, `${where}: 25 choices max`);
      assert.ok(!("autocomplete" in option && option.autocomplete), `${where}: choices and autocomplete are exclusive`);
      for (const choice of option.choices) assert.ok(choice.name.length >= 1 && choice.name.length <= 100, `${where}: choice name 1-100`);
    }
  }
}

describe("コマンド定義（Discord APIの制約）", () => {
  it("すべてのコマンドがDiscordの登録制限を満たす", () => {
    const names = new Set<string>();
    for (const command of COMMANDS) {
      const json = command.data.toJSON();
      assert.ok(!names.has(json.name), `duplicate /${json.name}`);
      names.add(json.name);
      assert.match(json.name, NAME);
      assert.ok(json.description.length >= 1 && json.description.length <= 100, `/${json.name} description`);
      checkOptions(`/${json.name}`, json.options);
      const total = json.name.length + json.description.length + charCount(json.options);
      assert.ok(total <= 4000, `/${json.name} is ${total} chars (max 4000)`);
      assert.deepEqual(json.contexts, [InteractionContextType.Guild], `/${json.name} must be guild-only`);
    }
  });

  it("役職は絵文字を使わず、Discordロール名は {裁判官} 形式", () => {
    for (const key of MANAGED_KEYS) {
      const { name } = roleSpec(key);
      assert.match(name, /^\{[^{}]+\}$/, `role name ${name}`);
      assert.doesNotMatch(name, /\p{Extended_Pictographic}/u);
    }
    assert.equal(roleSpec("JUDGE").name, "{裁判官}");
    assert.equal(roleSpec("CITIZEN").name, "{市民}");
    assert.equal(roleTag("裁判官"), "{`裁判官`}");
    assert.equal(roleTag("外`務"), "{`外'務`}", "バッククォートはコード表示を壊さないよう置き換える");
    for (const command of COMMANDS) {
      assert.doesNotMatch(JSON.stringify(command.data.toJSON()), /\p{Extended_Pictographic}/u, `/${command.data.name} definition`);
    }
  });

  it("管理者専用コマンドは /admin に分離され、Discord上で管理者にしか表示されない", () => {
    assert.deepEqual(ADMIN_COMMANDS.map((c) => c.data.name), ["admin"]);
    for (const command of ADMIN_COMMANDS) {
      assert.equal(command.audience, "admin");
      assert.equal(command.data.toJSON().default_member_permissions, PermissionFlagsBits.Administrator.toString());
    }
    for (const command of PUBLIC_COMMANDS) {
      assert.equal(command.audience, "public");
      assert.equal(command.data.toJSON().default_member_permissions ?? null, null, `/${command.data.name} must be visible to everyone`);
    }
  });
});

const admin: FakePerson = { name: "admin", admin: true };
const alice: FakePerson = { name: "alice" };
const bob: FakePerson = { name: "bob" };
const carol: FakePerson = { name: "carol" };

async function ok(person: FakePerson, command: string, route: string, values: Record<string, string | number | boolean | FakePerson> = {}) {
  const reply = await run(person, command, route, values);
  assert.equal(reply.error, false, `/${command} ${route} failed: ${reply.text}`);
  return reply;
}

describe("コマンド操作の通し（ハーネス）", () => {
  before(() => setupGuild());

  it("管理者以外が /admin を実行しても拒否される", async () => {
    const reply = await run(alice, "admin", "settings");
    assert.equal(reply.error, true);
    assert.match(reply.text, /管理者専用/);
    assert.match((await ok(admin, "admin", "settings")).text, /議員定数/);
    assert.match((await ok(admin, "admin", "settings", { seats: 3, auto_election: false })).text, /議員定数: 5名 → 3名/);
  });

  it("市民登録から選挙・国会・内閣・裁判・請願まで", async () => {
    for (const person of [alice, bob, carol]) assert.match((await ok(person, "citizen", "register")).text, /市民番号/);
    assert.equal((await run(alice, "citizen", "register")).error, true);

    assert.match((await ok(admin, "election", "manage start", { kind: "GENERAL" })).text, /第1回 総選挙/);
    assert.equal((await run(alice, "election", "manage start", { kind: "BY" })).error, true);
    await ok(alice, "election", "candidacy", { manifesto: "議論の場を増やします" });
    await ok(bob, "election", "candidacy");
    assert.match((await ok(carol, "election", "status")).text, /議論の場を増やします/);
    assert.match((await ok(admin, "election", "manage advance")).text, /確定/);
    assert.match((await ok(carol, "election", "results")).text, /当選/);

    assert.match((await ok(alice, "parliament", "elect", { office: "SPEAKER", candidate: alice })).text, /議長選挙/);
    assert.match((await ok(bob, "parliament", "elect", { office: "SPEAKER", candidate: alice })).text, /議長に alice を選出/);
    await ok(alice, "parliament", "elect", { office: "PRIME_MINISTER", candidate: bob });
    await ok(bob, "parliament", "elect", { office: "PRIME_MINISTER", candidate: bob });
    assert.match((await ok(bob, "cabinet", "appoint", { position: "MINISTER", user: carol, title: "外務" })).text, /外務大臣/);
    assert.match((await ok(carol, "cabinet", "list")).text, /外務大臣/);
    assert.match((await ok(carol, "gov", "overview")).text, /\{`内閣総理大臣`\} <@id-bob>/);

    assert.match((await ok(carol, "parliament", "bill submit", { title: "雑談部屋増設法", content: "雑談チャンネルを1つ増やす" })).text, /内閣提出/);
    const choices = await autocomplete(alice, "parliament", "bill open", "bill", "");
    assert.equal(choices[0].value, 1);
    assert.match(choices[0].name, /雑談部屋増設法/);
    assert.equal((await run(bob, "parliament", "bill open", { bill: 1 })).error, true, "議長以外は採決を開始できない");
    await ok(alice, "parliament", "bill open", { bill: 1 });
    await ok(alice, "parliament", "bill vote", { bill: 1, choice: "FOR" });
    assert.match((await ok(bob, "parliament", "bill vote", { bill: 1, choice: "FOR" })).text, /可決（裁可待ち）/);
    assert.match((await ok(carol, "parliament", "bill info", { bill: 1 })).text, /賛成/);
    const sanctionable = await autocomplete(admin, "admin", "bill sanction", "bill", "");
    assert.deepEqual(sanctionable.map((c) => c.value), [1]);
    await ok(admin, "admin", "bill sanction", { bill: 1 });
    await ok(carol, "cabinet", "implement", { bill: 1, note: "#雑談2 を作成" });
    assert.match((await ok(carol, "parliament", "bill list", { filter: "enacted" })).text, /施行済/);

    await ok(carol, "petition", "create", { title: "夜間VCの開放", content: "深夜もVCを使いたい" });
    assert.match((await ok(alice, "petition", "sign", { petition: 1 })).text, /2／5筆/);
    assert.match((await ok(bob, "petition", "info", { petition: 1 })).text, /署名者/);
    await ok(bob, "petition", "list");

    await ok(carol, "court", "file", { defendant: alice, title: "議事妨害", claim: "採決を妨害した" });
    await ok(alice, "court", "respond", { case: 1, statement: "妨害していません" });
    await ok(admin, "admin", "appoint", { position: "CHIEF_JUSTICE", user: { name: "judge" } });
    await ok({ name: "judge" }, "court", "take", { case: 1 });
    await ok({ name: "judge" }, "court", "verdict", { case: 1, result: "DEFENDANT_WINS", ruling: "証拠不十分" });
    assert.match((await ok(carol, "court", "info", { case: 1 })).text, /請求棄却/);
    await ok(carol, "court", "list", { filter: "all" });

    assert.equal((await run(bob, "parliament", "aide appoint", { user: { name: "secretary" } })).error, true, "未登録の人は補佐官にできない");
    await ok({ name: "secretary" }, "citizen", "register");
    assert.match((await ok(bob, "parliament", "aide appoint", { user: { name: "secretary" } })).text, /補佐官（bob議員付）/);
    assert.match((await ok(carol, "parliament", "members")).text, /\{`補佐官`\} secretary/);
    assert.match((await ok(carol, "citizen", "profile")).text, /外務大臣/);
    const own = await autocomplete(carol, "citizen", "resign", "position", "");
    assert.match(own[0].name, /外務大臣/);
    await ok(carol, "citizen", "resign", { position: String(own[0].value) });
  });

  it("情報系コマンドと /help の出し分け", async () => {
    assert.match((await ok(carol, "gov", "positions")).text, /最高裁判所長官/);
    assert.match((await ok(carol, "gov", "rules")).text, /定足数/);
    assert.match((await ok(carol, "gov", "gazette")).text, /官報/);
    const citizenHelp = await ok(carol, "help", "");
    assert.equal(citizenHelp.ephemeral, true);
    assert.doesNotMatch(citizenHelp.text, /管理者専用/);
    assert.match((await ok(alice, "help", "")).text, /\{`議長`\}・\{`副議長`\}　`使用可`/);
    assert.match((await ok(admin, "help", "")).text, /管理者専用/);
  });

  it("管理者の権能: 拒否権・解散・市民権停止", async () => {
    await ok(alice, "parliament", "bill submit", { title: "拒否される法", content: "..." });
    await ok(alice, "parliament", "bill open", { bill: 2 });
    await ok(alice, "parliament", "bill vote", { bill: 2, choice: "FOR" });
    await ok(bob, "parliament", "bill vote", { bill: 2, choice: "FOR" });
    assert.match((await ok(admin, "admin", "bill veto", { bill: 2, reason: "運営上困難" })).text, /拒否権行使/);
    assert.match((await ok(alice, "parliament", "bill override", { bill: 2 })).text, /再議決/);
    assert.equal((await run(admin, "admin", "dissolve", { reason: "テスト", confirm: false })).error, true);
    assert.match((await ok(admin, "admin", "dissolve", { reason: "民意を問う", confirm: true })).text, /議会解散/);
    const lapsed = await prisma.bill.findUniqueOrThrow({ where: { guildId_number: { guildId: GUILD, number: 2 } } });
    assert.equal(lapsed.status, "LAPSED");
    assert.match((await ok(admin, "admin", "citizen revoke", { user: carol, reason: "サブアカウント" })).text, /市民権の停止/);
    assert.equal((await run(carol, "citizen", "register")).error, true);
    await ok(admin, "admin", "citizen restore", { user: carol });
    await ok(carol, "citizen", "register");
    assert.match((await ok(admin, "admin", "dismiss", { user: { name: "judge" }, position: "CHIEF_JUSTICE", reason: "テスト" })).text, /罷免/);
  });
});
