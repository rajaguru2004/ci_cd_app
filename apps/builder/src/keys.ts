import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import type { KeyRecord } from './types';
import type { Vault } from './vault';

const exec = promisify(execFile);

export class KeyError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'KeyError';
  }
}

const EMAIL = /^[^\s@<>()"',;:\\]+@[^\s@<>()"',;:\\]+\.[^\s@<>()"',;:\\]+$/;
const ID = /^k_[0-9a-f]{10}$/;

/**
 * SSH keys the console makes for people's git accounts. A person gives their git email; the
 * console generates an ed25519 pair with that email as its comment, keeps the private half
 * sealed in the vault, and shows the public line to paste into GitHub, GitLab or Bitbucket.
 * Once it is there, the console reaches every repository that account can reach.
 */
export class KeyStore {
  constructor(private readonly vault: Vault) {}

  async list(): Promise<KeyRecord[]> {
    const names = (await this.vault.list('keys')).filter((n) => n.endsWith('.json'));
    const keys: KeyRecord[] = [];
    for (const n of names) {
      const k = await this.vault.getJson<KeyRecord>(`keys/${n}`);
      if (k) keys.push(k);
    }
    return keys.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<KeyRecord | null> {
    if (!ID.test(id)) return null;
    return this.vault.getJson<KeyRecord>(`keys/${id}.json`);
  }

  async require(id: string): Promise<KeyRecord> {
    const key = await this.get(id);
    if (!key) throw new KeyError('That SSH key does not exist on this console (it may have been deleted).', 404);
    return key;
  }

  async create(emailInput: unknown, nameInput: unknown): Promise<KeyRecord> {
    const email = typeof emailInput === 'string' ? emailInput.trim() : '';
    if (!email || email.length > 200 || !EMAIL.test(email)) {
      throw new KeyError('Enter the email of your git account, e.g. name@company.com.');
    }
    const name = typeof nameInput === 'string' && nameInput.trim() ? nameInput.trim().slice(0, 80) : null;
    const id = `k_${randomBytes(5).toString('hex')}`;
    // ssh-keygen writes files: into a private tmpfs folder that is removed at once.
    return this.vault
      .withDir(async (dir) => {
        const file = join(dir, 'id_ed25519');
        await exec('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', email, '-f', file], { timeout: 30_000 });
        const privateKey = await fs.readFile(file);
        const publicKey = (await fs.readFile(`${file}.pub`, 'utf8')).trim();
        const { stdout } = await exec('ssh-keygen', ['-l', '-E', 'sha256', '-f', `${file}.pub`], { timeout: 30_000 });
        const fingerprint = /SHA256:[A-Za-z0-9+/=]+/.exec(stdout)?.[0] ?? '';
        const record: KeyRecord = { id, email, name, publicKey, fingerprint, createdAt: new Date().toISOString(), lastUsedAt: null };
        await this.vault.put(`keys/${id}.key`, privateKey);
        await this.vault.putJson(`keys/${id}.json`, record);
        return record;
      })
      .catch((e: unknown) => {
        if (e instanceof KeyError) throw e;
        throw new KeyError(`The key could not be generated (${(e as Error).message}).`, 500);
      });
  }

  /** The private key, decrypted, for one git operation (kept in memory; written only to a tmpfs). */
  async privateKey(id: string): Promise<Buffer> {
    await this.require(id);
    const key = await this.vault.get(`keys/${id}.key`);
    if (!key) throw new KeyError('The private half of that SSH key is missing from the vault; create a new key.', 410);
    return key;
  }

  async touch(id: string): Promise<void> {
    const key = await this.get(id);
    if (!key) return;
    key.lastUsedAt = new Date().toISOString();
    await this.vault.putJson(`keys/${id}.json`, key);
  }

  async remove(id: string): Promise<void> {
    await this.require(id);
    await this.vault.remove(`keys/${id}.key`);
    await this.vault.remove(`keys/${id}.json`);
  }
}
