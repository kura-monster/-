import {
  Client,
  GatewayIntentBits,
  Events,
  ChatInputCommandInteraction,
  Interaction,
} from "discord.js";
import { commands } from "./commands";
import { ensureGuild } from "./services/citizen";
import { expirePositions } from "./services/government";
import "dotenv/config";

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error("DISCORD_TOKEN を .env に設定してください。");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ],
});

const commandMap = new Map(commands.map((c) => [c.data.name, c]));

client.once(Events.ClientReady, (readyClient) => {
  console.log(`🏛️ 民主主義Bot起動完了: ${readyClient.user.tag}`);
  console.log(`${readyClient.guilds.cache.size}個のサーバーに接続中`);

  // 期限切れ役職を定期チェック（1時間ごと）
  setInterval(() => expirePositions(), 3600000);
  expirePositions();
});

client.on(Events.GuildCreate, async (guild) => {
  await ensureGuild(guild);
  console.log(`新しいサーバーに参加: ${guild.name}`);
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commandMap.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction as ChatInputCommandInteraction);
  } catch (error) {
    console.error(`コマンドエラー [${interaction.commandName}]:`, error);
    const content = "コマンドの実行中にエラーが発生しました。";
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content, ephemeral: true });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  }
});

export { client };

if (require.main === module) {
  client.login(token);
}
