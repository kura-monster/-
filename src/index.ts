import { config } from "./config";
import { createBot } from "./bot/client";
import { attachDiscordEffects } from "./bot/effects";
import { findSchemaProblem } from "./lib/prisma";
import { startScheduler } from "./services/scheduler";
import { createWebApp } from "./web/server";

function startWeb(): Promise<void> {
  return new Promise((resolve, reject) => {
    // Express 5 passes listen errors (a port that is already taken, for example) to this callback.
    createWebApp().listen(config.webPort, (error) => (error ? reject(error) : resolve()));
  });
}

function explainListenError(error: unknown): void {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EADDRINUSE") {
    console.error(`[エラー] ポート ${config.webPort} は別のプログラムが使用中です。ホスティングが割り当てたポート番号を WEB_PORT に設定してください。`);
  } else if (code === "EACCES") {
    console.error(`[エラー] ポート ${config.webPort} を開く権限がありません。1024 以上のポート番号を WEB_PORT に設定してください。`);
  }
}

async function main(): Promise<void> {
  const schemaProblem = await findSchemaProblem();
  if (schemaProblem) {
    console.error(`[エラー] データベースが作成されていないか、古い構造のままです（${schemaProblem}）。`);
    console.error("[エラー] Bot を止めて `bunx prisma db push`（Node.js なら `npx prisma db push`）を実行してから、もう一度起動してください。");
    process.exit(1);
  }

  try {
    await startWeb();
  } catch (error) {
    explainListenError(error);
    throw error;
  }
  console.log(`[民主主義Bot] Webダッシュボード: ${config.webBaseUrl}（ポート ${config.webPort} で待ち受け中・${config.webPortFrom}）`);
  if (config.webPortOthers.length > 0) {
    console.warn(
      `[注意] ${config.webPortOthers.join("、")} も設定されていますが、${config.webPortFrom} のポート ${config.webPort} を使っています。サイトにつながらない場合は、ホスティングが割り当てたポートと一致しているか確認してください。`,
    );
  } else if (config.webPortFrom === "既定値" && config.webBaseUrl.startsWith("https://")) {
    console.warn("[注意] ポートが指定されていないため 3000 番を使っています。ホスティングで公開する場合は、割り当てられたポート番号を WEB_PORT に設定してください。");
  }

  if (!config.discordToken) {
    console.warn("[注意] DISCORD_TOKEN が未設定のため Bot は起動しません（Webとスケジューラのみ動作します）。");
    startScheduler();
    return;
  }

  const client = createBot(() => startScheduler());
  attachDiscordEffects(client);
  try {
    await client.login(config.discordToken);
  } catch (error) {
    if (String(error).toLowerCase().includes("intent")) {
      console.error("[エラー] Discord Developer Portal の Bot 設定で「SERVER MEMBERS INTENT」を有効にしてください。");
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
