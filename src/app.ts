import fs from "node:fs";
import { config } from "./config";
import { createBot } from "./bot/client";
import { loginErrorHint, watchConnection } from "./bot/connection";
import { attachDiscordEffects } from "./bot/effects";
import { describeProxy } from "./lib/network";
import { databaseFile, findSchemaProblem, pushSchema } from "./lib/prisma";
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

/** Creates the database on first start and applies schema changes that keep the data. */
async function prepareDatabase(): Promise<boolean> {
  const file = databaseFile();
  const isNew = file !== null && !fs.existsSync(file);
  const push = pushSchema();
  if (!push.ok) {
    console.warn(`[注意] データベースの構造を自動で更新できませんでした。\n${push.output.split("\n").slice(-15).join("\n")}`);
  }
  const problem = await findSchemaProblem();
  if (problem) {
    console.error(`[エラー] データベースの構造が最新ではありません（${problem}）。`);
    console.error(
      `[エラー] データが消える変更は自動で行いません。上のメッセージを確認し、データベース（${file ?? "DATABASE_URL の接続先"}）をバックアップしてから \`bunx prisma db push\`（Node.js なら \`npx prisma db push\`）を実行してください。`,
    );
    return false;
  }
  console.log(`[民主主義Bot] データベース: ${file ?? "SQLite 以外（DATABASE_URL）"}${isNew && push.ok ? "（新しく作成しました）" : ""}`);
  return true;
}

/** Starts everything. `webSocketProxy` is the proxy src/index.ts routed WebSockets through before this was loaded. */
export async function start(webSocketProxy: string | null): Promise<void> {
  // A background task that fails without anyone waiting for it is logged instead of stopping the whole bot.
  process.on("unhandledRejection", (reason) => console.error("[エラー] 処理されなかったエラー:", reason));
  if (!(await prepareDatabase())) process.exit(1);

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
  watchConnection(client);
  console.log(`[民主主義Bot] Discord に接続しています…${webSocketProxy ? `（プロキシ ${describeProxy(webSocketProxy)} 経由）` : ""}`);
  try {
    await client.login(config.discordToken);
  } catch (error) {
    const hint = loginErrorHint(error);
    if (hint) console.error(`[エラー] ${hint}`);
    throw error;
  }
}
