export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Roles and offices are written as {`裁判官`}. Discord renders the inside as inline code and the web
 * dashboard does the same; a backtick inside a custom title would break the code span, so it is replaced.
 */
export function roleTag(label: string): string {
  return `{\`${label.replace(/`/g, "'")}\`}`;
}

export function cleanText(text: string | null | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}
