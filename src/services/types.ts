/** Who is acting. `isAdmin` comes from Discord's Administrator permission, never from stored data. */
export interface Actor {
  guildId: string;
  discordId: string;
  displayName: string;
  isAdmin: boolean;
}

export interface Identity {
  discordId: string;
  displayName: string;
  avatarUrl: string | null;
}
