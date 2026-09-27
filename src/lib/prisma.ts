import "dotenv/config";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";

const PROJECT_ROOT = path.resolve(__dirname, "../..");

// Same default as .env.example, so the bot also starts where only the Discord settings were entered
// (a host that imports from GitHub never sees the git-ignored .env).
process.env.DATABASE_URL ||= "file:./dev.db";

// SQLite allows one writer at a time; a single pooled connection serializes our transactions
// instead of surfacing SQLITE_BUSY errors when the scheduler and a command write concurrently.
function withSingleConnection(url: string | undefined): string | undefined {
  if (!url || !url.startsWith("file:") || url.includes("connection_limit=")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=1`;
}

export const prisma = new PrismaClient({
  datasourceUrl: withSingleConnection(process.env.DATABASE_URL),
});

/** The file a SQLite URL points to. Like Prisma, relative paths are resolved from the prisma/ folder. */
export function databaseFile(url = process.env.DATABASE_URL ?? ""): string | null {
  if (!url.startsWith("file:")) return null;
  return path.resolve(PROJECT_ROOT, "prisma", url.slice("file:".length).split("?")[0]);
}

/**
 * Creates the database or brings it up to date with prisma/schema.prisma (`prisma db push`).
 * Changes that would lose data are refused (no --accept-data-loss), so they fail here and are left to the operator.
 */
export function pushSchema(url = process.env.DATABASE_URL): { ok: boolean; output: string } {
  let cli: string;
  try {
    cli = path.join(path.dirname(require.resolve("prisma/package.json", { paths: [PROJECT_ROOT] })), "build/index.js");
  } catch {
    return { ok: false, output: "prisma パッケージがインストールされていません。" };
  }
  const result = spawnSync(process.execPath, [cli, "db", "push", "--skip-generate"], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: url, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim() || String(result.error ?? "");
  return { ok: result.status === 0, output };
}

/**
 * Reads one row from every table so that a database that was never created (or predates the current schema)
 * is reported at startup with the fix, instead of as errors on the first command or page view.
 */
export async function findSchemaProblem(client: PrismaClient = prisma): Promise<string | null> {
  const delegates = client as unknown as Record<string, { findFirst(): Promise<unknown> }>;
  for (const model of Object.values(Prisma.ModelName)) {
    try {
      await delegates[model.charAt(0).toLowerCase() + model.slice(1)].findFirst();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2021" || error.code === "P2022")) {
        return error.message.trim().split("\n").pop() ?? error.code;
      }
      throw error;
    }
  }
  return null;
}
