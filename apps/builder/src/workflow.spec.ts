import { execFileSync, spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { REMOTE_STEPS } from './pipeline';
import { makeKeystore, useJdk } from './testing';
import { loadWorkflow, REMOTE_JOBS, SCRIPTS, SECRETS, workflowYaml } from './workflow';

/**
 * The workflow the console writes into repositories: its shape (jobs and steps under the names
 * the console maps onto stages), and its signing scripts run for real, the way GitHub runs a
 * `run:` step (`bash -eo pipefail`), with keytool, jarsigner, zip and jq.
 */

const pipelineDir = join(__dirname, '..', '..', '..', 'mobile-pipeline');
const jdk = useJdk();
const hasPython = spawnSync('python3', ['-c', 'import yaml'], { env: process.env }).status === 0;

function parse(yaml: string): { jobs: Record<string, { name: string; steps: Array<{ name: string; run?: string; if?: string }>; needs?: string; if?: string }> } {
  const out = execFileSync('python3', ['-c', 'import json,sys,yaml; print(json.dumps(yaml.safe_load(sys.stdin.read()), default=str))'], { input: yaml, env: process.env });
  return JSON.parse(out.toString());
}

function bash(script: string, cwd: string, env: Record<string, string>) {
  return spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
}

(hasPython ? describe : describe.skip)('the workflow file', () => {
  it('has the jobs and steps the console mirrors, in order', async () => {
    const wf = parse(await loadWorkflow(pipelineDir));
    const jobs = Object.values(wf.jobs);
    expect(jobs.map((j) => j.name)).toEqual([...REMOTE_JOBS]);
    for (const job of jobs) {
      // GitHub adds "Set up job" and "Complete job" around the steps a workflow names.
      const expected = REMOTE_STEPS[job.name as (typeof REMOTE_JOBS)[number]].filter((s) => s !== 'Set up job' && s !== 'Complete job');
      expect(job.steps.map((s) => s.name)).toEqual(expected);
    }
    expect(wf.jobs.play.if).toContain("mode == 'release'");
  });

  it('carries the Fastlane lanes inside, and refuses lanes it could not embed safely', async () => {
    const yaml = await loadWorkflow(pipelineDir);
    const fastfile = await fs.readFile(join(pipelineDir, 'fastlane', 'Fastfile'), 'utf8');
    const prepare = parse(yaml).jobs.play.steps[0].run!;
    expect(prepare).toContain(fastfile.trimEnd());
    expect(yaml).toMatch(/gem install fastlane --no-document -v '\d+\.\d+\.\d+'/);
    expect(() => workflowYaml({ fastfile: 'lane :x do\n  puts "${{ secrets.X }}"\nend', appfile: '', fastlaneVersion: '1.0.0' })).toThrow(/cannot be embedded/);
  });

  it('never puts an input straight into a script', async () => {
    const wf = parse(await loadWorkflow(pipelineDir));
    for (const job of Object.values(wf.jobs)) for (const step of job.steps) if (step.run) expect(step.run).not.toContain('${{');
  });
});

(jdk ? describe : describe.skip)('the Sign AAB scripts', () => {
  async function bundle() {
    const d = await fs.mkdtemp(join(tmpdir(), 'wf-sign-'));
    await fs.mkdir(join(d, 'b/base/root/META-INF'), { recursive: true });
    await fs.mkdir(join(d, 'b/base/dex'), { recursive: true });
    await fs.writeFile(join(d, 'b/base/root/META-INF/androidx.core_core.version'), '1.0');
    await fs.writeFile(join(d, 'b/base/dex/classes.dex'), 'dex');
    await fs.writeFile(join(d, 'b/BundleConfig.pb'), 'pb');
    await fs.mkdir(join(d, 'work/dist/bundle/release'), { recursive: true });
    const aab = join(d, 'work/dist/bundle/release/app-release.aab');
    execFileSync('zip', ['-q', '-r', aab, '.'], { cwd: join(d, 'b'), env: process.env });
    // What Signed AAB hands over: signed by the job's throwaway key.
    makeKeystore(join(d, 'throwaway.p12'), { alias: 'throwaway', storePass: 'throwaway-pass', cn: 'Release Console throwaway' });
    execFileSync('jarsigner', ['-keystore', join(d, 'throwaway.p12'), '-storepass', 'throwaway-pass', aab, 'throwaway'], { stdio: 'ignore', env: process.env });
    makeKeystore(join(d, 'upload.jks'), { alias: 'upload', storePass: 'store-pass', keyPass: 'key-pass', cn: 'Real Upload Key' });
    const list = execFileSync('keytool', ['-list', '-v', '-keystore', join(d, 'upload.jks'), '-storepass', 'store-pass', '-alias', 'upload'], { env: { ...process.env, TZ: 'UTC' } }).toString();
    const cert = /SHA256: (\S+)/.exec(list)![1];
    await fs.mkdir(join(d, 'tmp'));
    return { d, aab, cert, work: join(d, 'work') };
  }

  const verifyEnv = (d: string, expected: string) => ({
    RUNNER_TEMP: join(d, 'tmp'),
    RC_SIGNING: 'console',
    RC_EXPECTED: expected,
    RC_COMMIT: 'a'.repeat(40),
    RC_REF: 'main',
    RC_PACKAGE: 'com.example.demo',
    VERSION_NAME: '1.2.3',
    VERSION_CODE: '1011',
  });

  it('re-signs with the upload key, keeps the modules’ META-INF, and records build-info.json', async () => {
    const { d, aab, cert, work } = await bundle();
    const keystore = (await fs.readFile(join(d, 'upload.jks'))).toString('base64');
    const signed = bash(SCRIPTS.sign, work, { RUNNER_TEMP: join(d, 'tmp'), RC_KEYSTORE: keystore, RC_STOREPASS: 'store-pass', RC_KEY_ALIAS: 'upload', RC_KEYPASS: 'key-pass' });
    expect(signed.stdout + signed.stderr).toContain("Signed with 'upload' and verified.");
    expect(signed.status).toBe(0);
    // The decrypted keystore does not outlive the step.
    expect(await fs.readdir(join(d, 'tmp'))).toEqual(['verify.txt']);
    const listing = execFileSync('unzip', ['-l', aab], { env: process.env }).toString();
    expect(listing).toContain('base/root/META-INF/androidx.core_core.version');
    expect(listing).not.toMatch(/THROWAWA\.(SF|RSA)/);

    const verified = bash(SCRIPTS.verify, work, verifyEnv(d, cert.toLowerCase()));
    expect(verified.status).toBe(0);
    const info = JSON.parse(await fs.readFile(join(d, 'tmp/rc-info/build-info.json'), 'utf8'));
    expect(info).toMatchObject({ versionName: '1.2.3', versionCode: 1011, signer: 'CN=Real Upload Key', certSha256: cert, signedBy: 'console', packageName: 'com.example.demo', ref: 'main' });
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60000);

  it('stops on a bundle signed by another key, and on missing secrets', async () => {
    const { d, work } = await bundle();
    const wrong = bash(SCRIPTS.verify, work, verifyEnv(d, 'AB:'.repeat(31) + 'AB'));
    expect(wrong.status).toBe(1);
    expect(wrong.stdout).toContain('::error title=Signing::The bundle is signed by CN=Release Console throwaway, not by the upload key stored for the app.');

    const missing = bash(SCRIPTS.sign, work, { RUNNER_TEMP: join(d, 'tmp'), RC_KEYSTORE: '', RC_STOREPASS: '', RC_KEY_ALIAS: '', RC_KEYPASS: '' });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain(`This repository has no ${SECRETS.keystore} secrets`);
  }, 60000);

  it('writes the release notes where Fastlane reads them', async () => {
    const d = await fs.mkdtemp(join(tmpdir(), 'wf-notes-'));
    const res = bash(SCRIPTS.notes, d, { NOTES: 'Faster check-in.\nPayslips offline.', VERSION_CODE: '1011' });
    expect(res.status).toBe(0);
    expect(await fs.readFile(join(d, 'fastlane/metadata/android/en-US/changelogs/1011.txt'), 'utf8')).toBe('Faster check-in.\nPayslips offline.\n');
  });
});
