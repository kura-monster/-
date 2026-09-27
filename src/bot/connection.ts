import { DiscordjsErrorCodes, Events, type Client } from "discord.js";
import { probeGateway } from "../lib/network";

interface WatchOptions {
  reportAfterMs?: number;
  repeatEveryMs?: number;
  report?: (lines: string[]) => unknown;
}

const KEEP_LINES = 30;

type Stage = "api" | "gateway" | "identify";

/** How far the recent connection log got: the Discord API, the gateway socket, or the login (IDENTIFY) itself. */
export function connectionStage(lines: string[]): Stage {
  if (lines.some((line) => /Identifying|Waiting for event ready/.test(line))) return "identify";
  if (lines.some((line) => /Fetched Gateway Information|Connecting to/.test(line))) return "gateway";
  return "api";
}

const STAGE_HINT: Record<Stage, string> = {
  api: "Discord の API（https://discord.com）から応答がありません。ホスティングから外部への通信が制限されていないか確認してください。",
  gateway:
    "Discord のゲートウェイ（wss://gateway.discord.gg）に接続できていません。ホスティングが外部への WebSocket 接続を許可しているか確認してください。",
  identify:
    "ログイン要求に Discord が応答していません。数分待ってから再起動し、続く場合は Developer Portal の Bot ページでトークンを再発行（Reset Token）して DISCORD_TOKEN を設定し直してください。",
};

async function defaultReport(lines: string[]): Promise<void> {
  const stage = connectionStage(lines);
  // Checked before printing so the report comes out in one piece.
  const network = stage === "api" || stage === "gateway" ? await probeGateway().catch((error) => [`（ネットワークの確認に失敗: ${String(error)}）`]) : [];
  console.error("[エラー] Discord への接続が完了していません（Bot はオフラインのままです）。直近の接続ログ:");
  for (const line of lines.slice(-12)) console.error(`  ${line}`);
  if (network.length > 0) {
    console.error("[エラー] このサーバーのネットワーク:");
    for (const line of network) console.error(`  ${line}`);
  }
  console.error(`[エラー] ${STAGE_HINT[stage]}`);
}

/**
 * discord.js keeps retrying a gateway connection that never completes without raising an error, so the bot would
 * just stay offline with nothing in the log. This keeps discord.js's recent connection log and prints it, with the
 * likely cause, when the bot is not online in time.
 */
export function watchConnection(client: Client, options: WatchOptions = {}): void {
  const { reportAfterMs = 45_000, repeatEveryMs = 10 * 60_000, report = defaultReport } = options;
  const recent: string[] = [];
  const onDebug = (message: string) => {
    if (message.startsWith("Provided token")) return;
    recent.push(`${new Date().toISOString().slice(11, 19)} ${message.replace(/\s*\n\s*/g, " / ")}`);
    if (recent.length > KEEP_LINES) recent.shift();
  };
  client.on(Events.Debug, onDebug);
  client.on(Events.Warn, (message) => console.warn(`[Discord] ${message}`));
  client.on(Events.Error, (error) => console.error("[Discord]", error));
  client.on(Events.ShardError, (error, shardId) => console.error(`[Discord] 接続エラー（シャード ${shardId}）: ${error.message}`));

  const first = setTimeout(() => void report([...recent]), reportAfterMs);
  const repeat = setInterval(() => void report([...recent]), repeatEveryMs);
  first.unref();
  repeat.unref();
  client.once(Events.ClientReady, () => {
    clearTimeout(first);
    clearInterval(repeat);
    client.off(Events.Debug, onDebug);
  });
}

/** Turns the errors that stop login for good into what to change. */
export function loginErrorHint(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if ((error as { code?: unknown })?.code === DiscordjsErrorCodes.TokenInvalid) {
    return "DISCORD_TOKEN が正しくありません。Developer Portal の Bot ページで「Reset Token」を押し、表示されたトークンを設定し直してください（Client Secret とは別のものです）。";
  }
  if (/disallowed intents/i.test(message)) {
    return "Discord Developer Portal の Bot 設定で「SERVER MEMBERS INTENT」を有効にしてください。";
  }
  if (/Not enough sessions remaining/i.test(message)) {
    return "Discord への1日のログイン回数の上限に達しています（再起動を繰り返したため）。表示されたリセット時刻を過ぎてから起動してください。";
  }
  return null;
}
