import { safeEqual, SESSION_TTL_MS, signSession, verifySession } from './session';

const SECRET = 'a'.repeat(64);

describe('session tokens', () => {
  it('accepts its own token until it expires', () => {
    const now = Date.UTC(2026, 8, 29, 10);
    const token = signSession(SECRET, now);
    expect(verifySession(SECRET, token, now + 1000)).toBe(true);
    expect(verifySession(SECRET, token, now + SESSION_TTL_MS + 1)).toBe(false);
  });

  it('refuses a token signed with another secret', () => {
    expect(verifySession(SECRET, signSession('b'.repeat(64)))).toBe(false);
  });

  it('refuses a token whose payload was edited', () => {
    const [, sig] = signSession(SECRET).split('.');
    const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 10 * SESSION_TTL_MS })).toString('base64url');
    expect(verifySession(SECRET, `${forged}.${sig}`)).toBe(false);
  });

  it.each([undefined, '', 'nodot', '.', 'a.b.c'])('refuses %p', (token) => {
    expect(verifySession(SECRET, token)).toBe(false);
  });

  it('compares passwords without caring about length', () => {
    expect(safeEqual('correct horse', 'correct horse')).toBe(true);
    expect(safeEqual('correct horse', 'correct')).toBe(false);
  });
});
