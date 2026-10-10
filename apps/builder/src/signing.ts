import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { JobLog } from './log';
import { execArgv } from './process';
import type { CertInfo } from './types';

/**
 * The upload key, handled outside the build. An app's keystore is checked when it is uploaded
 * (store password, alias, key password, certificate), and at release time it signs the
 * finished bundle as root with `jarsigner`, after the build's processes are gone: the app's
 * own Gradle scripts and tests never see it. Gradle signs with a throwaway key meanwhile, so a
 * project whose signing config wants a key.properties it does not have still builds.
 */

export class SigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningError';
  }
}

export interface UploadKey {
  keystore: Buffer;
  storePassword: string;
  keyAlias: string;
  keyPassword: string;
}

// UTC: keytool prints dates in the local zone, and names like IST do not parse.
const env = (extra: Record<string, string>) => ({ PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC', HOME: process.env.HOME || '/root', ...extra });

function certFrom(block: string): CertInfo {
  const line = (label: string) => new RegExp(`^\\s*${label}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim() ?? '';
  const valid = /Valid from:\s*(.+?)\s+until:\s*(.+)$/m.exec(block);
  const iso = (s: string | undefined) => {
    const d = s ? new Date(s) : null;
    return d && Number.isFinite(d.getTime()) ? d.toISOString() : (s ?? '');
  };
  return {
    owner: line('Owner'),
    sha256: line('SHA256'),
    sha1: line('SHA1'),
    validFrom: iso(valid?.[1]),
    validUntil: iso(valid?.[2]),
    algorithm: line('Subject Public Key Algorithm') || line('Signature algorithm name'),
  };
}

/** The keys in a keystore, read with its store password (passwords travel in the environment, never argv). */
export async function listKeystore(file: string, storePassword: string): Promise<Array<{ alias: string; certificate: CertInfo }>> {
  const res = await execArgv('keytool', ['-list', '-v', '-keystore', file, '-storepass:env', 'RC_STOREPASS'], {
    env: env({ RC_STOREPASS: storePassword }),
    timeoutMs: 60_000,
  });
  const out = `${res.stdout}\n${res.stderr}`;
  if (res.code !== 0) {
    if (/password was incorrect|tampered with|BadPaddingException|keystore password was incorrect/i.test(out)) {
      throw new SigningError('The keystore password is wrong.');
    }
    if (/Invalid keystore format|Unrecognized keystore format|DerInputStream|not a valid keystore|toDerInputStream/i.test(out)) {
      throw new SigningError('That file is not a Java keystore (.jks, .keystore or .p12).');
    }
    throw new SigningError(`keytool could not read the keystore: ${out.trim().split('\n').pop()}`);
  }
  const entries: Array<{ alias: string; certificate: CertInfo }> = [];
  for (const block of out.split(/^\*{10,}.*$/m)) {
    const alias = /^Alias name:\s*(.+)$/m.exec(block)?.[1]?.trim();
    if (!alias || !/Entry type:\s*PrivateKeyEntry/i.test(block)) continue;
    entries.push({ alias, certificate: certFrom(block) });
  }
  if (!entries.length) throw new SigningError('The keystore holds no private key, so it cannot sign anything.');
  return entries;
}

/**
 * Proves the whole upload key works, key password included, by signing a one-file JAR with it;
 * returns the certificate of the alias used.
 */
export async function checkUploadKey(key: UploadKey, scratchDir: string): Promise<{ alias: string; certificate: CertInfo }> {
  return withScratch(scratchDir, async (dir) => {
    const ks = join(dir, 'upload.keystore');
    await fs.writeFile(ks, key.keystore, { mode: 0o600 });
    const entries = await listKeystore(ks, key.storePassword);
    const alias = key.keyAlias.trim() || (entries.length === 1 ? entries[0].alias : '');
    if (!alias) {
      throw new SigningError(`This keystore holds ${entries.length} keys (${entries.map((e) => e.alias).join(', ')}): enter the alias of the upload key.`);
    }
    const entry = entries.find((e) => e.alias.toLowerCase() === alias.toLowerCase());
    if (!entry) throw new SigningError(`The keystore has no key '${alias}'; it has ${entries.map((e) => e.alias).join(', ')}.`);
    const jar = join(dir, 'probe.jar');
    await fs.writeFile(join(dir, 'probe.txt'), 'release console key check\n');
    const zipped = await execArgv('zip', ['-q', '-j', jar, join(dir, 'probe.txt')], { timeoutMs: 30_000 });
    if (zipped.code !== 0) throw new SigningError('Could not prepare the key check.');
    const signed = await execArgv(
      'jarsigner',
      ['-keystore', ks, '-storepass:env', 'RC_STOREPASS', '-keypass:env', 'RC_KEYPASS', jar, entry.alias],
      { env: env({ RC_STOREPASS: key.storePassword, RC_KEYPASS: key.keyPassword || key.storePassword }), timeoutMs: 60_000 },
    );
    const out = `${signed.stdout}\n${signed.stderr}`;
    if (signed.code !== 0) {
      if (/Cannot recover key|UnrecoverableKeyException|Given final block not properly padded|not a private key/i.test(out)) {
        throw new SigningError(`The key password for '${entry.alias}' is wrong.`);
      }
      throw new SigningError(`jarsigner could not sign with '${entry.alias}': ${out.trim().split('\n').pop()}`);
    }
    return entry;
  });
}

/**
 * Replaces a bundle's signature with the upload key's: removes the signature files at the top
 * of META-INF (the module folders' own META-INF stay), signs with jarsigner and verifies.
 */
export async function resignBundle(aab: string, key: UploadKey, scratchDir: string, log: JobLog): Promise<void> {
  const stripped = await execArgv(
    'zip',
    ['-q', '-d', aab, 'META-INF/MANIFEST.MF', 'META-INF/*.SF', 'META-INF/*.RSA', 'META-INF/*.DSA', 'META-INF/*.EC'],
    { timeoutMs: 5 * 60_000 },
  );
  // 12 = nothing matched (an unsigned bundle): fine.
  if (stripped.code !== 0 && stripped.code !== 12) throw new SigningError(`Could not remove the build's signature: ${stripped.stderr.trim()}`);
  log.line('Removed the signature Gradle applied (the throwaway key).');
  await withScratch(scratchDir, async (dir) => {
    const ks = join(dir, 'upload.keystore');
    await fs.writeFile(ks, key.keystore, { mode: 0o600 });
    const signed = await execArgv(
      'jarsigner',
      ['-keystore', ks, '-storepass:env', 'RC_STOREPASS', '-keypass:env', 'RC_KEYPASS', '-digestalg', 'SHA-256', aab, key.keyAlias],
      { env: env({ RC_STOREPASS: key.storePassword, RC_KEYPASS: key.keyPassword || key.storePassword }), timeoutMs: 10 * 60_000 },
    );
    if (signed.code !== 0) throw new SigningError(`jarsigner refused: ${`${signed.stdout}\n${signed.stderr}`.trim().split('\n').pop()}`);
  });
  const verified = await execArgv('jarsigner', ['-verify', aab], { env: env({}), timeoutMs: 10 * 60_000 });
  if (verified.code !== 0 || !/jar verified/i.test(verified.stdout)) {
    throw new SigningError(`The signed bundle does not verify: ${`${verified.stdout}\n${verified.stderr}`.trim().split('\n').pop()}`);
  }
  log.line(`Signed with '${key.keyAlias}' and verified (jarsigner -verify: jar verified).`);
}

/**
 * A keystore that exists for one build: Gradle signs with it, so the project's own signing
 * config is never consulted, and the console replaces its signature afterwards.
 */
export async function throwawayKeystore(dir: string, uid?: number, gid?: number): Promise<{ file: string; password: string; alias: string }> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'throwaway.keystore');
  const password = randomBytes(12).toString('hex');
  const res = await execArgv(
    'keytool',
    ['-genkeypair', '-keystore', file, '-storetype', 'PKCS12', '-storepass:env', 'RC_PASS', '-alias', 'throwaway', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2', '-dname', 'CN=Release Console throwaway'],
    { env: env({ RC_PASS: password }), timeoutMs: 60_000 },
  );
  if (res.code !== 0) throw new SigningError(`Could not make the build's throwaway key: ${res.stderr.trim()}`);
  if (uid !== undefined && gid !== undefined) {
    await fs.chown(dir, uid, gid);
    await fs.chown(file, uid, gid);
  }
  return { file, password, alias: 'throwaway' };
}

/** The signer of a bundle as keytool prints it, for the build report. */
export async function bundleSigner(aab: string): Promise<{ text: string; owner: string; sha256: string; debug: boolean }> {
  const res = await execArgv('keytool', ['-printcert', '-jarfile', aab], { env: env({}), timeoutMs: 60_000 });
  const text = res.stdout;
  return {
    text,
    owner: /^Owner: (.*)$/m.exec(text)?.[1]?.trim() ?? '',
    sha256: /^\s*SHA256: (.*)$/m.exec(text)?.[1]?.trim() ?? '',
    debug: /CN=Android Debug/.test(text),
  };
}

export const sameFingerprint = (a: string, b: string) => a.replace(/[^0-9a-f]/gi, '').toLowerCase() === b.replace(/[^0-9a-f]/gi, '').toLowerCase();

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function withScratch<T>(scratchDir: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(scratchDir, `rc-${randomBytes(8).toString('hex')}`);
  await fs.mkdir(dir, { mode: 0o700 });
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
