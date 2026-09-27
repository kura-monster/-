import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

type Env = Record<string, string | undefined>;

export const GATEWAY_HOST = "gateway.discord.gg";

/** The proxy an https:// request to this host goes through (HTTPS_PROXY / HTTP_PROXY), honouring NO_PROXY. */
export function proxyFor(hostname: string, env: Env = process.env): string | null {
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!proxy) return null;
  const host = hostname.toLowerCase();
  for (const raw of (env.NO_PROXY ?? env.no_proxy ?? "").split(/[\s,]+/).filter(Boolean)) {
    const entry = raw.toLowerCase().replace(/:\d+$/, "").replace(/^\*?\./, "");
    if (entry === "*" || host === entry || host.endsWith(`.${entry}`)) return null;
  }
  return proxy;
}

/** A proxy URL without its credentials, for the log. */
export function describeProxy(proxy: string): string {
  try {
    const url = new URL(proxy);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "（URLの形式ではありません）";
  }
}

/**
 * Bun's fetch goes through HTTPS_PROXY but its WebSocket connects directly. On a host that only lets traffic out
 * through that proxy, discord.js therefore reaches the API while its gateway connection hangs, and the bot stays
 * offline. Bun's WebSocket accepts a `proxy` option, so hand it the same proxy fetch uses.
 * Has to run before discord.js is loaded: @discordjs/ws takes globalThis.WebSocket when it is first imported.
 */
export function routeWebSocketsThroughProxy(env: Env = process.env): string | null {
  const proxy = proxyFor(GATEWAY_HOST, env);
  if (!process.versions.bun || typeof globalThis.WebSocket !== "function" || !proxy) return null;
  const NativeWebSocket = globalThis.WebSocket;
  type Init = ConstructorParameters<typeof NativeWebSocket>[1];
  class ProxiedWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: Init) {
      const through = proxyFor(new URL(url).hostname, env);
      const init = typeof protocols === "string" || Array.isArray(protocols) ? { protocols } : { ...protocols };
      // Bun's own constructor form: new WebSocket(url, { protocols, proxy }).
      super(url, (through ? { ...init, proxy: through } : protocols) as Init);
    }
  }
  globalThis.WebSocket = ProxiedWebSocket;
  return proxy;
}

function tryTls(address: string, servername: string, port: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tls.connect({ host: address, port, servername, timeout: timeoutMs });
    const done = (result: string) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("secureConnect", () => done(`接続できます（${Date.now() - started}ms）`));
    socket.once("timeout", () => done(`${timeoutMs / 1000}秒たっても応答がありません`));
    socket.once("error", (error: NodeJS.ErrnoException) => done(`接続できません（${error.code ?? error.message}）`));
  });
}

/** Asks the proxy for the same tunnel Bun's WebSocket does (CONNECT host:port), then opens TLS inside it. */
export function probeProxyTunnel(proxy: string, host: string, port: number, timeoutMs = 5000): Promise<string> {
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    return Promise.resolve("プロキシのURLを読み取れません");
  }
  if (url.protocol !== "http:") return Promise.resolve(`${url.protocol} のプロキシは確認できません`);
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host: url.hostname, port: Number(url.port) || 80, timeout: timeoutMs });
    let settled = false;
    const done = (result: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once("timeout", () => done(`${timeoutMs / 1000}秒たっても応答がありません`));
    socket.once("error", (error: NodeJS.ErrnoException) => done(`プロキシに接続できません（${error.code ?? error.message}）`));
    socket.once("connect", () => {
      const credentials = url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : "";
      const auth = credentials ? `Proxy-Authorization: Basic ${Buffer.from(credentials).toString("base64")}\r\n` : "";
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    });
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      const status = head.slice(0, head.indexOf("\r\n"));
      if (!/^HTTP\/1\.[01] 2\d\d/.test(status)) return done(`プロキシが拒否しました（${status}）`);
      const secure = tls.connect({ socket, servername: host });
      secure.once("secureConnect", () => done(`接続できます（${Date.now() - started}ms）`));
      secure.once("error", (error: NodeJS.ErrnoException) => done(`トンネル内の TLS に失敗しました（${error.code ?? error.message}）`));
    };
    socket.on("data", onData);
  });
}

/**
 * What this host's network does with the gateway: the proxy (and whether it opens a tunnel to the gateway),
 * DNS, and a direct TLS connection per IP version.
 */
export async function probeGateway(host = GATEWAY_HOST, port = 443, timeoutMs = 5000): Promise<string[]> {
  const proxy = proxyFor(host);
  const lines = [proxy ? `プロキシ: ${describeProxy(proxy)}（WebSocket もこのプロキシを経由）` : "プロキシ: 設定なし"];
  if (proxy) lines.push(`プロキシ経由（CONNECT ${host}:${port}）: ${await probeProxyTunnel(proxy, host, port, timeoutMs)}`);
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch (error) {
    lines.push(`DNS: ${host} を名前解決できません（${(error as NodeJS.ErrnoException).code ?? String(error)}）`);
    return lines;
  }
  lines.push(`DNS: ${host} → ${addresses.map((a) => a.address).join(", ")}`);
  for (const family of [4, 6] as const) {
    const first = addresses.find((a) => a.family === family);
    if (first) lines.push(`直接接続 IPv${family}（${first.address}）: ${await tryTls(first.address, host, port, timeoutMs)}`);
  }
  return lines;
}
