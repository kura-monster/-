import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";
import { config, normalizeBaseUrl, resolvePort } from "../src/config";
import { databaseFile, findSchemaProblem, pushSchema } from "../src/lib/prisma";
import { createWebApp } from "../src/web/server";

describe("公開環境での起動", () => {
  it("WEB_BASE_URL はスキームなしのドメインでも受け付け、オリジンにそろえる", () => {
    assert.equal(normalizeBaseUrl("democracy.k-r.lol"), "https://democracy.k-r.lol");
    assert.equal(normalizeBaseUrl(" https://democracy.k-r.lol/ "), "https://democracy.k-r.lol");
    assert.equal(normalizeBaseUrl("https://democracy.k-r.lol/auth/callback"), "https://democracy.k-r.lol");
    assert.equal(normalizeBaseUrl("localhost:3000"), "http://localhost:3000");
    assert.equal(normalizeBaseUrl("127.0.0.1:8080/"), "http://127.0.0.1:8080");
    assert.equal(normalizeBaseUrl(undefined), "http://localhost:3000");
    assert.throws(() => normalizeBaseUrl("ftp://democracy.k-r.lol"), /http:\/\/ か https:\/\//);
    assert.throws(() => normalizeBaseUrl("https://"), /形式が正しくありません/);
  });

  it("ポートは WEB_PORT → PORT → SERVER_PORT の順に読み、食い違う指定があれば知らせる", () => {
    assert.deepEqual(resolvePort({}), { port: 3000, from: "既定値", others: [] });
    assert.deepEqual(resolvePort({ SERVER_PORT: "12966" }), { port: 12966, from: "SERVER_PORT", others: [] });
    assert.deepEqual(resolvePort({ WEB_PORT: " ", PORT: "5000", SERVER_PORT: "5000" }), { port: 5000, from: "PORT", others: [] });
    assert.deepEqual(resolvePort({ WEB_PORT: "3000", SERVER_PORT: "12966" }), { port: 3000, from: "WEB_PORT", others: ["SERVER_PORT=12966"] });
    assert.throws(() => resolvePort({ WEB_PORT: "abc", PORT: "5000" }), /WEB_PORT は 1〜65535/);
    assert.throws(() => resolvePort({ PORT: "70000" }), /PORT は 1〜65535/);
  });

  it("HTTPS のプロキシの後ろでは Secure Cookie を発行し、プロキシが HTTPS を伝えなくてもログインを続けられる", async () => {
    const saved = { webBaseUrl: config.webBaseUrl, trustProxy: config.trustProxy };
    Object.assign(config, { webBaseUrl: "https://democracy.example", trustProxy: true });
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => void warnings.push(message);
    const server = createWebApp().listen(0);
    try {
      await once(server, "listening");
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/login`;

      const viaProxy = await fetch(url, { headers: { "x-forwarded-proto": "https" }, redirect: "manual" });
      assert.equal(viaProxy.status, 302);
      assert.match(viaProxy.headers.get("set-cookie") ?? "", /^democracy\.sid=.*; Secure/);
      assert.match(viaProxy.headers.get("location") ?? "", /redirect_uri=https%3A%2F%2Fdemocracy\.example%2Fauth%2Fcallback/);
      assert.deepEqual(warnings, []);

      const unlabeled = await fetch(url, { redirect: "manual" });
      assert.equal(unlabeled.status, 302);
      assert.match(unlabeled.headers.get("set-cookie") ?? "", /^democracy\.sid=/);
      assert.doesNotMatch(unlabeled.headers.get("set-cookie") ?? "", /Secure/);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /X-Forwarded-Proto/);
    } finally {
      console.warn = warn;
      Object.assign(config, saved);
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("データベースは起動時に自動で作成・更新し、データが消える変更は行わない", async () => {
    const file = path.join(os.tmpdir(), `democracy-bot-push-${process.pid}-${Date.now()}.db`);
    const url = `file:${file}`;
    assert.equal(databaseFile(url), file);
    assert.equal(databaseFile("file:./dev.db?connection_limit=1"), path.resolve(__dirname, "../prisma/dev.db"));
    assert.equal(databaseFile("postgresql://db.example/democracy"), null);

    const created = pushSchema(url);
    assert.ok(created.ok, created.output);
    const client = new PrismaClient({ datasourceUrl: url });
    try {
      assert.equal(await findSchemaProblem(client), null);
      assert.ok(pushSchema(url).ok, "an up-to-date database is left as is");

      // A column the schema no longer has, still holding data: pushing would drop it, so it must be refused.
      await client.guild.create({ data: { id: "old", name: "旧国" } });
      await client.$executeRawUnsafe(`ALTER TABLE "Guild" ADD COLUMN "legacy" TEXT`);
      await client.$executeRawUnsafe(`UPDATE "Guild" SET "legacy" = 'kept'`);
      const refused = pushSchema(url);
      assert.equal(refused.ok, false);
      assert.match(refused.output, /data loss/i);
      assert.deepEqual(await client.$queryRawUnsafe(`SELECT "legacy" FROM "Guild"`), [{ legacy: "kept" }]);
    } finally {
      await client.$disconnect();
      for (const f of [file, `${file}-journal`]) fs.rmSync(f, { force: true });
    }
  });

  it("データベースが未作成・古い構造なら、起動時に原因を示せる", async () => {
    assert.equal(await findSchemaProblem(), null);
    const file = path.join(os.tmpdir(), `democracy-bot-empty-${process.pid}-${Date.now()}.db`);
    const empty = new PrismaClient({ datasourceUrl: `file:${file}` });
    try {
      assert.match((await findSchemaProblem(empty)) ?? "", /table `main\.\w+` does not exist/);
    } finally {
      await empty.$disconnect();
      for (const f of [file, `${file}-journal`]) fs.rmSync(f, { force: true });
    }
  });
});
