/**
 * Lives in its own file so `write-path.ts` and `service.ts` can both import
 * VaultError without creating a circular dependency.
 */
export class VaultError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}
