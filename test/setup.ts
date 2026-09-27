import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every run gets its own brand-new SQLite file, so tests never touch a real database.
// Must run before anything imports src/lib/prisma.ts.
const dbFile = path.join(os.tmpdir(), `democracy-bot-test-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-session-secret-0123456789abcdef";
process.env.WEB_BASE_URL = "http://localhost:3999";
process.env.DISCORD_CLIENT_ID = "test-client-id";
process.env.DISCORD_CLIENT_SECRET = "test-client-secret";

execSync("npx prisma db push --skip-generate", {
  cwd: path.resolve(__dirname, ".."),
  stdio: "pipe",
  env: process.env,
});

process.on("exit", () => {
  for (const file of [dbFile, `${dbFile}-journal`]) fs.rmSync(file, { force: true });
});
