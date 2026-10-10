import { execFileSync } from 'child_process';
import { existsSync, promises as fs } from 'fs';
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

/** A keystore made with keytool: JKS when the key password differs from the store password. */
export function makeKeystore(file: string, o: { alias: string; storePass: string; keyPass?: string; cn: string; append?: boolean }): void {
  execFileSync('keytool', [
    '-genkeypair', '-keystore', file, '-storetype', o.keyPass && o.keyPass !== o.storePass ? 'JKS' : 'PKCS12',
    '-storepass', o.storePass, '-keypass', o.keyPass ?? o.storePass, '-alias', o.alias,
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '400', '-dname', `CN=${o.cn}`,
  ], { stdio: 'ignore', env: process.env });
}
