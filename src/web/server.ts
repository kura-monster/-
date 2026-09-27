import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import { prisma } from "../lib/prisma";
import { config, sessionSecret } from "../config";
import { DomainError } from "../core/errors";
import { DAY } from "../core/time";
import { apiRouter } from "./api";
import { SESSION_COOKIE, authRouter } from "./auth";
import { PrismaSessionStore } from "./session-store";

const PUBLIC_DIR = path.resolve(__dirname, "../../public");

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' https://cdn.discordapp.com data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
}

export function createWebApp(): express.Express {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);
  app.use(securityHeaders);
  app.use(express.json({ limit: "16kb" }));
  app.use(
    session({
      name: SESSION_COOKIE,
      secret: sessionSecret(),
      store: new PrismaSessionStore(),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.webBaseUrl.startsWith("https://"),
        maxAge: 7 * DAY,
      },
    }),
  );

  app.use("/auth", authRouter);
  app.use("/api", apiRouter);
  app.use(express.static(PUBLIC_DIR, { index: false }));

  const page = (_req: Request, res: Response) => res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  app.get("/", page);
  app.get("/g/:guildId", page);
  app.get("/g/:guildId/:tab", page);

  // Links posted by earlier versions of the bot.
  app.get("/elections/:id", async (req: Request<{ id: string }>, res) => {
    const election = await prisma.election.findUnique({ where: { id: req.params.id } });
    res.redirect(election ? `/g/${election.guildId}/election` : "/");
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "見つかりません。" });
  });
  app.use((_req, res) => {
    res.status(404).sendFile(path.join(PUBLIC_DIR, "index.html"));
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof DomainError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("[web]", error);
    res.status(500).json({ error: "サーバーエラーが発生しました。" });
  });
  return app;
}
