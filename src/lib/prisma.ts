import "dotenv/config";
import { Prisma, PrismaClient } from "@prisma/client";

// SQLite allows one writer at a time; a single pooled connection serializes our transactions
// instead of surfacing SQLITE_BUSY errors when the scheduler and a command write concurrently.
function withSingleConnection(url: string | undefined): string | undefined {
  if (!url || !url.startsWith("file:") || url.includes("connection_limit=")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=1`;
}

export const prisma = new PrismaClient({
  datasourceUrl: withSingleConnection(process.env.DATABASE_URL),
});

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
