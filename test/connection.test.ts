import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import net, { type AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { DiscordjsErrorCodes, Events, type Client } from "discord.js";
import { connectionStage, loginErrorHint, watchConnection } from "../src/bot/connection";
import { cleanSecret } from "../src/config";
import fs from "node:fs";
import path from "node:path";
import { describeProxy, probeGateway, probeProxyTunnel, proxyFor, routeWebSocketsThroughProxy } from "../src/lib/network";

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

  it("HTTPS_PROXY などのプロキシ設定を、NO_PROXY の除外も含めて読む", () => {
    const host = "gateway.discord.gg";
    assert.equal(proxyFor(host, {}), null);
    assert.equal(proxyFor(host, { HTTPS_PROXY: "http://proxy.local:3128" }), "http://proxy.local:3128");
    assert.equal(proxyFor(host, { https_proxy: "http://lower.local:3128" }), "http://lower.local:3128");
    assert.equal(proxyFor(host, { HTTP_PROXY: "http://plain.local:8080" }), "http://plain.local:8080");
    for (const bypass of ["*", "discord.gg", ".discord.gg", "*.discord.gg", "gateway.discord.gg:443", "example.com, .discord.gg"]) {
      assert.equal(proxyFor(host, { HTTPS_PROXY: "http://proxy.local:3128", NO_PROXY: bypass }), null, bypass);
    }
    assert.equal(proxyFor(host, { HTTPS_PROXY: "http://p", no_proxy: "discord.gg" }), null);
    assert.equal(proxyFor(host, { HTTPS_PROXY: "http://p", NO_PROXY: "notdiscord.gg,example.com" }), "http://p");
  });

  it("ログに出すプロキシのURLから認証情報を取り除く", () => {
    assert.equal(describeProxy("http://user:secret@proxy.local:3128"), "http://proxy.local:3128");
    assert.equal(describeProxy("not a url"), "（URLの形式ではありません）");
  });

  it("WebSocket をプロキシ経由にするのは Bun のときだけ（Node.js では何も変えない）", () => {
    const before = globalThis.WebSocket;
    assert.equal(routeWebSocketsThroughProxy({ HTTPS_PROXY: "http://proxy.local:3128" }), null);
    assert.equal(globalThis.WebSocket, before);
  });

  it("接続できないときのネットワーク確認で、直接接続の結果を示す", async () => {
    const probe = net.createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    const { port } = probe.address() as AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    const lines = await probeGateway("localhost", port, 1000);
    assert.match(lines[0], /^プロキシ: /);
    assert.ok(lines.some((line) => /^DNS: localhost → .*127\.0\.0\.1/.test(line)), lines.join("\n"));
    assert.ok(lines.some((line) => /^直接接続 IPv4（127\.0\.0\.1）: 接続できません（ECONNREFUSED）$/.test(line)), lines.join("\n"));
  });

  it("プロキシが gateway へのトンネルを開けるかを確かめる", async () => {
    const refusing = net.createServer((socket) => socket.once("data", () => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"))).listen(0, "127.0.0.1");
    await once(refusing, "listening");
    const refusingPort = (refusing.address() as AddressInfo).port;
    try {
      assert.equal(await probeProxyTunnel(`http://127.0.0.1:${refusingPort}`, "gateway.discord.gg", 443, 1000), "プロキシが拒否しました（HTTP/1.1 403 Forbidden）");
    } finally {
      refusing.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await probeProxyTunnel(`http://127.0.0.1:${refusingPort}`, "gateway.discord.gg", 443, 1000), "プロキシに接続できません（ECONNREFUSED）");
    assert.equal(await probeProxyTunnel("socks5://127.0.0.1:1080", "gateway.discord.gg", 443), "socks5: のプロキシは確認できません");
  });

  it("起動ファイルは discord.js や Prisma を読み込む前に準備を済ませる（本体は後から読み込む）", () => {
    const staticImports = (file: string) =>
      [...fs.readFileSync(path.resolve(__dirname, "..", file), "utf8").matchAll(/^import\s[^;]*?from\s+"([^"]+)"|^import\s+"([^"]+)"/gm)].map((m) => m[1] ?? m[2]);
    // Bun runs CommonJS packages before the importing module's own code, so anything more here would load them too early.
    assert.deepEqual(staticImports("src/index.ts"), ["./lib/network", "./lib/prisma-generate"]);
    for (const file of ["src/lib/network.ts", "src/lib/prisma-generate.ts"]) {
      assert.ok(staticImports(file).every((name) => name.startsWith("node:")), file);
    }
    assert.match(fs.readFileSync(path.resolve(__dirname, "../src/index.ts"), "utf8"), /import\("\.\/app"\)/);
  });
});
