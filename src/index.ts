import { config } from "./config";
import { createBot } from "./bot/client";
import { attachDiscordEffects } from "./bot/effects";
import { startScheduler } from "./services/scheduler";
import { createWebApp } from "./web/server";

async function main(): Promise<void> {
  createWebApp().listen(config.webPort, () => {
    console.log(`🌐 Webダッシュボード: ${config.webBaseUrl}（ポート ${config.webPort}）`);
  });

  if (!config.discordToken) {
    console.warn("⚠️ DISCORD_TOKEN が未設定のため Bot は起動しません（Webとスケジューラのみ動作します）。");
    startScheduler();
    return;
  }

  const client = createBot(() => startScheduler());
  attachDiscordEffects(client);
  try {
    await client.login(config.discordToken);
  } catch (error) {
    if (String(error).toLowerCase().includes("intent")) {
      console.error("❌ Discord Developer Portal の Bot 設定で「SERVER MEMBERS INTENT」を有効にしてください。");
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
