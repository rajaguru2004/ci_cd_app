/**
 * Slows password guessing: after `max` failed sign-ins from one address within `windowMs`,
 * that address is refused until the window ends. A success clears its count. In memory: the
 * console is one process, and a restart forgetting the counts is acceptable.
 */
export class LoginLimiter {
  private readonly failures = new Map<string, { count: number; since: number }>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  /** Milliseconds until this address may try again; 0 when it may try now. */
  retryAfter(key: string, now = Date.now()): number {
    const entry = this.failures.get(key);
    if (!entry) return 0;
    if (now - entry.since >= this.windowMs) {
      this.failures.delete(key);
      return 0;
    }
    return entry.count >= this.max ? entry.since + this.windowMs - now : 0;
  }

  fail(key: string, now = Date.now()): void {
    const entry = this.failures.get(key);
    if (!entry || now - entry.since >= this.windowMs) {
      this.failures.set(key, { count: 1, since: now });
    } else {
      entry.count += 1;
    }
    // Bound the map: forget the oldest addresses first.
    if (this.failures.size > 10_000) this.failures.delete(this.failures.keys().next().value as string);
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }
}
