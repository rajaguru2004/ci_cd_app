import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Vault } from './vault';

const KEY = 'v'.repeat(64);

async function make(key = KEY) {
  const root = await fs.mkdtemp(join(tmpdir(), 'vault-'));
  const scratch = join(root, 'shm');
  await fs.mkdir(scratch);
  const vault = new Vault(join(root, 'vault'), key, scratch);
  await vault.init();
  return { vault, root, scratch };
}

describe('Vault', () => {
  it('stores items sealed (not readable as written) and opens them again', async () => {
    const { vault, root } = await make();
    await vault.put('apps/fusionhrm/signing.json', Buffer.from('{"storePassword":"hunter2"}'));
    const raw = await fs.readFile(join(root, 'vault/apps/fusionhrm/signing.json'));
    expect(raw.toString('latin1')).not.toContain('hunter2');
    expect((await vault.get('apps/fusionhrm/signing.json'))!.toString()).toContain('hunter2');
    expect((await fs.stat(join(root, 'vault'))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(root, 'vault/apps/fusionhrm/signing.json'))).mode & 0o777).toBe(0o600);
  });

  it('refuses an item moved to another name, a tampered item, and a different VAULT_KEY', async () => {
    const { vault, root, scratch } = await make();
    await vault.put('keys/a.key', Buffer.from('secret-a'));
    await fs.copyFile(join(root, 'vault/keys/a.key'), join(root, 'vault/keys/b.key'));
    await expect(vault.get('keys/b.key')).rejects.toThrow('does not open');
    const blob = await fs.readFile(join(root, 'vault/keys/a.key'));
    blob[blob.length - 1] ^= 1;
    await fs.writeFile(join(root, 'vault/keys/a.key'), blob);
    await expect(vault.get('keys/a.key')).rejects.toThrow('does not open');
    const other = new Vault(join(root, 'vault'), 'w'.repeat(64), scratch);
    await expect(other.init()).rejects.toThrow('VAULT_KEY is not the key');
  });

  it('decrypts onto the scratch folder only for the length of one operation', async () => {
    const { vault, scratch } = await make();
    let seen = '';
    await vault.withFiles({ 'id_ed25519': Buffer.from('PRIVATE') }, async (paths) => {
      seen = await fs.readFile(paths.id_ed25519, 'utf8');
      expect((await fs.stat(paths.id_ed25519)).mode & 0o777).toBe(0o600);
    });
    expect(seen).toBe('PRIVATE');
    expect(await fs.readdir(scratch)).toEqual([]);
    await expect(vault.withFiles({ x: Buffer.from('y') }, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await fs.readdir(scratch)).toEqual([]);
  });

  it('refuses names that could leave the vault', async () => {
    const { vault } = await make();
    await expect(vault.put('../escape', Buffer.from('x'))).rejects.toThrow('Bad vault item name');
    await expect(vault.put('apps/../../x', Buffer.from('x'))).rejects.toThrow('Bad vault item name');
  });
});
