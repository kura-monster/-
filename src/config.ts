import "dotenv/config";
import crypto from "node:crypto";

const env = process.env;
const isProduction = env.NODE_ENV === "production";

let cachedSessionSecret: string | undefined;

export const config = {
  isProduction,
  discordToken: env.DISCORD_TOKEN ?? "",
  clientId: env.DISCORD_CLIENT_ID ?? "",
  clientSecret: env.DISCORD_CLIENT_SECRET ?? "",
  devGuildId: env.DISCORD_GUILD_ID || undefined,
  webPort: Number(env.WEB_PORT ?? 3000),
  webBaseUrl: (env.WEB_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
  trustProxy: env.TRUST_PROXY === "true",
};

export function sessionSecret(): string {
  if (cachedSessionSecret) return cachedSessionSecret;
  const fromEnv = env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    cachedSessionSecret = fromEnv;
  } else if (isProduction) {
    throw new Error("本番環境では SESSION_SECRET（16文字以上）を設定してください。");
  } else {
    console.warn("⚠️ SESSION_SECRET が未設定のため一時的な値を使用します（再起動するとログアウトされます）。");
    cachedSessionSecret = crypto.randomBytes(32).toString("hex");
  }
  return cachedSessionSecret;
}
