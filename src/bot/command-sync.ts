import { DiscordAPIError, Events, RESTJSONErrorCodes, Routes, type Client, type Guild, type REST } from "discord.js";
import { COMMANDS } from "./commands";

/** How often every server gets the commands again. They are also registered on startup and when the bot joins a server. */
export const COMMAND_SYNC_INTERVAL_MS = 3 * 60 * 60 * 1000;

type Rest = Pick<REST, "get" | "put">;

export interface GuildRef {
  id: string;
  name: string;
}

function reasonOf(error: unknown): string {
  if (error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.MissingAccess) {
    return "Bot にコマンドを登録する権限がありません。起動ログの招待URL（applications.commands を含む）から招待し直してください";
  }
  return error instanceof Error ? error.message : String(error);
}

/** Registers the commands in one server. Unlike global commands, per-server ones show up right away. */
export async function registerGuildCommands(rest: Rest, applicationId: string, guildId: string): Promise<void> {
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: COMMANDS.map((command) => command.data.toJSON()) });
}

/** One server after another (the REST client waits out rate limits); a server that fails does not stop the rest. */
export async function registerInGuilds(rest: Rest, applicationId: string, guilds: GuildRef[]): Promise<{ registered: number; failures: string[] }> {
  let registered = 0;
  const failures: string[] = [];
  for (const guild of guilds) {
    try {
      await registerGuildCommands(rest, applicationId, guild.id);
      registered++;
    } catch (error) {
      failures.push(`サーバー「${guild.name}」（${guild.id}）: ${reasonOf(error)}`);
    }
  }
  return { registered, failures };
}

/** Commands registered for all servers at once would show up twice next to the per-server ones, so they are removed. */
export async function clearGlobalCommands(rest: Rest, applicationId: string): Promise<number> {
  const existing = (await rest.get(Routes.applicationCommands(applicationId))) as unknown[];
  if (existing.length > 0) await rest.put(Routes.applicationCommands(applicationId), { body: [] });
  return existing.length;
}

/** Registers the commands in every server now, in each server the bot joins, and in every server again every few hours. */
export function keepCommandsRegistered(client: Client<true>, intervalMs = COMMAND_SYNC_INTERVAL_MS): () => void {
  const applicationId = client.application.id;
  let running = false;
  const registerEverywhere = async (when: string) => {
    if (running) return;
    running = true;
    try {
      const guilds = [...client.guilds.cache.values()].map((guild) => ({ id: guild.id, name: guild.name ?? guild.id }));
      const { registered, failures } = await registerInGuilds(client.rest, applicationId, guilds);
      console.log(`[民主主義Bot] ${when}のコマンド登録: ${registered}/${guilds.length} サーバー`);
      for (const failure of failures) console.warn(`[注意] コマンドを登録できませんでした（${failure}）`);
    } finally {
      running = false;
    }
  };
  const onJoin = (guild: Guild) => {
    registerGuildCommands(client.rest, applicationId, guild.id)
      .then(() => console.log(`[民主主義Bot] サーバー「${guild.name}」に参加し、コマンドを登録しました。`))
      .catch((error) => console.warn(`[注意] コマンドを登録できませんでした（サーバー「${guild.name}」（${guild.id}）: ${reasonOf(error)}）`));
  };

  client.on(Events.GuildCreate, onJoin);
  void (async () => {
    try {
      const cleared = await clearGlobalCommands(client.rest, applicationId);
      if (cleared > 0) console.log(`[民主主義Bot] 全体向けに登録されていたコマンド ${cleared} 件を削除しました（サーバーごとの登録と二重に表示されるため）。`);
    } catch (error) {
      console.warn(`[注意] 全体向けコマンドを確認できませんでした: ${reasonOf(error)}`);
    }
    await registerEverywhere("起動時");
  })();
  const timer = setInterval(() => void registerEverywhere("定期"), intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    client.off(Events.GuildCreate, onJoin);
  };
}
