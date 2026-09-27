import type { Guild } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { transact, type Db } from "../core/db";
import { fail } from "../core/errors";
import { publish } from "./gazette";
import type { Actor } from "./types";

export async function ensureGuild(id: string, name: string): Promise<Guild> {
  const existing = await prisma.guild.findUnique({ where: { id } });
  if (existing && existing.name === name) return existing;
  return prisma.guild.upsert({ where: { id }, update: { name }, create: { id, name } });
}

export async function getGuild(db: Db, id: string): Promise<Guild> {
  const guild = await db.guild.findUnique({ where: { id } });
  if (!guild) fail("このサーバーはまだ登録されていません。");
  return guild;
}

type NumberSetting = { label: string; unit: string; min: number; max: number };
type BooleanSetting = { label: string; boolean: true };

export const SETTING_FIELDS = {
  seats: { label: "議員定数", unit: "名", min: 1, max: 50 },
  termDays: { label: "議員任期", unit: "日", min: 1, max: 365 },
  registrationDays: { label: "立候補受付期間", unit: "日", min: 1, max: 14 },
  votingDays: { label: "投票期間", unit: "日", min: 1, max: 14 },
  billVotingDays: { label: "法案の採決期間", unit: "日", min: 1, max: 14 },
  sanctionDays: { label: "裁可期限", unit: "日", min: 1, max: 14 },
  petitionThreshold: { label: "請願の必要署名数", unit: "筆", min: 1, max: 1000 },
  petitionDays: { label: "請願の署名期間", unit: "日", min: 1, max: 60 },
  appealHours: { label: "上告期間", unit: "時間", min: 1, max: 168 },
  minAccountAgeDays: { label: "市民登録に必要なアカウント年齢", unit: "日", min: 0, max: 365 },
  minMembershipDays: { label: "市民登録に必要なサーバー在籍期間", unit: "日", min: 0, max: 365 },
  allowAdminParticipation: { label: "管理者の国民代表派閥への参加", boolean: true },
  enforcePenalties: { label: "判決（タイムアウト）の自動執行", boolean: true },
  autoElection: { label: "任期満了前の総選挙の自動告示", boolean: true },
} satisfies Record<string, NumberSetting | BooleanSetting>;

export type SettingKey = keyof typeof SETTING_FIELDS;
export type SettingsInput = { [K in SettingKey]?: Guild[K] };

export function settingField(key: SettingKey): NumberSetting | BooleanSetting {
  return SETTING_FIELDS[key];
}

export function formatSetting(key: SettingKey, value: number | boolean): string {
  const field = settingField(key);
  if ("boolean" in field) return value ? "有効" : "無効";
  return `${value}${field.unit}`;
}

export async function updateSettings(actor: Actor, input: SettingsInput) {
  if (!actor.isAdmin) fail("制度の変更は管理者のみ行えます。");
  return transact(async (tx, events) => {
    const guild = await getGuild(tx, actor.guildId);
    const data: Record<string, number | boolean> = {};
    const changes: string[] = [];
    for (const key of Object.keys(SETTING_FIELDS) as SettingKey[]) {
      const value = input[key];
      if (value === undefined || value === null) continue;
      const field = settingField(key);
      if (!("boolean" in field) && (typeof value !== "number" || !Number.isInteger(value) || value < field.min || value > field.max)) {
        fail(`${field.label}は ${field.min}〜${field.max} の整数で指定してください。`);
      }
      if (guild[key] === value) continue;
      data[key] = value;
      changes.push(`${field.label}: ${formatSetting(key, guild[key])} → ${formatSetting(key, value)}`);
    }
    if (changes.length === 0) return { guild, changes };
    const updated = await tx.guild.update({ where: { id: guild.id }, data });
    await publish(tx, events, guild.id, {
      category: "ADMIN",
      title: "制度の改正",
      body: `管理者 ${actor.displayName} が国の制度を改正しました。\n${changes.map((c) => `・${c}`).join("\n")}`,
    });
    return { guild: updated, changes };
  });
}

export interface ChannelSettings {
  announceChannelId?: string;
  debateChannelId?: string;
  courtChannelId?: string;
  electionChannelId?: string;
}

export async function updateChannels(actor: Actor, channels: ChannelSettings): Promise<Guild> {
  if (!actor.isAdmin) fail("チャンネル設定は管理者のみ行えます。");
  const data = Object.fromEntries(Object.entries(channels).filter(([, v]) => v !== undefined));
  return prisma.guild.update({ where: { id: actor.guildId }, data });
}
