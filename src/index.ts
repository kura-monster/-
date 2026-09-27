import "dotenv/config";
import { client } from "./bot/index";
import { app } from "./web/server";

const WEB_PORT = process.env.WEB_PORT || 3000;

app.listen(WEB_PORT, () => {
  console.log(`🌐 Webサーバー起動: http://localhost:${WEB_PORT}`);
});

const token = process.env.DISCORD_TOKEN;
if (token) {
  client.login(token);
} else {
  console.warn("⚠️ DISCORD_TOKEN が設定されていないため、Botは起動しません。");
  console.log("Webサーバーのみ起動しています。");
}
