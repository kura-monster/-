import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { config } from "../config";
import { TIME_TOKEN_PATTERN } from "../core/time";
import { truncate } from "../core/text";

export const COLOR = {
  primary: 0x5865f2,
  success: 0x2ecc71,
  danger: 0xe74c3c,
  warning: 0xf1c40f,
  neutral: 0x95a5a6,
  government: 0x1abc9c,
  election: 0x3498db,
  parliament: 0x9b59b6,
  cabinet: 0xe74c3c,
  court: 0x16a085,
  petition: 0x27ae60,
  admin: 0xf39c12,
} as const;

export const mention = (discordId: string) => `<@${discordId}>`;

export function discordTime(date: Date, style: "f" | "F" | "R" | "D" | "d" | "t" = "f"): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

export function withRelative(date: Date): string {
  return `${discordTime(date)}（${discordTime(date, "R")}）`;
}

/** Turns stored {{t:unix}} tokens into Discord timestamps shown in each reader's time zone. */
export function renderTokens(text: string): string {
  return text.replace(TIME_TOKEN_PATTERN, (_, unix: string) => `<t:${unix}:f>`);
}

/** Joins lines into a field value that stays under Discord's 1024-character limit. */
export function limitLines(lines: string[], empty = "なし", max = 1000): string {
  if (lines.length === 0) return empty;
  let text = "";
  let shown = 0;
  for (const line of lines) {
    const next = text ? `${text}\n${line}` : line;
    if (next.length > max - 16) break;
    text = next;
    shown++;
  }
  const rest = lines.length - shown;
  return rest > 0 ? `${text}\n…ほか${rest}件` : text;
}

/** Joins names on one line but stops before Discord's field limit. */
export function joinNames(names: string[], empty = "空席", max = 900): string {
  if (names.length === 0) return empty;
  let text = "";
  let shown = 0;
  for (const name of names) {
    const next = text ? `${text}、${name}` : name;
    if (next.length > max) break;
    text = next;
    shown++;
  }
  return shown < names.length ? `${text} ほか${names.length - shown}名` : text;
}

export function embed(color: number, title: string): EmbedBuilder {
  return new EmbedBuilder().setColor(color).setTitle(truncate(title, 256)).setTimestamp();
}

export function field(name: string, value: string, inline = false) {
  return { name: truncate(name, 256), value: truncate(value || "—", 1024), inline };
}

export function webUrl(path: string): string {
  return `${config.webBaseUrl}${path}`;
}

export function linkRow(label: string, path: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(webUrl(path)),
  );
}

type Replyable = ChatInputCommandInteraction;

export const ERROR_PREFIX = "`エラー`";

export async function replyError(interaction: Replyable, message: string): Promise<void> {
  const payload = { content: `${ERROR_PREFIX} ${truncate(message, 1900)}`, flags: MessageFlags.Ephemeral } as const;
  if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

export async function replyEmbed(
  interaction: Replyable,
  body: EmbedBuilder,
  options: { ephemeral?: boolean; components?: ActionRowBuilder<ButtonBuilder>[] } = {},
): Promise<void> {
  const payload = {
    embeds: [body],
    components: options.components ?? [],
    ...(options.ephemeral ? { flags: MessageFlags.Ephemeral as const } : {}),
  };
  if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds: payload.embeds, components: payload.components });
  else await interaction.reply(payload);
}
