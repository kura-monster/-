import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { DiscordjsErrorCodes, Events, type Client } from "discord.js";
import { connectionStage, loginErrorHint, watchConnection } from "../src/bot/connection";
import { cleanSecret } from "../src/config";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Discord への接続", () => {
  it("接続ログから、止まっている段階を見分ける", () => {
    assert.equal(connectionStage([]), "api");
    assert.equal(connectionStage(["Preparing to connect to the gateway..."]), "api");
    assert.equal(
      connectionStage(["[WS => Manager] Fetched Gateway Information", "[WS => Shard 0] Connecting to wss://gateway.discord.gg?v=10", "[WS => Shard 0] Waiting for event hello for 60000ms"]),
      "gateway",
    );
    // A retry starts over with "Connecting to", but the login itself had already been sent.
    assert.equal(
      connectionStage(["[WS => Shard 0] Identifying", "[WS => Shard 0] Waiting for event ready for 15000ms", "[WS => Shard 0] Connecting to wss://gateway.discord.gg?v=10"]),
      "identify",
    );
  });

  it("オンラインにならないまま時間がたつと接続ログを報告し、オンラインになれば止める", async () => {
    const client = new EventEmitter() as unknown as Client<true>;
    const reports: string[][] = [];
    watchConnection(client, { reportAfterMs: 30, repeatEveryMs: 40, report: (lines) => reports.push(lines) });
    client.emit(Events.Debug, "Provided token: MTQ4.abc.***");
    client.emit(Events.Debug, "[WS => Shard 0] Connecting to wss://gateway.discord.gg?v=10&encoding=json");
    client.emit(Events.Debug, "[WS => Manager] Session Limit Information\n\tTotal: 1000\n\tRemaining: 999");
    await wait(60);
    assert.ok(reports.length >= 1);
    assert.equal(reports[0].length, 2, "the token line is never kept");
    assert.match(reports[0][0], /^\d\d:\d\d:\d\d \[WS => Shard 0\] Connecting to/);
    assert.match(reports[0][1], /Session Limit Information \/ Total: 1000 \/ Remaining: 999$/);

    client.emit(Events.ClientReady, client);
    const count = reports.length;
    await wait(100);
    assert.equal(reports.length, count);
  });

  it("すぐにオンラインになれば何も報告しない", async () => {
    const client = new EventEmitter() as unknown as Client<true>;
    const reports: string[][] = [];
    watchConnection(client, { reportAfterMs: 30, report: (lines) => reports.push(lines) });
    client.emit(Events.ClientReady, client);
    await wait(60);
    assert.deepEqual(reports, []);
  });

  it("ログインを止めるエラーには対処法を示す", () => {
    assert.match(loginErrorHint(Object.assign(new Error("An invalid token was provided."), { code: DiscordjsErrorCodes.TokenInvalid })) ?? "", /Reset Token/);
    assert.match(loginErrorHint(new Error("Used disallowed intents")) ?? "", /SERVER MEMBERS INTENT/);
    assert.match(loginErrorHint(new Error("Not enough sessions remaining to spawn 1 shards; only 0 remaining")) ?? "", /上限/);
    assert.equal(loginErrorHint(new Error("something else")), null);
  });

  it("管理画面に貼り付けた値の引用符や空白を取り除く", () => {
    assert.equal(cleanSecret(' "abc.def.ghi" '), "abc.def.ghi");
    assert.equal(cleanSecret("'abc'"), "abc");
    assert.equal(cleanSecret("abc\n"), "abc");
    assert.equal(cleanSecret(undefined), "");
    assert.equal(cleanSecret(`"abc'`), `"abc'`);
  });
});
