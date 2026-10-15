import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, KeyObject, randomBytes } from 'crypto';

/**
 * Secrets sealed for one Mac runner: X25519 key agreement with a fresh key per message, HKDF-SHA256,
 * AES-256-GCM. The runner's public key is pinned on its first connect, so a run's certificate,
 * profiles and App Store Connect key can be read by that runner's agent and nothing in between
 * (the web and api hops, a TLS proxy, the network). The same file is in apps/builder/src.
 *
 *   sealed = v1 (1 byte) · ephemeral public key (32) · iv (12) · tag (16) · ciphertext
 *
 * The associated data names what the secret is for (e.g. "run:12"), so a sealed blob replayed
 * for another run does not open.
 */

const VERSION = 1;
const INFO = Buffer.from('release-console mac runner secrets v1');
/** DER prefix of an X25519 SubjectPublicKeyInfo; the raw 32-byte key follows it. */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealError';
  }
}

export function rawPublicKey(key: KeyObject): Buffer {
  const der = key.export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32));
}

export function publicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new SealError('An X25519 public key is 32 bytes.');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** A base64 X25519 public key as a runner sends it; throws when it is not one. */
export function parsePublicKey(input: unknown): Buffer {
  if (typeof input !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(input)) throw new SealError('publicKey must be a base64 X25519 public key.');
  const raw = Buffer.from(input, 'base64');
  publicKeyFromRaw(raw);
  return raw;
}

/** "SHA256:…" of a raw public key, in the style ssh-keygen prints fingerprints. */
export function fingerprint(raw: Buffer): string {
  return `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`;
}

export function generateKeys(): { privatePem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return { privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKey: rawPublicKey(publicKey).toString('base64') };
}

function derive(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), INFO, 32));
}

export function seal(plain: Buffer, recipientPublicKey: string, aad: string): string {
  const recipient = parsePublicKey(recipientPublicKey);
  const eph = generateKeyPairSync('x25519');
  const ephRaw = rawPublicKey(eph.publicKey);
  const key = derive(diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyFromRaw(recipient) }), ephRaw, recipient);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), ephRaw, iv, cipher.getAuthTag(), body]).toString('base64');
}

export function open(sealed: string, privatePem: string, aad: string): Buffer {
  const blob = Buffer.from(sealed, 'base64');
  if (blob.length < 1 + 32 + 12 + 16 || blob[0] !== VERSION) throw new SealError('Not a sealed message this agent can read.');
  const privateKey = createPrivateKey(privatePem);
  const own = rawPublicKey(createPublicKey(privateKey));
  const ephRaw = blob.subarray(1, 33);
  const key = derive(diffieHellman({ privateKey, publicKey: publicKeyFromRaw(ephRaw) }), ephRaw, own);
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(33, 45));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(blob.subarray(45, 61));
  try {
    return Buffer.concat([decipher.update(blob.subarray(61)), decipher.final()]);
  } catch {
    throw new SealError('The sealed secrets do not open with this agent’s key (sealed for another key, or for another run).');
  }
}
