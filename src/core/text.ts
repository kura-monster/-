export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function cleanText(text: string | null | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}
