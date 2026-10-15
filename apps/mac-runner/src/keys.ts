import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { utils } from 'ssh2';
import { generateKeys } from './seal';

/**
 * The agent's own keys, made on its first start and kept in its data volume:
 *   agent.pem       X25519: the console pins its public half and seals each run's secrets to it
 *   ssh/id_ed25519  how the agent signs in to its Mac (its public line goes in ~/.ssh/authorized_keys)
 *   ssh/host_key    the Mac's SSH host key, remembered on first contact and held to afterwards
 * A new volume means new keys: the console then refuses the agent until its key is reset there.
 */

export interface AgentKeys {
  /** X25519 private key, PKCS#8 PEM. */
  sealPem: string;
  /** X25519 public key, base64 (what the console pins). */
  sealPublic: string;
  sshPrivate: string;
  /** "ssh-ed25519 AAAA… release-console-runner" */
  sshPublic: string;
}

async function readOrNull(file: string): Promise<string | null> {
  return fs.readFile(file, 'utf8').catch(() => null);
}

export async function loadKeys(dataDir: string): Promise<AgentKeys> {
  await fs.mkdir(join(dataDir, 'ssh'), { recursive: true, mode: 0o700 });
  const sealFile = join(dataDir, 'agent.pem');
  const sealPubFile = join(dataDir, 'agent.pub');
  let sealPem = await readOrNull(sealFile);
  let sealPublic = (await readOrNull(sealPubFile))?.trim() ?? null;
  if (!sealPem || !sealPublic) {
    const k = generateKeys();
    sealPem = k.privatePem;
    sealPublic = k.publicKey;
    await fs.writeFile(sealFile, sealPem, { mode: 0o600 });
    await fs.writeFile(sealPubFile, `${sealPublic}\n`, { mode: 0o644 });
  }
  const sshFile = join(dataDir, 'ssh', 'id_ed25519');
  let sshPrivate = await readOrNull(sshFile);
  let sshPublic = (await readOrNull(`${sshFile}.pub`))?.trim() ?? null;
  if (!sshPrivate || !sshPublic) {
    const k = utils.generateKeyPairSync('ed25519', { comment: 'release-console-runner' });
    sshPrivate = k.private;
    sshPublic = k.public.trim();
    await fs.writeFile(sshFile, sshPrivate, { mode: 0o600 });
    await fs.writeFile(`${sshFile}.pub`, `${sshPublic}\n`, { mode: 0o644 });
  }
  return { sealPem, sealPublic, sshPrivate, sshPublic };
}

/** The line for the Mac's ~/.ssh/authorized_keys: this key, unable to forward anything or open a terminal. */
export function authorizedLine(keys: AgentKeys): string {
  return `restrict ${keys.sshPublic}`;
}

export const hostKeyFingerprint = (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/** First contact is remembered; afterwards only that key is accepted (as ssh's StrictHostKeyChecking=accept-new). */
export class HostKeyPin {
  constructor(private readonly file: string) {}

  async check(address: string, key: Buffer): Promise<{ ok: true } | { ok: false; held: string; offered: string }> {
    const offered = hostKeyFingerprint(key);
    const pins = await this.read();
    const held = pins[address];
    if (!held) {
      pins[address] = offered;
      await fs.writeFile(this.file, JSON.stringify(pins, null, 2), { mode: 0o600 });
      return { ok: true };
    }
    return held === offered ? { ok: true } : { ok: false, held, offered };
  }

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
}
