/** Adapter configured without credentials/base URL: fail fast, never stub data (CLAUDE.md §2.1). */
export class FeedConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedConfigError';
  }
}
