import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { dirname, join } from 'path';

/**
 * The console's secrets at rest: SSH private keys, keystores and their passwords, Google Play
 * keys. Each item is one file sealed with AES-256-GCM under a key derived from VAULT_KEY, with
 * the item's name as associated data, so a file copied to another name does not open.
 *
 * The folder is root's alone (0700): the console API (uid 1000) and the build user (uid 1001)
 * cannot read it even sealed. A secret is only ever decrypted into a private tmpfs folder for
 * the seconds one operation needs it (withFiles), never into the shared volume.
 */

const MAGIC = Buffer.from('RCV1');
const NAME = /^[a-z0-9][a-z0-9_.-]*(\/[a-z0-9][a-z0-9_.-]*)*$/;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

export class Vault {
  private readonly key: Buffer;

  constructor(
    readonly dir: string,
    secret: string,
    private readonly scratchDir: string,
  ) {
    this.key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('release-console'), Buffer.from('vault v1'), 32));
  }

  /** Creates the vault, or proves VAULT_KEY is the key it was written with. */
  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dir, 0o700);
    const check = join(this.dir, '.check');
    const existing = await fs.readFile(check).catch(() => null);
    if (!existing) {
      await this.atomic(check, this.seal(Buffer.from('release-console vault'), '.check'));
    } else {
      try {
        this.open(existing, '.check');
      } catch {
        throw new VaultError(
          'VAULT_KEY is not the key this vault was written with, so the stored SSH keys, keystores and Play keys cannot be read. Put the previous VAULT_KEY back in .env.',
        );
      }
    }
    // Decrypted copies left behind by a crash.
    for (const name of await fs.readdir(this.scratchDir).catch(() => [] as string[])) {
      if (name.startsWith('rc-')) await fs.rm(join(this.scratchDir, name), { recursive: true, force: true });
    }
  }

  async put(name: string, data: Buffer): Promise<void> {
    const path = this.path(name);
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await this.atomic(path, this.seal(data, name));
  }

  async get(name: string): Promise<Buffer | null> {
    let blob: Buffer;
    try {
      blob = await fs.readFile(this.path(name));
    } catch {
      return null;
    }
    try {
      return this.open(blob, name);
    } catch {
      throw new VaultError(`The vault item ${name} does not open with this VAULT_KEY (changed key, or a damaged file).`);
    }
  }

  async has(name: string): Promise<boolean> {
    return fs
      .access(this.path(name))
      .then(() => true)
      .catch(() => false);
  }

  /** Removes an item, or a folder of items (e.g. everything stored for one app). */
  async remove(name: string): Promise<void> {
    await fs.rm(this.path(name), { recursive: true, force: true });
  }

  /**
   * Plain JSON next to the sealed items (key and app metadata): not secret, but kept in the
   * same root-only folder so nothing outside the builder reads it either.
   */
  async putJson(name: string, value: unknown): Promise<void> {
    const path = this.path(name);
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await this.atomic(path, Buffer.from(JSON.stringify(value, null, 2)));
  }

  async getJson<T>(name: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(this.path(name), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  async list(folder: string): Promise<string[]> {
    return fs.readdir(this.path(folder)).catch(() => [] as string[]);
  }

  /**
   * Writes decrypted files into a fresh private folder on the tmpfs, runs `fn` with their
   * paths, and removes the folder afterwards whatever happens.
   */
  async withFiles<T>(files: Record<string, Buffer>, fn: (paths: Record<string, string>) => Promise<T>): Promise<T> {
    return this.withDir(async (dir) => {
      const paths: Record<string, string> = {};
      for (const [name, data] of Object.entries(files)) {
        if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new VaultError(`Bad scratch file name ${name}.`);
        paths[name] = join(dir, name);
        await fs.writeFile(paths[name], data, { mode: 0o600 });
      }
      return fn(paths);
    });
  }

  /** A fresh private folder on the tmpfs for secret material, removed when `fn` settles. */
  async withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = join(this.scratchDir, `rc-${randomBytes(8).toString('hex')}`);
    await fs.mkdir(dir, { mode: 0o700 });
    try {
      return await fn(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  private path(name: string): string {
    if (!NAME.test(name) || name.includes('..')) throw new VaultError(`Bad vault item name ${name}.`);
    return join(this.dir, name);
  }

  private seal(data: Buffer, name: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(name));
    const body = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
  }

  private open(blob: Buffer, name: string): Buffer {
    if (blob.length < 32 || !blob.subarray(0, 4).equals(MAGIC)) throw new VaultError('Not a vault item.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, blob.subarray(4, 16));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(blob.subarray(16, 32));
    return Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]);
  }

  private async atomic(path: string, data: Buffer): Promise<void> {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, path);
  }
}
