import { promises as fs } from 'fs';
import { join } from 'path';
import { AppStore, slugify } from './apps';
import { dirs } from './config';
import { Git } from './git';
import { KeyStore } from './keys';
import { makeKeystore, tempConfig, useJdk } from './testing';
import { Vault } from './vault';

const jdk = useJdk();

async function make(extra: Record<string, string> = {}) {
  const cfg = await tempConfig(extra);
  const d = dirs(cfg);
  const vault = new Vault(d.vault, cfg.vaultKey, cfg.scratchDir);
  await vault.init();
  const keys = new KeyStore(vault);
  const git = new Git(d.repos, vault, keys, 60_000);
  const apps = new AppStore(d.apps, vault, keys, git, cfg.scratchDir, cfg.playKeyFile);
  await apps.init();
  return { cfg, vault, keys, apps };
}

const PLAY_KEY = JSON.stringify({ type: 'service_account', client_email: 'ci@proj.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n', project_id: 'proj' });

describe('AppStore', () => {
  it('creates an app from a name and a package, ZIP-only until a repository is connected', async () => {
    const { apps } = await make();
    const app = await apps.create({ name: '  FusionHRM ', packageName: 'com.fusionapps.fusionhrm' });
    expect(app).toMatchObject({ id: 'fusionhrm', name: 'FusionHRM', packageName: 'com.fusionapps.fusionhrm', repo: null, signing: { mode: 'repository' }, play: { source: 'default', clientEmail: null } });
    const again = await apps.create({ name: 'FusionHRM', packageName: 'com.fusionapps.other' });
    expect(again.id).toBe('fusionhrm-2');
    await expect(apps.create({ name: 'Dup', packageName: 'com.fusionapps.fusionhrm' })).rejects.toThrow('FusionHRM already releases com.fusionapps.fusionhrm');
    await expect(apps.create({ name: 'Bad', packageName: 'fusionhrm' })).rejects.toThrow('is not an Android package name');
    await expect(apps.create({ name: ' ', packageName: 'com.a.b' })).rejects.toThrow('Give the app a name.');
    expect((await apps.list()).map((a) => a.id)).toEqual(['fusionhrm', 'fusionhrm-2']);
  });

  it('records a repository it cannot reach yet instead of refusing it, with the reason', async () => {
    const { apps, keys } = await make();
    const key = await keys.create('dev@company.com', null);
    const app = await apps.create({ name: 'Hive', packageName: 'com.skillhive.hive', repo: { url: 'ssh://git@127.0.0.1:1/org/hive.git', keyId: key.id } });
    expect(app.repo).toMatchObject({ url: 'ssh://git@127.0.0.1:1/org/hive.git', keyId: key.id, branch: 'main', path: '', access: { state: 'failed' } });
    expect(app.repo!.access.message).toContain('did not answer on SSH');
    await expect(apps.update(app.id, { repo: { url: 'https://github.com/org/hive' } })).rejects.toThrow('Use git@github.com:org/hive.git');
    await expect(apps.create({ name: 'NoKey', packageName: 'com.a.c', repo: { url: 'git@github.com:o/r.git', keyId: 'k_ffffffffff' } })).rejects.toThrow('does not exist');
  });

  it('gives a github.com repository the GitHub Actions option even for an app recorded before that existed', async () => {
    const { apps, cfg } = await make();
    const app = await apps.create({ name: 'Acme', packageName: 'com.acme.app' });
    const file = join(dirs(cfg).apps, app.id, 'app.json');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    raw.repo = { url: 'git@github.com:acme/app.git', keyId: 'k', branch: 'main', defaultBranch: 'main', path: '', access: { state: 'ok', checkedAt: null, message: null } };
    delete raw.runner; // as it was recorded before this field existed
    await fs.writeFile(file, JSON.stringify(raw));

    const read = await apps.require(app.id);
    expect(read.runner).toEqual({ kind: 'server', github: { repo: 'acme/app', workflow: 'release-console.yml', token: 'default', tokenLogin: null, check: null, secrets: { syncedAt: null, hash: null } } });
    // Not persisted by the read alone: a second read starts from the same bare record.
    expect(JSON.parse(await fs.readFile(file, 'utf8')).runner).toBeUndefined();
    // The first write-through (any github setting) persists what the read already saw.
    const checked = await apps.noteGithub(app.id, { token: 'default' });
    expect(checked.runner.github!.repo).toBe('acme/app');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).runner.github.repo).toBe('acme/app');
  });

  it('keeps an app’s own Play key sealed and falls back to the console default', async () => {
    const { apps, cfg } = await make();
    await fs.writeFile(cfg.playKeyFile, PLAY_KEY.replace('ci@', 'default@'));
    const app = await apps.create({ name: 'Rydex', packageName: 'com.example.rydex_app' });
    expect(app.play.clientEmail).toBe('default@proj.iam.gserviceaccount.com');
    await expect(apps.setPlayKey(app.id, '{"type":"user"}')).rejects.toThrow('not a service-account key');
    const withKey = await apps.setPlayKey(app.id, PLAY_KEY);
    expect(withKey.play).toMatchObject({ source: 'app', clientEmail: 'ci@proj.iam.gserviceaccount.com' });
    expect((await apps.playKey(withKey))!.source).toBe('app');
    const back = await apps.clearPlayKey(app.id);
    expect((await apps.playKey(back))!.key.client_email).toBe('default@proj.iam.gserviceaccount.com');
  });

  it('numbers runs per app and never reuses a number', async () => {
    const { apps } = await make();
    const app = await apps.create({ name: 'Medihive', packageName: 'com.example.medihive' });
    expect(await apps.nextNumber(app.id)).toBe(1);
    expect(await apps.nextNumber(app.id)).toBe(2);
    expect(await apps.nextNumber(app.id, 9)).toBe(10);
  });

  it('removes an app with everything it stored', async () => {
    const { apps, vault } = await make();
    const app = await apps.create({ name: 'Gone', packageName: 'com.a.gone' });
    await apps.setPlayKey(app.id, PLAY_KEY);
    await apps.remove(app.id);
    expect(await apps.get(app.id)).toBeNull();
    expect(await vault.has(`apps/${app.id}/play.json`)).toBe(false);
  });

  (jdk ? it : it.skip)('checks an uploaded keystore before storing it, and signs from the vault afterwards', async () => {
    const { apps, cfg, vault } = await make();
    const app = await apps.create({ name: 'Nex Hive', packageName: 'com.skillhiveinnovations.nex_hive' });
    const ks = join(cfg.dataDir, 'upload.jks');
    makeKeystore(ks, { alias: 'upload', storePass: 'sp-123456', keyPass: 'kp-123456', cn: 'SkillHive Upload' });
    const keystore = (await fs.readFile(ks)).toString('base64');
    await expect(apps.setSigning(app.id, { keystore, storePassword: 'wrong', keyPassword: 'kp-123456' })).rejects.toThrow('keystore password is wrong');
    await expect(apps.setSigning(app.id, { keystore, storePassword: 'sp-123456', keyPassword: 'nope' })).rejects.toThrow("key password for 'upload' is wrong");
    const signed = await apps.setSigning(app.id, { keystore, fileName: 'upload-keystore.jks', storePassword: 'sp-123456', keyPassword: 'kp-123456' });
    expect(signed.signing).toMatchObject({ mode: 'console', fileName: 'upload-keystore.jks', keyAlias: 'upload', certificate: { owner: 'CN=SkillHive Upload' } });
    expect(JSON.stringify(signed)).not.toContain('sp-123456');
    expect((await vault.get(`apps/${app.id}/signing.json`))!.toString()).toContain('kp-123456');
    const key = await apps.uploadKey(app.id);
    expect(key).toMatchObject({ storePassword: 'sp-123456', keyAlias: 'upload', keyPassword: 'kp-123456' });
    const cleared = await apps.clearSigning(app.id);
    expect(cleared.signing.mode).toBe('repository');
    expect(await apps.uploadKey(app.id)).toBeNull();
  });
});

describe('slugify', () => {
  it('makes URL-safe ids', () => {
    expect(slugify('FusionHRM Android')).toBe('fusionhrm-android');
    expect(slugify('Nex Hive — ERP')).toBe('nex-hive-erp');
    expect(slugify('ॐ')).toBe('app');
  });
});
