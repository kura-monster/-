import crypto from "node:crypto";
import { Router, type Request } from "express";
import { config } from "../config";

export interface WebUser {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
}

declare module "express-session" {
  interface SessionData {
    user?: WebUser;
    oauthState?: string;
    returnTo?: string;
  }
}

export const SESSION_COOKIE = "democracy.sid";
const DISCORD_API = "https://discord.com/api/v10";
const redirectUri = () => `${config.webBaseUrl}/auth/callback`;

/** Only same-site relative paths, so the login flow cannot be used as an open redirect. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function fetchDiscordUser(code: string): Promise<WebUser> {
  const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
    }),
  });
  if (!tokenResponse.ok) throw new Error(`token exchange failed: ${tokenResponse.status}`);
  const token = (await tokenResponse.json()) as { access_token: string };
  const userResponse = await fetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!userResponse.ok) throw new Error(`user lookup failed: ${userResponse.status}`);
  const user = (await userResponse.json()) as { id: string; username: string; global_name?: string | null; avatar?: string | null };
  return { id: user.id, username: user.username, globalName: user.global_name ?? null, avatar: user.avatar ?? null };
}

let warnedInsecureCookie = false;

function warnIfCookieInsecure(req: Request): void {
  if (warnedInsecureCookie || req.secure || !config.webBaseUrl.startsWith("https://")) return;
  warnedInsecureCookie = true;
  console.warn(
    config.trustProxy
      ? "[注意] プロキシから HTTPS であること（X-Forwarded-Proto: https）が届いていないため、ログインCookieに Secure 属性を付けていません。"
      : "[注意] TRUST_PROXY=false のため HTTPS 接続を判別できず、ログインCookieに Secure 属性を付けていません。TRUST_PROXY の行を削除するか true にしてください。",
  );
}

export const authRouter = Router();

authRouter.get("/login", (req, res, next) => {
  if (!config.clientId || !config.clientSecret) {
    res.status(503).type("text/plain; charset=utf-8").send("Discordログインが設定されていません（DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET）。");
    return;
  }
  warnIfCookieInsecure(req);
  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;
  req.session.returnTo = safeReturnTo(req.query.returnTo);
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "identify",
    state,
    prompt: "none",
  });
  req.session.save((error) => (error ? next(error) : res.redirect(`https://discord.com/oauth2/authorize?${params}`)));
});

authRouter.get("/callback", async (req, res, next) => {
  const { code, state } = req.query;
  const expected = req.session.oauthState;
  if (typeof code !== "string" || typeof state !== "string" || !expected || !sameToken(state, expected)) {
    res.status(400).type("text/plain; charset=utf-8").send("ログインの検証に失敗しました。もう一度ログインしてください。");
    return;
  }
  const returnTo = safeReturnTo(req.session.returnTo);
  let user: WebUser;
  try {
    user = await fetchDiscordUser(code);
  } catch (error) {
    console.error("[oauth]", error);
    res.status(502).type("text/plain; charset=utf-8").send("Discordとの通信に失敗しました。時間をおいて再度お試しください。");
    return;
  }
  // A fresh session id after login prevents session fixation.
  req.session.regenerate((regenerateError) => {
    if (regenerateError) return next(regenerateError);
    req.session.user = user;
    req.session.save((saveError) => (saveError ? next(saveError) : res.redirect(returnTo)));
  });
});

authRouter.post("/logout", (req, res, next) => {
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });
});
