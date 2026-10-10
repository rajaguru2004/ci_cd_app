import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JobLog } from './log';
import { bundleSigner, checkUploadKey, resignBundle, throwawayKeystore } from './signing';
import { makeKeystore, useJdk } from './testing';

const jdk = useJdk();
const maybe = jdk ? describe : describe.skip;
if (!jdk) console.warn('signing specs skipped: no JDK with jarsigner (set JAVA_HOME)');

async function dir() {
  return fs.mkdtemp(join(tmpdir(), 'signing-'));
}

maybe('checkUploadKey', () => {
  it('reads the certificate of the only key, and of a named one', async () => {
    const d = await dir();
    const ks = join(d, 'upload.jks');
    makeKeystore(ks, { alias: 'upload', storePass: 'store-pass', cn: 'PrithiyaC' });
    const one = await checkUploadKey({ keystore: await fs.readFile(ks), storePassword: 'store-pass', keyAlias: '', keyPassword: '' }, d);
    expect(one.alias).toBe('upload');
    expect(one.certificate.owner).toBe('CN=PrithiyaC');
    expect(one.certificate.sha256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(Date.parse(one.certificate.validUntil)).toBeGreaterThan(Date.now());
  });

  it('says which password is wrong, and asks for the alias when there are several keys', async () => {
    const d = await dir();
    const ks = join(d, 'two.jks');
    makeKeystore(ks, { alias: 'upload', storePass: 'store-pass', keyPass: 'key-pass', cn: 'Upload' });
    makeKeystore(ks, { alias: 'other', storePass: 'store-pass', keyPass: 'key-pass', cn: 'Other' });
    const keystore = await fs.readFile(ks);
    await expect(checkUploadKey({ keystore, storePassword: 'nope', keyAlias: 'upload', keyPassword: 'key-pass' }, d)).rejects.toThrow('The keystore password is wrong.');
    await expect(checkUploadKey({ keystore, storePassword: 'store-pass', keyAlias: '', keyPassword: 'key-pass' }, d)).rejects.toThrow(/holds 2 keys \((upload, other|other, upload)\)/);
    await expect(checkUploadKey({ keystore, storePassword: 'store-pass', keyAlias: 'missing', keyPassword: 'key-pass' }, d)).rejects.toThrow("no key 'missing'");
    await expect(checkUploadKey({ keystore, storePassword: 'store-pass', keyAlias: 'upload', keyPassword: 'wrong' }, d)).rejects.toThrow("The key password for 'upload' is wrong.");
    expect((await checkUploadKey({ keystore, storePassword: 'store-pass', keyAlias: 'UPLOAD', keyPassword: 'key-pass' }, d)).certificate.owner).toBe('CN=Upload');
  });

  it('refuses a file that is not a keystore', async () => {
    const d = await dir();
    await expect(checkUploadKey({ keystore: Buffer.from('not a keystore at all'), storePassword: 'x', keyAlias: '', keyPassword: '' }, d)).rejects.toThrow(
      /not a Java keystore|password is wrong/,
    );
  });
});

maybe('resignBundle', () => {
  it("replaces Gradle's throwaway signature with the upload key's, keeping the modules' own META-INF", async () => {
    const d = await dir();
    await fs.mkdir(join(d, 'b/base/root/META-INF'), { recursive: true });
    await fs.mkdir(join(d, 'b/base/dex'), { recursive: true });
    await fs.writeFile(join(d, 'b/base/root/META-INF/androidx.core_core.version'), '1.0');
    await fs.writeFile(join(d, 'b/base/dex/classes.dex'), 'dex');
    await fs.writeFile(join(d, 'b/BundleConfig.pb'), 'pb');
    const aab = join(d, 'app-release.aab');
    execFileSync('zip', ['-q', '-r', aab, '.'], { cwd: join(d, 'b') });
    const tw = await throwawayKeystore(join(d, 'tw'));
    // Jest's process.env is a copy: the JDK put on PATH reaches a child only when passed along.
    execFileSync('jarsigner', ['-keystore', tw.file, '-storepass', tw.password, aab, tw.alias], { stdio: 'ignore', env: process.env });
    expect((await bundleSigner(aab)).owner).toBe('CN=Release Console throwaway');

    const ks = join(d, 'upload.jks');
    makeKeystore(ks, { alias: 'upload', storePass: 'store-pass', keyPass: 'key-pass', cn: 'Real Upload Key' });
    const log = new JobLog(join(d, 'job.log'));
    await resignBundle(aab, { keystore: await fs.readFile(ks), storePassword: 'store-pass', keyAlias: 'upload', keyPassword: 'key-pass' }, d, log);
    await log.close();
    const signer = await bundleSigner(aab);
    expect(signer.owner).toBe('CN=Real Upload Key');
    expect(signer.debug).toBe(false);
    const listing = execFileSync('unzip', ['-l', aab]).toString();
    expect(listing).toContain('base/root/META-INF/androidx.core_core.version');
    expect(listing).not.toMatch(/THROWAWA\.(SF|RSA)/);
    expect(await fs.readFile(join(d, 'job.log'), 'utf8')).toContain('jar verified');
    // No decrypted keystore is left behind.
    expect((await fs.readdir(d)).filter((n) => n.startsWith('rc-'))).toEqual([]);
  });
});
