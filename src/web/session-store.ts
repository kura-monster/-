import session, { type SessionData } from "express-session";
import { prisma } from "../lib/prisma";
import { DAY } from "../core/time";

/** Keeps web logins in the same SQLite database so they survive restarts. Expired rows are purged by the scheduler. */
export class PrismaSessionStore extends session.Store {
  override get(sid: string, callback: (error: unknown, session?: SessionData | null) => void): void {
    prisma.session
      .findUnique({ where: { sid } })
      .then((row) => callback(null, row && row.expiresAt > new Date() ? (JSON.parse(row.data) as SessionData) : null))
      .catch((error) => callback(error));
  }

  override set(sid: string, data: SessionData, callback?: (error?: unknown) => void): void {
    const expiresAt = data.cookie?.expires ? new Date(data.cookie.expires) : new Date(Date.now() + DAY);
    const json = JSON.stringify(data);
    prisma.session
      .upsert({ where: { sid }, create: { sid, data: json, expiresAt }, update: { data: json, expiresAt } })
      .then(() => callback?.())
      .catch((error) => callback?.(error));
  }

  override destroy(sid: string, callback?: (error?: unknown) => void): void {
    prisma.session
      .deleteMany({ where: { sid } })
      .then(() => callback?.())
      .catch((error) => callback?.(error));
  }

  override touch(sid: string, data: SessionData, callback?: () => void): void {
    const expiresAt = data.cookie?.expires ? new Date(data.cookie.expires) : new Date(Date.now() + DAY);
    prisma.session
      .updateMany({ where: { sid }, data: { expiresAt } })
      .then(() => callback?.())
      .catch(() => callback?.());
  }
}
