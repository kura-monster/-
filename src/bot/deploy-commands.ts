import { REST, Routes } from "discord.js";
import { config } from "../config";
import { clearGlobalCommands, registerInGuilds, type GuildRef } from "./command-sync";
import { ADMIN_COMMANDS, PUBLIC_COMMANDS } from "./commands";

// The bot registers its commands by itself (on startup, when it joins a server, and every few hours).
// This script does the same without starting the bot.

async function joinedGuilds(rest: REST): Promise<GuildRef[]> {
  const guilds: GuildRef[] = [];
  for (let after = ""; ; ) {
    const query = new URLSearchParams({ limit: "200", ...(after ? { after } : {}) });
    const page = (await rest.get(Routes.userGuilds(), { query })) as GuildRef[];
    guilds.push(...page.map(({ id, name }) => ({ id, name })));
    if (page.length < 200) return guilds;
    after = page[page.length - 1].id;
  }
}

async function main(): Promise<void> {
  if (!config.discordToken) {
    console.error("DISCORD_TOKEN を設定してください。");
    process.exit(1);
  }
  const rest = new REST({ version: "10" }).setToken(config.discordToken);
  const application = (await rest.get(Routes.currentApplication())) as { id: string };
  const guilds = config.devGuildId ? [{ id: config.devGuildId, name: config.devGuildId }] : await joinedGuilds(rest);

  const cleared = await clearGlobalCommands(rest, application.id);
  if (cleared > 0) console.log(`[民主主義Bot] 全体向けに登録されていたコマンド ${cleared} 件を削除しました。`);
  const { registered, failures } = await registerInGuilds(rest, application.id, guilds);
  console.log(`[民主主義Bot] ${registered}/${guilds.length} サーバーにコマンドを登録しました。`);
  for (const failure of failures) console.warn(`[注意] コマンドを登録できませんでした（${failure}）`);
  console.log(`   みんなのコマンド: ${PUBLIC_COMMANDS.map((c) => `/${c.data.name}`).join(" ")}`);
  console.log(`   管理者専用コマンド: ${ADMIN_COMMANDS.map((c) => `/${c.data.name}`).join(" ")}（管理者にのみ表示）`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("コマンド登録エラー:", error);
  process.exit(1);
});
