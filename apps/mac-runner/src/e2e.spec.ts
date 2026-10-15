import { execFileSync } from 'child_process';
import { generateKeyPairSync } from 'crypto';
import { existsSync, promises as fs } from 'fs';
import { createServer, request, type Server } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { boot, createApp, type Deps } from '../../builder/src/main';
import { MacPool } from '../../builder/src/macs';
import { makeAppleCert, makeP12, makeProfile, pbxproj, tempConfig, useJdk } from '../../builder/src/testing';
import type { RunRecord } from '../../builder/src/types';
import { Agent } from './agent';
import { readConfig } from './config';
import { fakeMac } from './testing';

/**
 * An iOS release end to end, with the real parts: the console's builder (its routes, its Mac
 * pool, the iOS plan and the work order it seals), a stand-in of the console API's gateway hop
 * (it adds the builder token, as apps/api does), the real agent, and the real steps' bash run
 * against a stand-in Mac (testing.ts) and a stand-in App Store Connect. The release goes from a
 * source ZIP to TestFlight; a second run is cancelled while its tests run on the "Mac".
 */

const hasJdk = useJdk();
const maybe = hasJdk && existsSync('/usr/bin/python3') ? describe : describe.skip;
const TOKEN = 't'.repeat(40);
const PASSWORD = 'p12 pass phrase';

let deps: Deps;
let builder: Server;
let gateway: Server;
let asc: Server;
let agent: Agent;
let root = '';
let mac: ReturnType<typeof fakeMac>;
const savedHome = process.env.HOME;
let p8 = '';

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`http://127.0.0.1:${(builder.address() as AddressInfo).port}${path}`, {
    method,
    headers: { 'x-builder-token': TOKEN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const runOf = async (id: number) => (await call<RunRecord>('GET', `/runs/${id}`)).data;

beforeAll(async () => {
  if (!hasJdk) return;
  root = await fs.mkdtemp(join(tmpdir(), 'rc-mac-e2e-'));
  await fs.mkdir(join(root, 'home'));
  MacPool.pollMs = 1000;
  MacPool.tickMs = 200;

  // The app's signing, the way Apple hands it out.
  const dist = makeAppleCert(root);
  const signer = makeAppleCert(root, { name: 'Apple iPhone OS Provisioning Profile Signing' });
  const uuid = '1B4D2C3E-5F60-4718-9A2B-3C4D5E6F7A8B';
  const profile = makeProfile(root, signer, { uuid, name: 'Acme App Store', appId: 'com.acme.app', certs: [dist.der] });
  p8 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  mac = fakeMac(join(root, 'mac'), { certDer: dist.der, certSha1: dist.sha1, certName: dist.name, teamId: 'A1B2C3D4E5', profile });

  // App Store Connect: the app exists and its highest build is 41.
  asc = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://asc');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (u.pathname === '/v1/apps') return res.end(JSON.stringify({ data: [{ type: 'apps', id: '6449012345', attributes: { name: 'Acme', bundleId: 'com.acme.app' } }] }));
    res.end(JSON.stringify({ data: [{ type: 'builds', id: 'b1', attributes: { version: '41', uploadedDate: '2026-10-01T10:00:00Z', processingState: 'VALID', expired: false } }] }));
  });
  await new Promise<void>((r) => asc.listen(0, '127.0.0.1', r));

  const cfg = await tempConfig({
    PIPELINE_DIR: join(__dirname, '..', '..', '..', 'mobile-pipeline'),
    MAC_RUNNER_DIR: join(__dirname, '..'),
    APP_STORE_API_URL: `http://127.0.0.1:${(asc.address() as AddressInfo).port}`,
  });
  deps = await boot(cfg);
  builder = createApp(deps).listen(0, '127.0.0.1');
  await new Promise((r) => builder.once('listening', r));

  // What apps/api does for /api/runner/v1/*: the same request, plus the builder token.
  gateway = createServer((req, res) => {
    const up = request(
      { host: '127.0.0.1', port: (builder.address() as AddressInfo).port, path: (req.url ?? '').replace(/^\/api/, ''), method: req.method, headers: { ...req.headers, 'x-builder-token': TOKEN } },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    res.on('close', () => !res.writableFinished && up.destroy());
    req.pipe(up);
  });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));

  // The app, its iOS side, its keys.
  expect((await call('POST', '/apps', { name: 'Acme App', packageName: 'com.acme.app' })).status).toBe(201);
  expect((await call('PUT', '/apps/acme-app/ios', { bundleId: 'com.acme.app' })).status).toBe(200);
  const cert = await call<{ message?: string }>('PUT', '/apps/acme-app/ios/certificate', { p12: makeP12(root, dist, PASSWORD).toString('base64'), password: PASSWORD, fileName: 'dist.p12' });
  expect(cert).toMatchObject({ status: 200 });
  expect((await call('POST', '/apps/acme-app/ios/profiles', { data: profile.toString('base64'), fileName: 'Acme.mobileprovision' })).status).toBe(201);
  const key = await call<{ ios: { appStore: { appName: string } } }>('PUT', '/apps/acme-app/ios/app-store', { keyId: 'ABCDE12345', issuerId: '69a6de70-03db-47e3-e053-5b8c7c11a4d1', p8 });
  expect(key.data.ios.appStore.appName).toBe('Acme');
}, 120_000);

afterAll(async () => {
  await agent?.stop('the spec ended');
  await deps?.runner.drain();
  await Promise.all([builder, gateway, asc].filter(Boolean).map((s) => new Promise((r) => s.close(r))));
  process.env.HOME = savedHome;
});

/** A Flutter project with an iOS side, as GitHub's Download ZIP packs it. */
async function sourceZip(name: string): Promise<string> {
  const src = join(root, `src-${name}`);
  const top = join(src, 'acme-app-main');
  await fs.mkdir(join(top, 'ios/Runner.xcodeproj'), { recursive: true });
  await fs.mkdir(join(top, 'test'), { recursive: true });
  await fs.mkdir(join(top, 'lib'), { recursive: true });
  await fs.writeFile(join(top, 'pubspec.yaml'), 'name: acme_app\nversion: 1.2.3+7\ndependencies:\n  flutter:\n    sdk: flutter\n');
  await fs.writeFile(join(top, 'ios/Runner.xcodeproj/project.pbxproj'), pbxproj('com.acme.app'));
  await fs.writeFile(join(top, 'lib/main.dart'), 'void main() {}\n');
  await fs.writeFile(join(top, 'test/widget_test.dart'), 'void main() {}\n');
  const upload = `${name}.zip`;
  execFileSync('zip', ['-qr', join(deps.cfg.dataDir, 'uploads', upload), 'acme-app-main'], { cwd: src });
  return upload;
}

maybe('an iOS run on a Mac runner, end to end', () => {
  it('refuses an iOS run while no Mac is set up', async () => {
    const res = await call<{ message: string }>('POST', '/runs', { app: 'acme-app', source: { kind: 'zip', upload: await sourceZip('early'), fileName: 'early.zip' }, params: { platform: 'ios', mode: 'build' } });
    expect(res.status).toBe(409);
    expect(res.data.message).toContain('No Mac runner is set up yet');
  });

  it('connects a Mac, which then builds, signs and uploads a release to TestFlight', async () => {
    const made = await call<{ token: string; runner: { id: string } }>('POST', '/macs', { name: 'Test Mac' });
    expect(made.status).toBe(201);
    process.env.HOME = join(root, 'home');
    process.env.RC_PLISTBUDDY = mac.plistBuddy;
    process.env.RUNNER_QUIET = '1';
    agent = new Agent(
      readConfig({
        SERVER_URL: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
        RUNNER_TOKEN: made.data.token,
        EXECUTOR: 'local',
        MAC_WORK_DIR: join(root, 'work'),
        MAC_PATH_PREFIX: mac.bin,
        DATA_DIR: join(root, 'agent'),
        RUNNER_VERSION: 'spec',
      }),
    );
    void agent.start();

    // The console sees the Mac, ready, with what the agent found on it.
    let seen: unknown = null;
    const ready = await until('the Mac to be ready', async () => {
      const r = (await call<{ runners: Array<{ state: string; host: { xcode: string; flutter: string; problems: string[] } | null; keyFingerprint: string | null }> }>('GET', '/macs')).data.runners[0];
      seen = r;
      return r?.state === 'idle' ? r : null;
    }, 30_000).catch((e: Error) => {
      throw new Error(`${e.message}: ${JSON.stringify(seen)}`);
    });
    expect(ready.host).toMatchObject({ xcode: 'Xcode 16.4 (16F6)', flutter: '3.35.1 (stable)', problems: [] });
    expect(ready.keyFingerprint).toMatch(/^SHA256:/);

    const started = await call<RunRecord>('POST', '/runs', {
      app: 'acme-app',
      source: { kind: 'zip', upload: await sourceZip('release'), fileName: 'release.zip' },
      params: { platform: 'ios', mode: 'release', track: 'testflight', releaseNotes: 'Payslips offline.' },
    });
    expect(started.status).toBe(202);
    expect(started.data.runner).toBe('mac');
    expect(started.data.jobs.map((j) => j.name)).toEqual(['Plan', 'Tests', 'Signed IPA', 'App Store Connect']);

    const done = await until('the run to end', async () => {
      const r = await runOf(started.data.id);
      return r.status === 'completed' ? r : null;
    });
    const steps = (name: string) => done.jobs.find((j) => j.name === name)!.steps.map((s) => `${s.name}:${s.conclusion}`);
    if (done.conclusion !== 'success') {
      const said = await Promise.all(done.jobs.map((j) => fs.readFile(join(deps.store.dir(done.id), 'logs', `${j.id}.log`), 'utf8').catch(() => '')));
      throw new Error(`The run failed: ${done.error ?? ''}\n${done.jobs.map((j, i) => `${j.name}: ${j.steps.map((s) => `${s.name}=${s.conclusion}`).join(', ')}\n${said[i].split('\n').filter((l) => /##\[error\]|Verify|verify|signature|Bundle |Profile:/.test(l)).join('\n')}`).join('\n')}`);
    }
    expect({ conclusion: done.conclusion, error: done.error }).toEqual({ conclusion: 'success', error: null });
    expect(done.jobs.map((j) => j.conclusion)).toEqual(['success', 'success', 'success', 'success']);
    expect(steps('Signed IPA')).toEqual([
      'Set up job:success',
      'Set up Xcode:success',
      'Prepare Fastlane:success',
      'Set up Ruby and Fastlane:success',
      'Install signing:success',
      'Build IPA:success',
      'Save IPA:success',
      'Verify signature:success',
      'Remove signing:success',
      'Complete job:success',
    ]);
    expect(done.remote).toMatchObject({ kind: 'mac', state: 'done', runnerName: 'Test Mac' });
    // Build number above App Store Connect's highest (41), not pubspec's 7.
    expect(done.plan).toMatchObject({ platform: 'ios', versionName: '1.2.3', versionCode: 42, packageName: 'com.acme.app' });

    // What the Mac sent back.
    const art = join(deps.store.dir(done.id), 'artifacts');
    const info = JSON.parse(await fs.readFile(join(art, 'build-info/build-info.json'), 'utf8'));
    expect(info).toMatchObject({ platform: 'ios', bundleId: 'com.acme.app', versionName: '1.2.3', versionCode: 42, teamId: 'A1B2C3D4E5', profile: { name: 'Acme App Store' }, usesNonExemptEncryption: false });
    expect((await fs.stat(join(art, 'app-release-ipa/app-release.ipa'))).size).toBeGreaterThan(100);
    expect(existsSync(join(art, 'app-release-ipa/dSYMs.zip'))).toBe(true);
    expect(existsSync(join(art, 'test-results/flutter-test.json'))).toBe(true);
    expect(JSON.parse(await fs.readFile(join(art, 'store-release/release-info.json'), 'utf8'))).toMatchObject({ destination: 'testflight', versionCode: 42 });

    // The logs are the Mac's, and no secret is in them.
    const logs = (await Promise.all(done.jobs.map((j) => fs.readFile(join(deps.store.dir(done.id), 'logs', `${j.id}.log`), 'utf8')))).join('\n');
    expect(logs).toContain('##[group]Run flutter build ipa');
    expect(logs).toContain('Test Mac took the run');
    expect(logs).toContain('Uploaded to TestFlight; What to Test: Payslips offline.');
    expect(logs).not.toContain(PASSWORD);
    expect(logs).not.toContain(p8.split('\n')[1]);

    // The Mac is as it was: the run's folder, its keychain and its profiles are gone, the search list restored.
    expect(existsSync(join(root, 'work/runs', String(done.id)))).toBe(false);
    expect(await fs.readFile(join(mac.state, 'keychains'), 'utf8')).toContain('login.keychain-db');
    expect(existsSync(join(root, 'home/Library/MobileDevice/Provisioning Profiles'))).toBe(true);
    expect(await fs.readdir(join(root, 'home/Library/MobileDevice/Provisioning Profiles'))).toEqual([]);
  }, 180_000);

  it('cancels a run on the Mac: the running step’s processes stop, cleanup still runs', async () => {
    await fs.writeFile(join(mac.state, 'slow'), '1');
    const started = await call<RunRecord>('POST', '/runs', {
      app: 'acme-app',
      source: { kind: 'zip', upload: await sourceZip('cancel'), fileName: 'cancel.zip' },
      params: { platform: 'ios', mode: 'build' },
    });
    const pid = Number(await until('the tests to start on the Mac', () => fs.readFile(join(mac.state, 'slow.pid'), 'utf8').catch(() => null)));
    expect((await call('POST', `/runs/${started.data.id}/cancel`)).status).toBe(202);
    const done = await until('the run to end', async () => {
      const r = await runOf(started.data.id);
      return r.status === 'completed' ? r : null;
    });
    await fs.rm(join(mac.state, 'slow'), { force: true });
    expect(done.conclusion).toBe('cancelled');
    const tests = done.jobs.find((j) => j.name === 'Tests')!;
    expect(tests.steps.find((s) => s.name === 'Unit and widget tests')?.conclusion).toBe('cancelled');
    expect(tests.steps.find((s) => s.name === 'Complete job')?.conclusion).toBe('success');
    expect(done.jobs.find((j) => j.name === 'Signed IPA')?.conclusion).toBe('cancelled');
    // The stand-in flutter (and its sleep) went with its process group.
    expect(() => process.kill(pid, 0)).toThrow();
  }, 120_000);
});
