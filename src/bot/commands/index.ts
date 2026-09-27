import { adminCommand } from "./admin";
import { cabinetCommand } from "./cabinet";
import { citizenCommand } from "./citizen";
import { courtCommand } from "./court";
import { electionCommand } from "./election";
import { govCommand } from "./gov";
import { helpCommand } from "./help";
import { parliamentCommand } from "./parliament";
import { petitionCommand } from "./petition";
import type { BotCommand } from "./types";

/** Everyone sees these; position-specific subcommands are checked when used. */
export const PUBLIC_COMMANDS: BotCommand[] = [
  helpCommand,
  citizenCommand,
  govCommand,
  electionCommand,
  parliamentCommand,
  cabinetCommand,
  courtCommand,
  petitionCommand,
];

/** Only members with the Administrator permission see these. */
export const ADMIN_COMMANDS: BotCommand[] = [adminCommand];

export const COMMANDS: BotCommand[] = [...PUBLIC_COMMANDS, ...ADMIN_COMMANDS];
