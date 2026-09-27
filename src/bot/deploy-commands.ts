import { REST, Routes } from "discord.js";
import { commands } from "./commands";
import "dotenv/config";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token || !clientId) {
  console.error("DISCORD_TOKEN と DISCORD_CLIENT_ID を .env に設定してください。");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

async function main() {
  try {
    console.log(`${commands.length}個のコマンドを登録中...`);

    await rest.put(Routes.applicationCommands(clientId!), {
      body: commands.map((c) => c.data.toJSON()),
    });

    console.log("コマンド登録完了！");
  } catch (error) {
    console.error("コマンド登録エラー:", error);
  }
}

main();
