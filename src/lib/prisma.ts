import "dotenv/config";
import { PrismaClient } from "@prisma/client";

// SQLite allows one writer at a time; a single pooled connection serializes our transactions
// instead of surfacing SQLITE_BUSY errors when the scheduler and a command write concurrently.
function withSingleConnection(url: string | undefined): string | undefined {
  if (!url || !url.startsWith("file:") || url.includes("connection_limit=")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=1`;
}

export const prisma = new PrismaClient({
  datasourceUrl: withSingleConnection(process.env.DATABASE_URL),
});
