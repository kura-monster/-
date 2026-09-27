/** A rule violation whose message is safe and meant to be shown to the user as-is. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export function fail(message: string): never {
  throw new DomainError(message);
}
