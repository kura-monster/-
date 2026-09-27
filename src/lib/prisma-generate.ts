import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(__dirname, "../..");

/** The schema copy inside the generated client, found the way @prisma/client itself finds that client. */
function generatedSchemaPath(): string | null {
  try {
    const prismaClient = path.dirname(require.resolve("@prisma/client/package.json", { paths: [PROJECT_ROOT] }));
    return path.join(path.dirname(require.resolve(".prisma/client/package.json", { paths: [prismaClient] })), "schema.prisma");
  } catch {
    return null;
  }
}

/**
 * The Prisma client under node_modules is generated from prisma/schema.prisma when packages are installed, so a host
 * that pulls new code without reinstalling keeps a client that fails on every new column. The generated client keeps
 * a copy of the schema it came from; when that differs from the current schema, it is generated again.
 * Has to run before anything loads @prisma/client.
 */
export function regeneratePrismaClientIfStale(): { status: "fresh" | "regenerated" } | { status: "failed"; output: string } {
  const schema = fs.readFileSync(path.join(PROJECT_ROOT, "prisma", "schema.prisma"), "utf8");
  const generated = generatedSchemaPath();
  if (generated && fs.existsSync(generated) && fs.readFileSync(generated, "utf8") === schema) return { status: "fresh" };
  let cli: string;
  try {
    cli = path.join(path.dirname(require.resolve("prisma/package.json", { paths: [PROJECT_ROOT] })), "build/index.js");
  } catch {
    return { status: "failed", output: "prisma パッケージがインストールされていません。" };
  }
  const result = spawnSync(process.execPath, [cli, "generate"], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, CHECKPOINT_DISABLE: "1", PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status === 0) return { status: "regenerated" };
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim() || String(result.error ?? "");
  return { status: "failed", output: output.split("\n").slice(-10).join("\n") };
}
