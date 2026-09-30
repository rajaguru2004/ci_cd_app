import { LoginLimiter } from './login-limiter';

describe('LoginLimiter', () => {
  const t0 = Date.UTC(2026, 8, 30, 10);

  it('lets an address try until it has failed the maximum, then refuses for the window', () => {
    const l = new LoginLimiter(3, 60_000);
    for (let i = 0; i < 3; i += 1) {
      expect(l.retryAfter('a', t0 + i)).toBe(0);
      l.fail('a', t0 + i);
    }
    expect(l.retryAfter('a', t0 + 10)).toBe(60_000 - 10);
    expect(l.retryAfter('b', t0 + 10)).toBe(0);
    expect(l.retryAfter('a', t0 + 60_000)).toBe(0);
  });

  it('forgets failures once the address signs in', () => {
    const l = new LoginLimiter(2, 60_000);
    l.fail('a', t0);
    l.succeed('a');
    l.fail('a', t0 + 1);
    expect(l.retryAfter('a', t0 + 2)).toBe(0);
  });

  it('starts a fresh window after the old one lapses', () => {
    const l = new LoginLimiter(2, 60_000);
    l.fail('a', t0);
    l.fail('a', t0 + 70_000);
    expect(l.retryAfter('a', t0 + 70_001)).toBe(0);
  });
});
