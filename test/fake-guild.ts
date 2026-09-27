import { Client, ClientUser, GatewayIntentBits, PermissionFlagsBits, PermissionsBitField, type Guild } from "discord.js";

export const BOT = "1553617566004412517";
export const OWNER = "900000000000000010";
const P = PermissionFlagsBits;
const bits = (...flags: bigint[]) => PermissionsBitField.resolve(flags).toString();

export interface FakeRole {
  id: string;
  name: string;
}

export interface FakeMember {
  id: string;
  name: string;
  roles?: string[];
  bot?: boolean;
  joinedAt?: Date;
}

/** A Discord user id whose embedded timestamp (the account's creation time) is `createdAt`. */
export function userIdCreatedAt(createdAt: Date, sequence: number): string {
  return String(((BigInt(createdAt.getTime()) - 1420070400000n) << 22n) + BigInt(sequence));
}

export interface Call {
  method: string;
  route: string;
  body?: Record<string, unknown>;
}

/**
 * A real discord.js Guild whose REST calls are answered here instead of by Discord, so the test sees exactly what
 * the auto setup would send (channel types, parents, permission overwrites as bitfields, messages).
 */
export function fakeDiscord(guildId: string, botPermissions: bigint[], extra: { roles?: FakeRole[]; members?: FakeMember[] } = {}) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  const User = ClientUser as unknown as new (client: Client, data: object) => ClientUser;
  client.user = new User(client, { id: BOT, username: "民主主義BOT", discriminator: "2514", bot: true, avatar: null });
  const now = new Date().toISOString();
  const users: Record<string, object> = {
    [BOT]: { id: BOT, username: "民主主義BOT", discriminator: "2514", bot: true, avatar: null },
    [OWNER]: { id: OWNER, username: "owner", discriminator: "0", global_name: "オーナー", avatar: null },
  };
  const joinedAt: Record<string, string> = {};
  for (const m of extra.members ?? []) {
    users[m.id] = { id: m.id, username: m.name, discriminator: "0", global_name: m.name, avatar: null, bot: m.bot ?? false };
    joinedAt[m.id] = (m.joinedAt ?? new Date("2020-01-01T00:00:00Z")).toISOString();
  }
  const member = (id: string, roles: string[]) => ({ user: users[id], roles, joined_at: joinedAt[id] ?? now, deaf: false, mute: false, flags: 0 });
  const roles: Record<string, unknown>[] = [
    { id: guildId, name: "@everyone", permissions: bits(P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.SendMessagesInThreads), position: 0, color: 0, hoist: false, managed: false, mentionable: false, flags: 0 },
    { id: "900000000000000002", name: "民主主義BOT", permissions: bits(...botPermissions), position: 50, color: 0, hoist: false, managed: true, mentionable: false, flags: 0, tags: { bot_id: BOT } },
    ...(extra.roles ?? []).map((r, i) => ({ id: r.id, name: r.name, permissions: "0", position: 20 + i, color: 0, hoist: false, managed: false, mentionable: false, flags: 0 })),
  ];
  const guild = (client.guilds as unknown as { _add(data: object): Guild })._add({
    id: guildId,
    name: "オート国",
    owner_id: OWNER,
    unavailable: false,
    member_count: 2,
    roles,
    channels: [{ id: "900000000000000020", type: 0, name: "雑談", guild_id: guildId, position: 0, permission_overwrites: [] }],
    members: [member(BOT, ["900000000000000002"]), member(OWNER, []), ...(extra.members ?? []).map((m) => member(m.id, m.roles ?? []))],
    emojis: [],
    stickers: [],
    features: [],
  });

  // Asking for every member goes over the gateway, which this client never opened.
  const fetchMembers = guild.members.fetch.bind(guild.members);
  guild.members.fetch = ((options?: unknown) => (options === undefined ? Promise.resolve(guild.members.cache) : fetchMembers(options as never))) as never;

  let next = 900000000000001000n;
  const calls: Call[] = [];
  const answer = (method: string, route: string, body?: Record<string, unknown>): unknown => {
    calls.push({ method, route, body });
    const id = String(next++);
    if (method === "GET" && route === `/guilds/${guildId}/roles`) return roles;
    if (method === "POST" && route === `/guilds/${guildId}/roles`) {
      const role = { id, name: body?.name, permissions: String(body?.permissions ?? "0"), position: roles.length, color: 0, hoist: Boolean(body?.hoist), managed: false, mentionable: false, flags: 0 };
      roles.push(role);
      return role;
    }
    if (method === "POST" && route === `/guilds/${guildId}/channels`) {
      return { id, guild_id: guildId, type: body?.type, name: body?.name, topic: body?.topic ?? null, parent_id: body?.parent_id ?? null, position: 1, permission_overwrites: body?.permission_overwrites ?? [] };
    }
    const memberRoute = route.match(new RegExp(`^/guilds/${guildId}/members/(\\d+)$`));
    if (method === "PATCH" && memberRoute) return member(memberRoute[1], (body?.roles as string[]) ?? []);
    const messageRoute = route.match(/^\/channels\/(\d+)\/messages$/);
    if (method === "POST" && messageRoute) {
      return { id, channel_id: messageRoute[1], author: users[BOT], content: "", embeds: body?.embeds ?? [], components: [], attachments: [], mentions: [], mention_roles: [], pinned: false, tts: false, type: 0, timestamp: now };
    }
    throw new Error(`unexpected Discord call: ${method} ${route}`);
  };
  // Serialized both ways like the real REST client does (bitfields become strings through toJSON).
  const json = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  for (const method of ["get", "post", "put", "patch", "delete"] as const) {
    (client.rest as unknown as Record<string, unknown>)[method] = async (route: string, options: { body?: Record<string, unknown> } = {}) =>
      json(answer(method.toUpperCase(), route, json(options.body)));
  }
  return { client, guild, calls };
}
