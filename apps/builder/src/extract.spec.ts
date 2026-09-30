import { promises as fs } from 'fs';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { tmpdir } from 'os';
import { join } from 'path';
import { ExtractError, extractZip, pubspecVersion, zipCommit } from './extract';

const SHA = 'c8a98f9f49e4ca5033f0dd4696862d247fd6c8f2';
const LIMITS = { maxBytes: 10 * 1024 * 1024, maxEntries: 1000 };
const unix = (mode: number) => ({ os: 3, attrs: (mode << 16) >>> 0 });

/** Appends an archive comment the way GitHub and `git archive` do (the commit id). */
function withComment(zip: Uint8Array, comment: string): Buffer {
  const c = Buffer.from(comment, 'utf8');
  const out = Buffer.concat([Buffer.from(zip), c]);
  // End-of-central-directory record: the comment length is its last two bytes.
  out.writeUInt16LE(c.length, zip.length - 2);
  return out;
}

async function tmp(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'extract-'));
}

async function zipFile(files: Zippable, comment?: string): Promise<string> {
  const dir = await tmp();
  const file = join(dir, 'upload.zip');
  const bytes = zipSync(files);
  await fs.writeFile(file, comment ? withComment(bytes, comment) : Buffer.from(bytes));
  return file;
}

describe('zipCommit', () => {
  it('reads the commit from the comment without unpacking, and null without one or for a non-ZIP', async () => {
    const sha = 'a2d8a3f3e71822d6c564cc1576e6c02e0e6d1196';
    expect(await zipCommit(await zipFile({ 'app/pubspec.yaml': strToU8('name: app') }, sha))).toBe(sha);
    expect(await zipCommit(await zipFile({ 'pubspec.yaml': strToU8('name: app') }))).toBeNull();
    const notZip = join(await tmp(), 'x.zip');
    await fs.writeFile(notZip, 'not a zip');
    expect(await zipCommit(notZip)).toBeNull();
  });
});

describe('extractZip', () => {
  it('unpacks a GitHub "Download ZIP" archive: one top folder, the commit id in the comment', async () => {
    const zip = await zipFile(
      {
        'human-resource-management-mobile-ess-main/': new Uint8Array(),
        'human-resource-management-mobile-ess-main/pubspec.yaml': strToU8('name: ess_portal\nversion: 1.0.1+9\n'),
        'human-resource-management-mobile-ess-main/lib/main.dart': strToU8('void main() {}\n'),
        'human-resource-management-mobile-ess-main/android/gradlew': [strToU8('#!/bin/sh\n'), unix(0o100755)],
      },
      SHA,
    );
    const dest = await tmp();
    const x = await extractZip(zip, dest, LIMITS);
    expect(x).toMatchObject({ sha: SHA, rootName: 'human-resource-management-mobile-ess-main', files: 3 });
    expect(x.projectDir).toBe(join(dest, 'human-resource-management-mobile-ess-main'));
    expect(await pubspecVersion(x.projectDir)).toBe('1.0.1');
    const mode = (await fs.stat(join(x.projectDir, 'android/gradlew'))).mode & 0o777;
    expect(mode & 0o111).not.toBe(0);
  });

  it('accepts pubspec.yaml at the top and a ZIP with no comment', async () => {
    const zip = await zipFile({ 'pubspec.yaml': strToU8('version: 2.0.0\n') });
    const dest = await tmp();
    const x = await extractZip(zip, dest, LIMITS);
    expect(x).toMatchObject({ sha: null, rootName: '', projectDir: dest });
  });

  it('refuses an entry that climbs out of the destination', async () => {
    const zip = await zipFile({ 'pubspec.yaml': strToU8('x'), '../escaped.txt': strToU8('pwned') });
    const dest = await tmp();
    await expect(extractZip(zip, dest, LIMITS)).rejects.toBeInstanceOf(ExtractError);
    await expect(fs.access(join(dest, '..', 'escaped.txt'))).rejects.toThrow();
  });

  it('does not create symbolic links', async () => {
    const zip = await zipFile({
      'app/pubspec.yaml': strToU8('version: 1.0.0\n'),
      'app/link': [strToU8('/etc/passwd'), unix(0o120777)],
    });
    const dest = await tmp();
    const x = await extractZip(zip, dest, LIMITS);
    expect(x.skippedLinks).toBe(1);
    await expect(fs.lstat(join(dest, 'app/link'))).rejects.toThrow();
  });

  it('stops a ZIP that expands past the size limit', async () => {
    const zip = await zipFile({ 'pubspec.yaml': strToU8('x'), 'big.bin': new Uint8Array(2 * 1024 * 1024) });
    await expect(extractZip(zip, await tmp(), { maxBytes: 1024 * 1024, maxEntries: 10 })).rejects.toThrow('expands to more than 1 MB');
  });

  it('stops a ZIP with too many entries', async () => {
    const files: Zippable = { 'pubspec.yaml': strToU8('x') };
    for (let i = 0; i < 20; i += 1) files[`f${i}.txt`] = strToU8('x');
    await expect(extractZip(await zipFile(files), await tmp(), { maxBytes: 1e9, maxEntries: 10 })).rejects.toThrow('more than 10 files');
  });

  it('explains a ZIP that is not the app', async () => {
    const zip = await zipFile({ 'README.md': strToU8('hello') });
    await expect(extractZip(zip, await tmp(), LIMITS)).rejects.toThrow('no pubspec.yaml');
  });

  it('explains a file that is not a ZIP at all', async () => {
    const dir = await tmp();
    await fs.writeFile(join(dir, 'x.zip'), 'not a zip');
    await expect(extractZip(join(dir, 'x.zip'), await tmp(), LIMITS)).rejects.toThrow('not a readable ZIP');
  });
});
