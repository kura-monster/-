import { routeWebSocketsThroughProxy } from "./lib/network";

// Bun runs CommonJS packages such as discord.js before the code of the module that imports them, so WebSockets have
// to be routed through the host's proxy before the rest of the app is even imported (see routeWebSocketsThroughProxy).
// This file therefore imports nothing else statically.
const webSocketProxy = routeWebSocketsThroughProxy();

import("./app")
  .then(({ start }) => start(webSocketProxy))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
