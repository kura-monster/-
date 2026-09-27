import express from "express";
import session from "express-session";
import path from "path";
import { authRoutes } from "./routes/auth";
import { electionRoutes } from "./routes/elections";
import { dashboardRoutes } from "./routes/dashboard";
import { apiRoutes } from "./routes/api";
import "dotenv/config";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "democracy-bot-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);

app.use("/auth", authRoutes);
app.use("/elections", electionRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/api", apiRoutes);

app.get("/", (_req, res) => {
  res.redirect("/dashboard");
});

export { app };

if (require.main === module) {
  const port = process.env.WEB_PORT || 3000;
  app.listen(port, () => {
    console.log(`🌐 Webサーバー起動: http://localhost:${port}`);
  });
}
