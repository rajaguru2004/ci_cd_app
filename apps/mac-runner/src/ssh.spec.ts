import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, promises as fs } from 'fs';
import { connect } from 'net';
import { tmpdir, userInfo } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { SshExecutor } from './executor';
import { authorizedLine, HostKeyPin, loadKeys, type AgentKeys } from './keys';

/**
 * The agent's way into its Mac when it runs in a container: SSH, against a real sshd on this
 * machine, signing in with the agent's own key under the `restrict` line setup-mac.sh writes
 * into authorized_keys. Commands and their output, files both ways (secrets through stdin),
 * a stream piped in, a cancel that stops the remote process group, and the host key pin.
 */

const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => existsSync(p));
const maybe = SSHD ? describe : describe.skip;

let root = '';
let sshd: ChildProcess;
let port = 0;
let keys: AgentKeys;
let exec: SshExecutor;

beforeAll(async () => {
  if (!SSHD) return;
  root = await fs.mkdtemp(join(tmpdir(), 'rc-ssh-'));
  keys = await loadKeys(join(root, 'agent'));
  await fs.writeFile(join(root, 'authorized_keys'), `${authorizedLine(keys)}\n`, { mode: 0o600 });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, 'host_key')]);
  port = 20000 + Math.floor(Math.random() * 20000);
  await fs.writeFile(
    join(root, 'sshd_config'),
    [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(root, 'host_key')}`, `AuthorizedKeysFile ${join(root, 'authorized_keys')}`, 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'UsePAM no', 'StrictModes no', `PidFile ${join(root, 'sshd.pid')}`, ''].join('\n'),
  );
  sshd = spawn(SSHD, ['-D', '-e', '-f', join(root, 'sshd_config')], { stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
    const up = await new Promise<boolean>((r) => {
      const s = connect(port, '127.0.0.1', () => (s.end(), r(true)));
      s.on('error', () => r(false));
    });
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  exec = new SshExecutor({ host: '127.0.0.1', port, user: userInfo().username, privateKey: keys.sshPrivate, pin: new HostKeyPin(join(root, 'agent', 'ssh', 'host_key')) });
}, 30_000);

afterAll(() => {
  exec?.close();
  sshd?.kill();
});

maybe('the agent on its Mac over SSH', () => {
  it('runs commands as the Mac user with the restricted key, output and exit code included', async () => {
    const res = await exec.exec('echo "on $(id -un)"; echo warn >&2; exit 3', { timeoutMs: 20_000 });
    expect(res.code).toBe(3);
    expect(res.stdout).toBe(`on ${userInfo().username}\n`);
    expect(res.stderr).toBe('warn\n');
  });

  it('passes variables and a working folder, sources an environment file, and keeps secrets off the command line', async () => {
    await exec.writeFile(join(root, 'mac/run/.rc/step.env'), "export SECRET='it'\\''s quiet'\n", 0o600);
    const res = await exec.exec('pwd; echo "$PLAIN / $SECRET"; stat -c %a .rc/step.env', { cwd: join(root, 'mac/run'), env: { PLAIN: 'a b' }, envFile: join(root, 'mac/run/.rc/step.env'), timeoutMs: 20_000 });
    expect(res.stdout.split('\n')).toEqual([join(root, 'mac/run'), "a b / it's quiet", '600', '']);
  });

  it('writes and reads files both ways, bytes intact, and streams stdin into a command', async () => {
    const data = randomBytes(1024 * 1024 + 7);
    await exec.writeFile(join(root, 'mac/blob.bin'), data, 0o600);
    const file = await exec.read(join(root, 'mac/blob.bin'));
    const chunks: Buffer[] = [];
    for await (const c of file!.stream) chunks.push(c as Buffer);
    expect(file!.size).toBe(data.length);
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
    expect(await exec.read(join(root, 'mac/missing'))).toBeNull();
    const piped = await exec.exec('wc -c', { stdin: Readable.from([Buffer.alloc(5000, 1), Buffer.alloc(5000, 2)]), timeoutMs: 20_000 });
    expect(piped.stdout.trim()).toBe('10000');
  });

  it('cancels a command and everything it started on the Mac', async () => {
    const abort = new AbortController();
    const pidFile = join(root, 'mac/step.pid');
    const running = exec.exec('sleep 120 & sleep 121; wait', { pidFile, signal: abort.signal, timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 800));
    abort.abort();
    const res = await running;
    expect(res.stopped).toBe('cancel');
    const pgid = (await fs.readFile(pidFile, 'utf8')).trim();
    const left = execFileSync('bash', ['-c', `pgrep -g ${pgid} || true`]).toString().trim();
    expect(left).toBe('');
  }, 30_000);

  it('holds the Mac to the host key it first saw', async () => {
    const pinFile = join(root, 'other-pin.json');
    await fs.writeFile(pinFile, JSON.stringify({ [`127.0.0.1:${port}`]: 'SHA256:somethingelse' }));
    const other = new SshExecutor({ host: '127.0.0.1', port, user: userInfo().username, privateKey: keys.sshPrivate, pin: new HostKeyPin(pinFile) });
    await expect(other.exec('true', { timeoutMs: 20_000 })).rejects.toThrow("The Mac's SSH host key changed");
    other.close();
  });

  it('says what to do when the Mac does not take the key', async () => {
    const stranger = (await loadKeys(join(root, 'stranger'))).sshPrivate;
    const other = new SshExecutor({ host: '127.0.0.1', port, user: userInfo().username, privateKey: stranger, pin: new HostKeyPin(join(root, 'agent', 'ssh', 'host_key')) });
    await expect(other.exec('true', { timeoutMs: 20_000 })).rejects.toThrow('pubkey >> ~/.ssh/authorized_keys');
    other.close();
  });
});
