export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * HOUR);
}

/**
 * Timestamp token embedded in stored text (e.g. gazette bodies). Each renderer turns it into
 * a viewer-local time: Discord as <t:unix:f>, the web dashboard via the browser locale.
 */
export function timeToken(date: Date): string {
  return `{{t:${Math.floor(date.getTime() / 1000)}}}`;
}

export const TIME_TOKEN_PATTERN = /\{\{t:(\d+)\}\}/g;
