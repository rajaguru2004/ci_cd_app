import { ChildProcess, execFileSync, spawn } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import { userInfo } from 'os';
import { join } from 'path';
import { dirs } from './config';
import { Git, parseRepoUrl } from './git';
import { KeyStore } from './keys';
import { tempConfig } from './testing';
import { Vault } from './vault';

/**
 * The git module against a real SSH server: an unprivileged sshd on a random port serving a
 * bare repository, and a key the console generated, refused until its public line is
 * authorised (what a person does on GitHub), then used for ls-remote, inspect, fetch, log and
 * checkout.
 */

const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => existsSync(p));
const maybe = SSHD ? describe : describe.skip;
if (!SSHD) console.warn('git-over-SSH specs skipped: no sshd on this machine');

let sshd: ChildProcess | null = null;
let root = '';
let port = 0;
let git: Git;
let keys: KeyStore;
let url = '';
let sha = '';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@company.com', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' }).toString().trim();

beforeAll(async () => {
  if (!SSHD) return;
  const cfg = await tempConfig();
  root = cfg.dataDir;
  const vault = new Vault(dirs(cfg).vault, cfg.vaultKey, cfg.scratchDir);
  await vault.init();
  keys = new KeyStore(vault);
  git = new Git(dirs(cfg).repos, vault, keys, 60_000);

  // A Flutter-shaped project with history, a tag and a second branch.
  const work = join(root, 'work');
  await fs.mkdir(join(work, 'android/app/src/main'), { recursive: true });
  await fs.writeFile(join(work, 'pubspec.yaml'), 'name: ess_portal\nversion: 1.0.1+9\ndependencies:\n  flutter:\n    sdk: flutter\n');
  await fs.writeFile(join(work, 'android/app/build.gradle.kts'), 'android {\n    namespace = "com.fusionapps.fusionhrm"\n    defaultConfig {\n        applicationId = "com.fusionapps.fusionhrm"\n    }\n}\n');
  await fs.writeFile(join(work, 'android/app/src/main/AndroidManifest.xml'), '<manifest><application android:label="FusionHRM"></application></manifest>\n');
  await fs.writeFile(join(work, 'android/key.properties'), 'storeFile=upload-keystore.jks\n');
  sh(work, 'init', '-q');
  sh(work, 'add', '.');
  sh(work, 'commit', '-q', '-m', 'feat: first screen');
  await fs.writeFile(join(work, 'README.md'), 'hello\n');
  sh(work, 'add', '.');
  sh(work, 'commit', '-q', '-m', 'docs: readme\n\nWith a body.');
  sh(work, 'tag', '-a', 'v1.0.1', '-m', 'first release');
  sh(work, 'branch', 'feat/payslips');
  sha = sh(work, 'rev-parse', 'HEAD');
  sh(root, 'clone', '-q', '--bare', work, join(root, 'repo.git'));

  // sshd as this user on a free port; authorized_keys starts empty.
  await fs.writeFile(join(root, 'authorized_keys'), '', { mode: 0o600 });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'host_key')]);
  port = 20000 + Math.floor(Math.random() * 20000);
  await fs.writeFile(
    join(root, 'sshd_config'),
    [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(root, 'host_key')}`, `AuthorizedKeysFile ${join(root, 'authorized_keys')}`, 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes no', `PidFile ${join(root, 'sshd.pid')}`, ''].join('\n'),
  );
  sshd = spawn(SSHD, ['-D', '-e', '-f', join(root, 'sshd_config')], { stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
    const up = await new Promise<boolean>((r) => {
      const s = require('net').connect(port, '127.0.0.1', () => (s.end(), r(true))); // eslint-disable-line @typescript-eslint/no-require-imports
      s.on('error', () => r(false));
    });
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  url = `ssh://${userInfo().username}@127.0.0.1:${port}${join(root, 'repo.git')}`;
}, 30_000);

afterAll(() => {
  sshd?.kill();
});

maybe('git over SSH with a key the console generated', () => {
  it('is refused until the public key is authorised, then lists the branches', async () => {
    const key = await keys.create('dev@company.com', null);
    const repo = parseRepoUrl(url);
    await expect(git.lsRemote(repo, key.id)).rejects.toThrow(`127.0.0.1 refused the key for dev@company.com (Permission denied)`);
    await fs.appendFile(join(root, 'authorized_keys'), `${key.publicKey}\n`);
    expect(await git.lsRemote(repo, key.id)).toEqual({ defaultBranch: 'main', branches: ['main', 'feat/payslips'] });
    expect((await keys.get(key.id))!.lastUsedAt).not.toBeNull();
    expect((await git.knownHosts()).map((h) => h.host)).toEqual([`[127.0.0.1]:${port}`]);
  });

  it('reads the project on a branch without keeping the repository', async () => {
    const [key] = await keys.list();
    const info = await git.inspect(parseRepoUrl(url), key.id, 'main');
    expect(info).toMatchObject({
      path: '', name: 'ess_portal', versionName: '1.0.1', buildNumber: 9, applicationId: 'com.fusionapps.fusionhrm', label: 'FusionHRM', keyProperties: true, flutter: true, sha,
      commit: { subject: 'docs: readme', author: 'Dev', email: 'dev@company.com' },
    });
    await expect(git.inspect(parseRepoUrl(url), key.id, 'nope')).rejects.toThrow("has no branch 'nope'");
    expect((await fs.readdir(dirs({ dataDir: root }).repos)).filter((n) => n.startsWith('.inspect'))).toEqual([]);
  });

  it('mirrors the repository for the commit stream, and checks out one commit for a run', async () => {
    const [key] = await keys.list();
    const repo = parseRepoUrl(url);
    await git.fetch('fusionhrm', repo, key.id);
    const log = await git.log('fusionhrm', 'main');
    expect(log.map((c) => c.subject)).toEqual(['docs: readme', 'feat: first screen']);
    expect(log[0]).toMatchObject({ sha, author: 'Dev', email: 'dev@company.com', body: 'With a body.' });
    expect((await git.tags('fusionhrm')).get(sha)).toEqual(['v1.0.1']);
    expect((await git.branches('fusionhrm')).sort()).toEqual(['feat/payslips', 'main']);
    expect(await git.resolve('fusionhrm', { branch: 'main' })).toBe(sha);
    expect(await git.resolve('fusionhrm', { sha: 'f'.repeat(40) })).toBeNull();
    const dest = join(root, 'run-src');
    await git.checkout('fusionhrm', repo, key.id, sha, dest, {});
    expect(await fs.readFile(join(dest, 'README.md'), 'utf8')).toBe('hello\n');
    expect(sh(dest, 'rev-parse', 'HEAD')).toBe(sha);
    expect(sh(dest, 'remote', 'get-url', 'origin')).toBe(url);
    const state = await git.refresh('fusionhrm', repo, key.id, 60_000, 1000);
    expect(state).toMatchObject({ fetching: false, error: null });
  });
});
