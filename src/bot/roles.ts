import { DiscordAPIError, PermissionFlagsBits, type Guild, type Role } from "discord.js";
import { prisma } from "../lib/prisma";
import { POSITION_KEYS, POSITIONS, type PositionKey } from "../core/positions";

export type ManagedKey = PositionKey | "CITIZEN";
export const MANAGED_KEYS: ManagedKey[] = [...POSITION_KEYS, "CITIZEN"];

const P = PermissionFlagsBits;

/** Default permissions for newly created roles. Admins may edit roles afterwards; the bot never overwrites them. */
const ROLE_PERMISSIONS: Partial<Record<ManagedKey, bigint[]>> = {
  PRIME_MINISTER: [P.MentionEveryone, P.ManageEvents, P.PrioritySpeaker],
  SPEAKER: [P.ManageThreads, P.ManageEvents, P.PrioritySpeaker],
  VICE_SPEAKER: [P.ManageThreads],
  DEPUTY_PRIME_MINISTER: [P.ManageEvents, P.PrioritySpeaker],
  CHIEF_CABINET_SECRETARY: [P.ManageEvents, P.PrioritySpeaker],
  MINISTER: [P.ManageEvents],
  REPRESENTATIVE: [P.ManageEvents, P.PrioritySpeaker],
  CHIEF_JUSTICE: [P.ManageThreads],
  JUDGE: [P.ManageThreads],
};

const HOISTED: ManagedKey[] = ["SOVEREIGN", "PRIME_MINISTER", "SPEAKER", "CHIEF_JUSTICE", "REPRESENTATIVE"];

/** Discord role names cannot use markdown, so roles are named {裁判官}. */
export function roleName(label: string): string {
  return `{${label}}`;
}

export function roleSpec(key: ManagedKey) {
  if (key === "CITIZEN") return { name: roleName("市民"), color: null, hoist: false, permissions: [] as bigint[] };
  const def = POSITIONS[key];
  return { name: roleName(def.label), color: def.color, hoist: HOISTED.includes(key), permissions: ROLE_PERMISSIONS[key] ?? [] };
}

export function describeDiscordError(error: unknown): string {
  if (error instanceof DiscordAPIError) {
    if (error.code === 50013) return "Botの権限が不足しています";
    if (error.code === 50001) return "Botがアクセスできません";
    return `${error.message}（${error.code}）`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function createRole(guild: Guild, key: ManagedKey): Promise<Role> {
  const spec = roleSpec(key);
  const base = {
    name: spec.name,
    hoist: spec.hoist,
    mentionable: false,
    reason: "民主主義Bot: 役職ロールの作成",
    ...(spec.color ? { colors: { primaryColor: spec.color } } : {}),
  };
  try {
    return await guild.roles.create({ ...base, permissions: spec.permissions });
  } catch (error) {
    // A bot can only grant permissions it holds; keep the role usable without the extras.
    if (spec.permissions.length === 0) throw error;
    return guild.roles.create({ ...base, permissions: [] });
  }
}

/** Creates any managed role that is missing (never created, or deleted by hand). Creation order puts 元首 on top. */
export async function ensureManagedRoles(guild: Guild) {
  const records = await prisma.managedRole.findMany({ where: { guildId: guild.id } });
  const roleIdOf = new Map(records.map((r) => [r.key, r.roleId]));
  await guild.roles.fetch();
  const created: string[] = [];
  const failed: string[] = [];
  let existing = 0;
  for (const key of MANAGED_KEYS) {
    const roleId = roleIdOf.get(key);
    if (roleId && guild.roles.cache.has(roleId)) {
      existing++;
      continue;
    }
    try {
      const role = await createRole(guild, key);
      await prisma.managedRole.upsert({
        where: { guildId_key: { guildId: guild.id, key } },
        create: { guildId: guild.id, key, roleId: role.id },
        update: { roleId: role.id },
      });
      created.push(role.name);
    } catch (error) {
      failed.push(`${roleSpec(key).name}: ${describeDiscordError(error)}`);
    }
  }
  return { created, failed, existing };
}

/** Makes a member's managed roles match their citizenship and current offices. */
export async function syncMember(guild: Guild, discordId: string): Promise<void> {
  const managed = await prisma.managedRole.findMany({ where: { guildId: guild.id } });
  if (managed.length === 0) return;
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return;
  const citizen = await prisma.citizen.findUnique({ where: { guildId_discordId: { guildId: guild.id, discordId } } });
  const positions = citizen
    ? await prisma.position.findMany({ where: { citizenId: citizen.id, endedAt: null }, select: { key: true } })
    : [];
  const wanted = new Set<string>(positions.map((p) => p.key));
  if (citizen?.active) wanted.add("CITIZEN");

  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const role of managed) {
    if (!guild.roles.cache.has(role.roleId)) continue;
    const has = member.roles.cache.has(role.roleId);
    if (wanted.has(role.key) && !has) toAdd.push(role.roleId);
    if (!wanted.has(role.key) && has) toRemove.push(role.roleId);
  }
  if (toAdd.length > 0) await member.roles.add(toAdd, "民主主義Bot: 役職の反映");
  if (toRemove.length > 0) await member.roles.remove(toRemove, "民主主義Bot: 役職の反映");
}

export async function syncAllMembers(guild: Guild) {
  const managed = await prisma.managedRole.findMany({ where: { guildId: guild.id } });
  const managedIds = new Set(managed.map((r) => r.roleId));
  const members = await guild.members.fetch();
  const citizens = await prisma.citizen.findMany({ where: { guildId: guild.id }, select: { discordId: true } });
  const targets = new Set(citizens.map((c) => c.discordId));
  for (const member of members.values()) {
    if (member.roles.cache.some((role) => managedIds.has(role.id))) targets.add(member.id);
  }
  let synced = 0;
  const errors: string[] = [];
  for (const discordId of targets) {
    if (!members.has(discordId)) continue;
    try {
      await syncMember(guild, discordId);
      synced++;
    } catch (error) {
      if (errors.length < 5) errors.push(`${members.get(discordId)?.displayName ?? discordId}: ${describeDiscordError(error)}`);
    }
  }
  return { synced, errors };
}
