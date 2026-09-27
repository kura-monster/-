import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
const port = process.env.FAKE_PORT ?? "18555";
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
  rest: { api: `http://127.0.0.1:${port}/api` },
});
const started = Date.now();
client.on(Events.Debug, (m) => console.log("[debug]", m.replace(/\n/g, " | ").slice(0, 150)));
client.once(Events.ClientReady, (c) => {
  console.log(`READY as ${c.user.tag} with ${c.guilds.cache.size} guild(s) after ${Date.now() - started}ms`);
  void client.destroy().then(() => process.exit(0));
});
client.login("MTQ4NjkyMzg3MzAwNDk0NTUwOQ.fakefa.ke-token-for-local-probe").catch((e) => {
  console.log("login rejected:", e.message);
  process.exit(1);
});
setTimeout(() => {
  console.log("TIMEOUT: no READY");
  process.exit(2);
}, Number(process.env.PROBE_MS ?? 20_000));
