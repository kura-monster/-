import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

export interface BotCommand {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  /** "admin" commands are hidden from non-admins by Discord and re-checked at runtime. */
  audience: "public" | "admin";
  execute(interaction: ChatInputCommandInteraction<"cached">): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction<"cached">): Promise<void>;
}

export function routeOf(interaction: ChatInputCommandInteraction<"cached"> | AutocompleteInteraction<"cached">): string {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  return group ? `${group} ${sub}` : sub;
}
