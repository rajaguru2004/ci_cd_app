import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { dirs } from './config';
import { KeyStore } from './keys';
import { tempConfig } from './testing';
import { Vault } from './vault';

async function store() {
  const cfg = await tempConfig();
  const vault = new Vault(dirs(cfg).vault, cfg.vaultKey, cfg.scratchDir);
  await vault.init();
  return { keys: new KeyStore(vault), cfg };
}

describe('KeyStore', () => {
  it('makes an ed25519 key for a git email: public line and fingerprint shown, private half sealed', async () => {
    const { keys, cfg } = await store();
    const key = await keys.create(' raja@company.com ', 'Raja');
    expect(key).toMatchObject({ email: 'raja@company.com', name: 'Raja', lastUsedAt: null });
    expect(key.id).toMatch(/^k_[0-9a-f]{10}$/);
    expect(key.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ raja@company\.com$/);
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/=]+$/);
    const sealed = await fs.readFile(join(dirs(cfg).vault, `keys/${key.id}.key`));
    expect(sealed.toString('latin1')).not.toContain('OPENSSH PRIVATE KEY');
    const priv = await keys.privateKey(key.id);
    expect(priv.toString()).toContain('BEGIN OPENSSH PRIVATE KEY');
    // The private half matches the public line.
    const file = join(cfg.scratchDir, 'check');
    await fs.writeFile(file, priv, { mode: 0o600 });
    expect(execFileSync('ssh-keygen', ['-y', '-f', file]).toString().trim().split(' ').slice(0, 2)).toEqual(key.publicKey.split(' ').slice(0, 2));
    expect(await fs.readdir(cfg.scratchDir)).toEqual(['check']);
    expect((await keys.list()).map((k) => k.id)).toEqual([key.id]);
  });

  it('refuses something that is not an email, and forgets a deleted key', async () => {
    const { keys } = await store();
    for (const bad of ['', 'raja', 'raja@', 'a b@c.com', 'x@y']) await expect(keys.create(bad, null)).rejects.toThrow('Enter the email of your git account');
    const key = await keys.create('a@b.co', null);
    await keys.remove(key.id);
    expect(await keys.list()).toEqual([]);
    await expect(keys.privateKey(key.id)).rejects.toThrow('does not exist');
  });
});
