import { createHash, createHmac, timingSafeEqual } from 'crypto';

export const SESSION_COOKIE = 'mci_session';
/** A working day; the console is used from a desk, not left signed in for weeks. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface SessionPayload {
  /** Expiry, epoch milliseconds. */
  exp: number;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

/** `payload.signature`, HMAC-SHA256 over the payload. Nothing secret lives in the payload. */
export function signSession(secret: string, now = Date.now()): string {
  const payload = b64url(Buffer.from(JSON.stringify({ exp: now + SESSION_TTL_MS })));
  return `${payload}.${sign(secret, payload)}`;
}

export function verifySession(secret: string, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  if (!safeEqual(signature, sign(secret, payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionPayload;
    return typeof data.exp === 'number' && data.exp > now;
  } catch {
    return false;
  }
}

function sign(secret: string, payload: string): string {
  return b64url(createHmac('sha256', secret).update(payload).digest());
}

/**
 * Constant-time compare that does not leak length: both sides are hashed to 32 bytes first,
 * so timingSafeEqual always compares equal widths.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
