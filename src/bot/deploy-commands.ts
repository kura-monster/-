import { REST, Routes } from "discord.js";
import { config } from "../config";
import { ADMIN_COMMANDS, COMMANDS, PUBLIC_COMMANDS } from "./commands";

async function main(): Promise<void> {
  if (!config.discordToken || !config.clientId) {
    console.error("DISCORD_TOKEN と DISCORD_CLIENT_ID を .env に設定してください。");
    process.exit(1);
  }
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const body = COMMANDS.map((command) => command.data.toJSON());
  const route = config.devGuildId
    ? Routes.applicationGuildCommands(config.clientId, config.devGuildId)
    : Routes.applicationCommands(config.clientId);

  await rest.put(route, { body });
  console.log(`[民主主義Bot] ${config.devGuildId ? `サーバー ${config.devGuildId}` : "全サーバー"}にコマンドを登録しました。`);
  console.log(`   みんなのコマンド: ${PUBLIC_COMMANDS.map((c) => `/${c.data.name}`).join(" ")}`);
  console.log(`   管理者専用コマンド: ${ADMIN_COMMANDS.map((c) => `/${c.data.name}`).join(" ")}（管理者にのみ表示）`);
}

main().catch((error) => {
  console.error("コマンド登録エラー:", error);
  process.exit(1);
});
