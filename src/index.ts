import { routeWebSocketsThroughProxy } from "./lib/network";
import { regeneratePrismaClientIfStale } from "./lib/prisma-generate";

// Bun runs CommonJS packages such as discord.js before the code of the module that imports them, so whatever has to
// happen before those load (routing WebSockets through the host's proxy, bringing the generated Prisma client up to
// date) happens here, and the rest of the app is imported afterwards. This file therefore imports nothing else statically.
const webSocketProxy = routeWebSocketsThroughProxy();

const client = regeneratePrismaClientIfStale();
if (client.status === "regenerated") {
  console.log("[民主主義Bot] データベースの定義が更新されていたため、Prisma クライアントを作り直しました。");
} else if (client.status === "failed") {
  console.warn(`[注意] Prisma クライアントを作り直せませんでした。\`bunx prisma generate\`（Node.js なら \`npx prisma generate\`）を実行してください。\n${client.output}`);
}

import("./app")
  .then(({ start }) => start(webSocketProxy))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
