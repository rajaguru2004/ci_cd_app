import { execFileSync } from 'child_process';
import { existsSync, promises as fs, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readConfig, type BuilderConfig } from './config';

/** Helpers for the specs (tsconfig.build.json leaves this file out of the image). */

/** A JDK with jarsigner (the builder image has one; on a laptop, Android Studio's), put first on PATH. */
export function useJdk(): boolean {
  const dirs = [process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin'), '/opt/android-studio/jbr/bin', '/opt/java/openjdk/bin', '/usr/lib/jvm/java-21-openjdk/bin'];
  const dir = dirs.find((d) => d && existsSync(join(d, 'jarsigner')) && existsSync(join(d, 'keytool')));
  if (!dir) return false;
  if (!process.env.PATH?.startsWith(`${dir}:`)) process.env.PATH = `${dir}:${process.env.PATH}`;
  return true;
}

export async function tempConfig(extra: Record<string, string> = {}): Promise<BuilderConfig> {
  const data = await fs.mkdtemp(join(tmpdir(), 'builder-'));
  const scratch = join(data, '.shm');
  await fs.mkdir(scratch);
  return readConfig({ BUILDER_TOKEN: 't'.repeat(40), VAULT_KEY: 'v'.repeat(64), DATA_DIR: data, SCRATCH_DIR: scratch, PLAY_SERVICE_ACCOUNT_FILE: join(data, 'no-play-key.json'), ...extra });
}

/**
 * An Apple-shaped signing certificate made with openssl: a key and a self-signed certificate
 * whose subject reads like Apple's ("CN=Apple Distribution: Acme Ltd (TEAM), OU=TEAM, …").
 */
export function makeAppleCert(dir: string, o: { name?: string; teamId?: string; days?: number; expired?: boolean } = {}): { key: string; cert: string; der: Buffer; sha1: string; name: string } {
  const teamId = o.teamId ?? 'A1B2C3D4E5';
  const name = o.name ?? `Apple Distribution: Acme Ltd (${teamId})`;
  const key = join(dir, `cert-${Math.random().toString(36).slice(2)}.key`);
  const cert = key.replace(/\.key$/, '.pem');
  const validity = o.expired ? ['-not_before', '20200101000000Z', '-not_after', '20210101000000Z'] : ['-days', String(o.days ?? 365)];
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, ...validity, '-subj', `/CN=${name}/OU=${teamId}/O=Acme Ltd/C=US`], { stdio: 'ignore' });
  const der = execFileSync('openssl', ['x509', '-in', cert, '-outform', 'DER']);
  const sha1 = execFileSync('openssl', ['x509', '-in', cert, '-noout', '-fingerprint', '-sha1']).toString().replace(/.*=/, '').replace(/[:\s]/g, '').toUpperCase();
  return { key, cert, der, sha1, name };
}

/** A .p12 of a certificate and its key; `older` uses the 3DES/SHA-1 scheme older Keychain exports use. */
export function makeP12(dir: string, c: { key: string; cert: string }, password: string, older = false): Buffer {
  const out = join(dir, `id-${Math.random().toString(36).slice(2)}.p12`);
  const legacy = older ? ['-certpbe', 'PBE-SHA1-3DES', '-keypbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'] : [];
  execFileSync('openssl', ['pkcs12', '-export', '-inkey', c.key, '-in', c.cert, '-passout', `pass:${password}`, '-out', out, ...legacy], { stdio: 'ignore' });
  return readFileSync(out);
}

/**
 * A provisioning profile the way Apple ships one: an XML plist inside a signed CMS envelope.
 * `type` sets what makes Apple's profiles differ (devices, get-task-allow, all devices).
 */
export function makeProfile(
  dir: string,
  signer: { key: string; cert: string },
  o: { uuid: string; name: string; teamId?: string; appId: string; type?: 'app-store' | 'ad-hoc' | 'development' | 'enterprise'; expires?: Date; certs: Buffer[]; platform?: string },
): Buffer {
  const teamId = o.teamId ?? 'A1B2C3D4E5';
  const type = o.type ?? 'app-store';
  const expires = (o.expires ?? new Date(Date.now() + 300 * 86_400_000)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>AppIDName</key><string>Acme &amp; Co</string>',
    `  <key>ApplicationIdentifierPrefix</key><array><string>${teamId}</string></array>`,
    '  <key>CreationDate</key><date>2026-01-02T03:04:05Z</date>',
    `  <key>Platform</key><array><string>${o.platform ?? 'iOS'}</string></array>`,
    '  <key>DeveloperCertificates</key>',
    `  <array>${o.certs.map((c) => `<data>${c.toString('base64')}</data>`).join('')}</array>`,
    '  <key>Entitlements</key>',
    '  <dict>',
    `    <key>application-identifier</key><string>${teamId}.${o.appId}</string>`,
    `    <key>com.apple.developer.team-identifier</key><string>${teamId}</string>`,
    `    <key>get-task-allow</key><${type === 'development' ? 'true' : 'false'}/>`,
    '    <key>keychain-access-groups</key><array><string>A1B2C3D4E5.*</string></array>',
    '  </dict>',
    `  <key>ExpirationDate</key><date>${expires}</date>`,
    `  <key>Name</key><string>${o.name}</string>`,
    ...(type === 'ad-hoc' || type === 'development' ? ['  <key>ProvisionedDevices</key><array><string>00008110-000A1B2C3D4E5F6A</string></array>'] : []),
    ...(type === 'enterprise' ? ['  <key>ProvisionsAllDevices</key><true/>'] : []),
    `  <key>TeamIdentifier</key><array><string>${teamId}</string></array>`,
    '  <key>TeamName</key><string>Acme Ltd</string>',
    '  <key>TimeToLive</key><integer>365</integer>',
    `  <key>UUID</key><string>${o.uuid}</string>`,
    '  <key>Version</key><integer>1</integer>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  const plist = join(dir, `${o.uuid}.plist`);
  const out = join(dir, `${o.uuid}.mobileprovision`);
  writeFileSync(plist, xml);
  execFileSync('openssl', ['cms', '-sign', '-nodetach', '-binary', '-outform', 'DER', '-in', plist, '-signer', signer.cert, '-inkey', signer.key, '-out', out], { stdio: 'ignore' });
  return readFileSync(out);
}

/** The pbxproj lines Flutter writes for a Runner target (and its test target). */
export function pbxproj(bundleId: string, extra: string[] = []): string {
  return [
    '// !$*UTF8*$!',
    '{',
    '\tobjects = {',
    `\t\t97C147071CF9000F007C117D /* Release */ = {\n\t\t\tbuildSettings = {\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${bundleId};\n\t\t\t};\n\t\t};`,
    `\t\t331C8088294A63A400263BE5 /* Release */ = {\n\t\t\tbuildSettings = {\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = "${bundleId}.RunnerTests";\n\t\t\t};\n\t\t};`,
    ...extra.map((id) => `\t\tAAAA /* Release */ = {\n\t\t\tbuildSettings = {\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${id};\n\t\t\t};\n\t\t};`),
    '\t};',
    '}',
    '',
  ].join('\n');
}

/** A keystore made with keytool: JKS when the key password differs from the store password. */
export function makeKeystore(file: string, o: { alias: string; storePass: string; keyPass?: string; cn: string; append?: boolean }): void {
  execFileSync('keytool', [
    '-genkeypair', '-keystore', file, '-storetype', o.keyPass && o.keyPass !== o.storePass ? 'JKS' : 'PKCS12',
    '-storepass', o.storePass, '-keypass', o.keyPass ?? o.storePass, '-alias', o.alias,
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '400', '-dname', `CN=${o.cn}`,
  ], { stdio: 'ignore', env: process.env });
}
