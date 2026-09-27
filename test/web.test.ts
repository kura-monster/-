import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { prisma } from "../src/lib/prisma";
import { closeRegistration, standForElection, startElection } from "../src/services/election";
import { ensureGuild } from "../src/services/guild";
import { safeReturnTo } from "../src/web/auth";
import { createWebApp } from "../src/web/server";
import { GUILD, actor, discordIdOf, register, setupGuild } from "./helpers";

const cookieSignature = require("cookie-signature") as { sign(value: string, secret: string): string };

const ORIGIN = "http://localhost:3999";
let server: Server;
let base: string;

async function sessionCookie(discordId: string, name: string): Promise<string> {
  const sid = crypto.randomUUID();
  const expires = new Date(Date.now() + 86_400_000);
  const data = {
    cookie: { originalMaxAge: 86_400_000, expires: expires.toISOString(), httpOnly: true, path: "/", sameSite: "lax", secure: false },
    user: { id: discordId, username: name, globalName: name, avatar: null },
  };
  await prisma.session.create({ data: { sid, data: JSON.stringify(data), expiresAt: expires } });
  return `democracy.sid=${encodeURIComponent(`s:${cookieSignature.sign(sid, process.env.SESSION_SECRET as string)}`)}`;
}

async function get(path: string, cookie?: string) {
  return fetch(`${base}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
}

async function post(path: string, cookie: string, body: unknown, headers: Record<string, string> = { origin: ORIGIN }) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

describe("Webダッシュボード", () => {
  let voter: string;
  let outsider: string;
  let electionId: string;
  let candidateId: string;

  before(async () => {
    await setupGuild({ seats: 1 });
    await ensureGuild("guild-2", "隣国");
    for (const name of ["alice", "bob", "voter"]) await register(name);
    const election = await startElection(actor("admin", true), { kind: "GENERAL" });
    electionId = election.id;
    await standForElection(actor("alice"), "<img src=x onerror=alert(1)>");
    await standForElection(actor("bob"));
    await closeRegistration(GUILD, election.id);
    candidateId = (await prisma.candidate.findFirstOrThrow({ where: { electionId, citizen: { discordId: discordIdOf("alice") } } })).id;
    voter = await sessionCookie(discordIdOf("voter"), "voter");
    outsider = await sessionCookie("stranger", "stranger");
    server = createWebApp().listen(0);
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("ページと静的ファイルをセキュリティヘッダー付きで返す", async () => {
    for (const path of ["/", "/g/123/election"]) {
      const res = await get(path);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/html/);
      assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'self'/);
      assert.equal(res.headers.get("x-frame-options"), "DENY");
    }
    const script = await get("/app.js");
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
    assert.equal((await get("/api/nothing")).status, 404);
  });

  it("ログインしていなければ国のデータは見られない", async () => {
    assert.deepEqual(await (await get("/api/me")).json(), { user: null, guilds: [] });
    assert.equal((await get(`/api/guilds/${GUILD}/overview`)).status, 401);
  });

  it("その国の市民でなければ見られない（他国のデータも見られない）", async () => {
    assert.equal((await get(`/api/guilds/${GUILD}/overview`, outsider)).status, 403);
    assert.equal((await get("/api/guilds/guild-2/overview", voter)).status, 403);
    const me = (await (await get("/api/me", voter)).json()) as { guilds: { id: string }[] };
    assert.deepEqual(me.guilds.map((g) => g.id), [GUILD]);
    const overview = (await (await get(`/api/guilds/${GUILD}/overview`, voter)).json()) as { catalog: unknown[]; me: { name: string } };
    assert.equal(overview.catalog.length, 14);
    assert.equal(overview.me.name, "voter");
  });

  it("投票はOrigin検証・二重投票防止つきで、投票先は返さない", async () => {
    const path = `/api/guilds/${GUILD}/elections/${electionId}/ballot`;
    assert.equal((await post(path, voter, { candidateId }, {})).status, 403, "Originなしは拒否");
    assert.equal((await post(path, voter, { candidateId }, { origin: "https://evil.example" })).status, 403);
    const form = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: voter, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: `candidateId=${candidateId}`,
    });
    assert.equal(form.status, 400, "フォーム送信は受け付けない");
    assert.equal((await post(path, voter, { candidateId })).status, 200);
    const again = await post(path, voter, { candidateId });
    assert.equal(again.status, 400);
    assert.match(((await again.json()) as { error: string }).error, /すでに投票済み/);

    const view = (await (await get(`/api/guilds/${GUILD}/election`, voter)).json()) as {
      viewer: { voted: boolean };
      current: { candidates: Record<string, unknown>[] };
    };
    assert.equal(view.viewer.voted, true);
    for (const c of view.current.candidates) assert.ok(!("voteCount" in c), "開票前に得票を返さない");
    assert.equal(await prisma.ballot.count({ where: { electionId } }), 1);
  });

  it("不正な番号は400、存在しない法案は404", async () => {
    assert.equal((await get(`/api/guilds/${GUILD}/bills/abc`, voter)).status, 400);
    assert.equal((await get(`/api/guilds/${GUILD}/bills/99`, voter)).status, 404);
  });

  it("Discordログインはstate検証つき、リダイレクト先は同一サイトのみ", async () => {
    const login = await get("/auth/login?returnTo=/g/1/election");
    assert.equal(login.status, 302);
    const location = new URL(login.headers.get("location") ?? "");
    assert.equal(location.host, "discord.com");
    assert.equal(location.searchParams.get("scope"), "identify");
    assert.ok((location.searchParams.get("state") ?? "").length >= 32);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    assert.equal((await get("/auth/callback?code=abc&state=forged", cookie)).status, 400);
    assert.equal((await get("/auth/callback?code=abc&state=anything")).status, 400);

    assert.equal(safeReturnTo("/g/1/election"), "/g/1/election");
    for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", 42, undefined]) assert.equal(safeReturnTo(bad), "/");
  });

  it("旧バージョンの投票リンクは新しい選挙ページへ転送する", async () => {
    const res = await get(`/elections/${electionId}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `/g/${GUILD}/election`);
  });
});
