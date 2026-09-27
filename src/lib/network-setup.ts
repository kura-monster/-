import { routeWebSocketsThroughProxy } from "./network";

// Imported first by the entry point, so it runs before anything loads discord.js (see routeWebSocketsThroughProxy).
export const webSocketProxy = routeWebSocketsThroughProxy();
