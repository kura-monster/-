import {
  ApplicationCommandOptionType,
  CommandInteractionOptionResolver,
  EmbedBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  type APIApplicationCommandOption,
  type Interaction,
} from "discord.js";
import { handleInteraction } from "../src/bot/client";
import { COMMANDS } from "../src/bot/commands";
import { GUILD, discordIdOf } from "./helpers";

/**
 * Drives the real command handlers with interactions built from the real command definitions,
 * so a handler reading an option that the definition does not declare fails the test.
 */

const AVATAR = "https://cdn.discordapp.com/embed/avatars/0.png";

export interface FakePerson {
  name: string;
  admin?: boolean;
}

function fakeUser(person: FakePerson) {
  return {
    id: discordIdOf(person.name),
    username: person.name,
    globalName: person.name,
    bot: false,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    displayAvatarURL: () => AVATAR,
    toString: () => `<@${discordIdOf(person.name)}>`,
  };
}

function fakeMember(person: FakePerson) {
  const user = fakeUser(person);
  return {
    id: user.id,
    user,
    displayName: person.name,
    joinedAt: new Date("2020-01-01T00:00:00Z"),
    permissions: new PermissionsBitField(person.admin ? PermissionFlagsBits.Administrator : 0n),
    displayAvatarURL: () => AVATAR,
  };
}

type Value = string | number | boolean | FakePerson;

function optionDefinitions(commandName: string, route: string): { defs: APIApplicationCommandOption[]; wrap: (o: unknown[]) => unknown[] } {
  const command = COMMANDS.find((c) => c.data.name === commandName);
  if (!command) throw new Error(`unknown command /${commandName}`);
  const json = command.data.toJSON();
  const parts = route ? route.split(" ") : [];
  if (parts.length === 0) return { defs: (json.options ?? []) as APIApplicationCommandOption[], wrap: (o) => o };
  if (parts.length === 1) {
    const sub = json.options?.find((o) => o.name === parts[0] && o.type === ApplicationCommandOptionType.Subcommand);
    if (!sub || sub.type !== ApplicationCommandOptionType.Subcommand) throw new Error(`unknown subcommand /${commandName} ${route}`);
    return { defs: sub.options ?? [], wrap: (o) => [{ name: parts[0], type: ApplicationCommandOptionType.Subcommand, options: o }] };
  }
  const group = json.options?.find((o) => o.name === parts[0] && o.type === ApplicationCommandOptionType.SubcommandGroup);
  if (!group || group.type !== ApplicationCommandOptionType.SubcommandGroup) throw new Error(`unknown group /${commandName} ${parts[0]}`);
  const sub = group.options?.find((o) => o.name === parts[1]);
  if (!sub) throw new Error(`unknown subcommand /${commandName} ${route}`);
  return {
    defs: sub.options ?? [],
    wrap: (o) => [
      { name: parts[0], type: ApplicationCommandOptionType.SubcommandGroup, options: [{ name: parts[1], type: ApplicationCommandOptionType.Subcommand, options: o }] },
    ],
  };
}

function buildOptions(commandName: string, route: string, values: Record<string, Value>, focused?: string) {
  const { defs, wrap } = optionDefinitions(commandName, route);
  const options: Record<string, unknown>[] = [];
  for (const [name, value] of Object.entries(values)) {
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`/${commandName} ${route} has no option "${name}"`);
    if ("choices" in def && def.choices && !def.choices.some((c) => c.value === value)) {
      throw new Error(`/${commandName} ${route} option "${name}" does not accept ${String(value)}`);
    }
    if (def.type === ApplicationCommandOptionType.User) {
      const person = value as FakePerson;
      options.push({ name, type: def.type, value: discordIdOf(person.name), user: fakeUser(person), member: fakeMember(person) });
    } else {
      options.push({ name, type: def.type, value, ...(name === focused ? { focused: true } : {}) });
    }
  }
  if (!focused) {
    for (const def of defs) {
      if ("required" in def && def.required && !(def.name in values)) throw new Error(`/${commandName} ${route} requires "${def.name}"`);
    }
  }
  return wrap(options);
}

export interface Reply {
  text: string;
  ephemeral: boolean;
  error: boolean;
}

function flatten(payload: unknown): Reply {
  const p = (typeof payload === "string" ? { content: payload } : payload) as {
    content?: string;
    embeds?: (EmbedBuilder | { toJSON(): unknown })[];
    flags?: number;
  };
  const parts: string[] = [];
  if (p.content) parts.push(p.content);
  for (const e of p.embeds ?? []) {
    const data = (e instanceof EmbedBuilder ? e.toJSON() : e.toJSON()) as {
      title?: string;
      description?: string;
      fields?: { name: string; value: string }[];
      footer?: { text: string };
    };
    parts.push(data.title ?? "", data.description ?? "", ...(data.fields ?? []).flatMap((f) => [f.name, f.value]), data.footer?.text ?? "");
  }
  return { text: parts.join("\n"), ephemeral: Boolean((p.flags ?? 0) & 64), error: (p.content ?? "").startsWith("❌") };
}

export async function run(person: FakePerson, commandName: string, route: string, values: Record<string, Value> = {}): Promise<Reply> {
  const replies: Reply[] = [];
  const member = fakeMember(person);
  const interaction = {
    commandName,
    guildId: GUILD,
    guild: { id: GUILD, name: "テスト国" },
    user: member.user,
    member,
    memberPermissions: member.permissions,
    options: new (CommandInteractionOptionResolver as unknown as new (...args: unknown[]) => unknown)({}, buildOptions(commandName, route, values), {}),
    replied: false,
    deferred: false,
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    inCachedGuild: () => true,
    async reply(payload: unknown) {
      this.replied = true;
      replies.push(flatten(payload));
    },
    async deferReply() {
      this.deferred = true;
    },
    async editReply(payload: unknown) {
      replies.push(flatten(payload));
    },
    async followUp(payload: unknown) {
      replies.push(flatten(payload));
    },
  };
  await handleInteraction(interaction as unknown as Interaction);
  if (replies.length !== 1) throw new Error(`/${commandName} ${route}: expected exactly one reply, got ${replies.length}`);
  return replies[0];
}

export async function autocomplete(person: FakePerson, commandName: string, route: string, focused: string, typed: string | number, values: Record<string, Value> = {}) {
  let choices: { name: string; value: string | number }[] | undefined;
  const member = fakeMember(person);
  const interaction = {
    commandName,
    guildId: GUILD,
    user: member.user,
    member,
    options: new (CommandInteractionOptionResolver as unknown as new (...args: unknown[]) => unknown)({}, buildOptions(commandName, route, { ...values, [focused]: typed }, focused), {}),
    responded: false,
    isAutocomplete: () => true,
    inCachedGuild: () => true,
    async respond(list: { name: string; value: string | number }[]) {
      this.responded = true;
      choices = list;
    },
  };
  await handleInteraction(interaction as unknown as Interaction);
  if (!choices) throw new Error(`/${commandName} ${route}: autocomplete did not respond`);
  return choices;
}
