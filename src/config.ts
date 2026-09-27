import "dotenv/config";
import crypto from "node:crypto";

const env = process.env;
const isProduction = env.NODE_ENV === "production";

/**
 * Accepts "democracy.example.com", "https://democracy.example.com/" and the like, and returns the origin.
 * A bare domain is assumed to be served over HTTPS (localhost over HTTP).
 */
export function normalizeBaseUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return "http://localhost:3000";
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(value);
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `${isLocal ? "http" : "https"}://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`WEB_BASE_URL の形式が正しくありません（"${raw}"）。例: https://democracy.example.com`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`WEB_BASE_URL は http:// か https:// のURLにしてください（"${raw}"）。`);
  }
  return url.origin;
}

const PORT_VARIABLES = ["WEB_PORT", "PORT", "SERVER_PORT"] as const;

/**
 * Hosting services usually hand the app its port as PORT or SERVER_PORT; WEB_PORT overrides both.
 * `others` lists the variables that were set to a different port and lost, so the startup log can point at a mismatch.
 */
export function resolvePort(source: Record<string, string | undefined>): { port: number; from: string; others: string[] } {
  const set = PORT_VARIABLES.flatMap((name) => {
    const raw = source[name]?.trim();
    return raw ? [{ name, raw }] : [];
  });
  if (set.length === 0) return { port: 3000, from: "既定値", others: [] };
  const { name, raw } = set[0];
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} は 1〜65535 のポート番号にしてください（"${raw}"）。`);
  }
  const others = set.slice(1).filter((v) => Number(v.raw) !== port).map((v) => `${v.name}=${v.raw}`);
  return { port, from: name, others };
}

const webBaseUrl = normalizeBaseUrl(env.WEB_BASE_URL);
const { port: webPort, from: webPortFrom, others: webPortOthers } = resolvePort(env);

/** Values typed into a hosting panel can keep the quotes (or the "Bot " prefix) that a .env file would have dropped. */
export function cleanSecret(raw: string | undefined): string {
  return (raw ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
}

let cachedSessionSecret: string | undefined;

export const config = {
  isProduction,
  discordToken: cleanSecret(env.DISCORD_TOKEN).replace(/^Bot\s+/i, ""),
  clientId: cleanSecret(env.DISCORD_CLIENT_ID),
  clientSecret: cleanSecret(env.DISCORD_CLIENT_SECRET),
  devGuildId: env.DISCORD_GUILD_ID || undefined,
  webPort,
  webPortFrom,
  webPortOthers,
  webBaseUrl,
  // The app itself only speaks plain HTTP, so an https:// public URL means TLS ends at a proxy in front of it.
  trustProxy: env.TRUST_PROXY?.trim() ? env.TRUST_PROXY.trim().toLowerCase() === "true" : webBaseUrl.startsWith("https://"),
};

export function sessionSecret(): string {
  if (cachedSessionSecret) return cachedSessionSecret;
  const fromEnv = env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    cachedSessionSecret = fromEnv;
  } else if (isProduction) {
    throw new Error("本番環境では SESSION_SECRET（16文字以上）を設定してください。");
  } else {
    console.warn("[注意] SESSION_SECRET が未設定のため一時的な値を使用します（再起動するとログアウトされます）。");
    cachedSessionSecret = crypto.randomBytes(32).toString("hex");
  }
  return cachedSessionSecret;
}
