import { Router, Request, Response } from "express";

declare module "express-session" {
  interface SessionData {
    user?: {
      id: string;
      username: string;
      avatar: string | null;
      guilds: Array<{ id: string; name: string; icon: string | null }>;
    };
    accessToken?: string;
  }
}

const router = Router();

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const BASE_URL = process.env.WEB_BASE_URL || "http://localhost:3000";
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

router.get("/login", (_req: Request, res: Response) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "identify guilds",
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

router.get("/callback", async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send("認証コードがありません。");
    return;
  }

  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json() as { access_token: string };
    const accessToken = tokenData.access_token;

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const user = await userRes.json() as { id: string; username: string; avatar: string | null };

    const guildsRes = await fetch("https://discord.com/api/users/@me/guilds", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const guilds = await guildsRes.json() as Array<{ id: string; name: string; icon: string | null }>;

    req.session.user = {
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      guilds,
    };
    req.session.accessToken = accessToken;

    res.redirect("/dashboard");
  } catch (error) {
    console.error("OAuth error:", error);
    res.status(500).send("認証に失敗しました。");
  }
});

router.get("/user-info", (req: Request, res: Response) => {
  if (!req.session.user) {
    res.status(401).json({ error: "未ログイン" });
    return;
  }
  res.json(req.session.user);
});

router.get("/logout", (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

export { router as authRoutes };
