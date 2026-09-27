import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { DiscordAPIError, Events, RESTJSONErrorCodes, type Client } from "discord.js";
import { clearGlobalCommands, keepCommandsRegistered, registerInGuilds } from "../src/bot/command-sync";
import { COMMANDS } from "../src/bot/commands";

const APP = "1553617566004412517";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Records what would be sent to Discord; the given servers refuse like a bot invited without applications.commands. */
function fakeRest(globalCommands: unknown[] = [], refusing: string[] = []) {
  const puts: { route: string; names: string[] }[] = [];
  return {
    puts,
    async get(route: string) {
      assert.equal(route, `/applications/${APP}/commands`);
      return globalCommands;
    },
    async put(route: string, options: { body: { name: string }[] }) {
      const guildId = route.match(/\/guilds\/(\d+)\//)?.[1];
      if (guildId && refusing.includes(guildId)) {
        throw new DiscordAPIError({ message: "Missing Access", code: RESTJSONErrorCodes.MissingAccess }, RESTJSONErrorCodes.MissingAccess, 403, "PUT", route, {});
      }
      puts.push({ route, names: options.body.map((command) => command.name) });
    },
  };
}

function quietly<T>(run: (logs: string[]) => Promise<T>): Promise<T> {
  const logs: string[] = [];
  const { log, warn } = console;
  console.log = (message: string) => void logs.push(message);
  console.warn = (message: string) => void logs.push(message);
  return run(logs).finally(() => {
    console.log = log;
    console.warn = warn;
  });
}

const allNames = COMMANDS.map((command) => command.data.name);

describe("スラッシュコマンドの登録", () => {
  it("サーバーごとに全コマンドを登録し、登録できないサーバーがあっても残りを続ける", async () => {
    const rest = fakeRest([], ["200"]);
    const result = await registerInGuilds(rest as never, APP, [
      { id: "100", name: "一の国" },
      { id: "200", name: "招待し直しが必要な国" },
      { id: "300", name: "三の国" },
    ]);
    assert.equal(result.registered, 2);
    assert.deepEqual(
      rest.puts.map((p) => p.route),
      [`/applications/${APP}/guilds/100/commands`, `/applications/${APP}/guilds/300/commands`],
    );
    for (const put of rest.puts) assert.deepEqual(put.names, allNames);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], /招待し直しが必要な国.*200.*招待し直してください/);
  });

  it("全体向けに登録されたコマンドがあれば、二重表示を防ぐために消す", async () => {
    const withGlobal = fakeRest([{ name: "help" }, { name: "citizen" }]);
    assert.equal(await clearGlobalCommands(withGlobal as never, APP), 2);
    assert.deepEqual(withGlobal.puts, [{ route: `/applications/${APP}/commands`, names: [] }]);

    const without = fakeRest([]);
    assert.equal(await clearGlobalCommands(without as never, APP), 0);
    assert.deepEqual(without.puts, []);
  });

  it("起動時・サーバー参加時・一定時間ごとに登録する", async () => {
    await quietly(async (logs) => {
      const rest = fakeRest([{ name: "help" }]);
      const client = Object.assign(new EventEmitter(), {
        application: { id: APP },
        guilds: { cache: new Map([["100", { id: "100", name: "一の国" }], ["300", { id: "300", name: "三の国" }]]) },
        rest,
      }) as unknown as Client<true>;
      const routes = () => rest.puts.map((p) => p.route);

      const stop = keepCommandsRegistered(client, 60);
      await wait(20);
      assert.deepEqual(routes(), [`/applications/${APP}/commands`, `/applications/${APP}/guilds/100/commands`, `/applications/${APP}/guilds/300/commands`]);
      assert.ok(logs.some((line) => /起動時のコマンド登録: 2\/2 サーバー/.test(line)));

      client.emit(Events.GuildCreate, { id: "400", name: "新しい国" } as never);
      await wait(10);
      assert.equal(routes().at(-1), `/applications/${APP}/guilds/400/commands`);
      assert.ok(logs.some((line) => /サーバー「新しい国」に参加し、コマンドを登録しました/.test(line)));

      rest.puts.length = 0;
      await wait(70);
      assert.deepEqual(routes(), [`/applications/${APP}/guilds/100/commands`, `/applications/${APP}/guilds/300/commands`]);
      assert.ok(logs.some((line) => /定期のコマンド登録: 2\/2 サーバー/.test(line)));

      stop();
      rest.puts.length = 0;
      await wait(80);
      client.emit(Events.GuildCreate, { id: "500", name: "止めた後の国" } as never);
      await wait(10);
      assert.deepEqual(rest.puts, []);
    });
  });
});
