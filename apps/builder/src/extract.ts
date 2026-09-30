import { createWriteStream, promises as fs } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { pipeline } from 'stream/promises';
import yauzl from 'yauzl';

/**
 * Unpacks an uploaded source ZIP (GitHub's Code → Download ZIP, or `git archive`) safely:
 * no path may leave the destination, links are not created, and the total size and entry
 * count are capped, because the file comes from a browser upload.
 */

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

export interface Extracted {
  /** The commit GitHub and `git archive` record in the ZIP comment; null when there is none. */
  sha: string | null;
  /** Absolute path of the folder that holds pubspec.yaml. */
  projectDir: string;
  /** That folder relative to the ZIP root ('' when pubspec.yaml is at the top). */
  rootName: string;
  files: number;
  bytes: number;
  skippedLinks: number;
}

export interface ExtractLimits {
  maxBytes: number;
  maxEntries: number;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const SHA = /\b([0-9a-f]{40})\b/;

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((ok, fail) =>
    yauzl.open(path, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) =>
      err || !zip ? fail(new ExtractError(`That file is not a readable ZIP (${err?.message ?? 'no data'}).`)) : ok(zip),
    ),
  );
}

function readStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((ok, fail) => zip.openReadStream(entry, (err, stream) => (err || !stream ? fail(err) : ok(stream))));
}

/**
 * The commit recorded in the ZIP comment, read from the end of the file without unpacking
 * anything, so a queued run already sits on its commit; null when absent or unreadable.
 */
export async function zipCommit(zipPath: string): Promise<string | null> {
  try {
    const zip = await openZip(zipPath);
    const sha = SHA.exec(zip.comment ?? '')?.[1] ?? null;
    zip.close();
    return sha;
  } catch {
    return null;
  }
}

export async function extractZip(zipPath: string, destDir: string, limits: ExtractLimits): Promise<Extracted> {
  const dest = resolve(destDir);
  await fs.mkdir(dest, { recursive: true });
  const zip = await openZip(zipPath);
  const sha = SHA.exec(zip.comment ?? '')?.[1] ?? null;

  let files = 0;
  let bytes = 0;
  let entries = 0;
  let skippedLinks = 0;

  await new Promise<void>((done, fail) => {
    const failWith = (e: unknown) => {
      try {
        zip.close();
      } catch {
        /* already closed */
      }
      fail(e instanceof ExtractError ? e : new ExtractError(`The ZIP could not be unpacked (${(e as Error).message}).`));
    };
    zip.on('error', failWith);
    zip.on('end', () => done());
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        entries += 1;
        if (entries > limits.maxEntries) throw new ExtractError(`The ZIP holds more than ${limits.maxEntries} files.`);
        const name = entry.fileName;
        // macOS adds these when a folder is compressed in Finder; they are not source.
        if (name.startsWith('__MACOSX/')) return zip.readEntry();

        const target = resolve(dest, name);
        if (target !== dest && !target.startsWith(dest + sep)) {
          throw new ExtractError(`The ZIP tries to write outside its folder (${name}).`);
        }
        if (name.endsWith('/')) {
          await fs.mkdir(target, { recursive: true });
          return zip.readEntry();
        }
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & S_IFMT) === S_IFLNK) {
          skippedLinks += 1;
          return zip.readEntry();
        }
        bytes += entry.uncompressedSize;
        if (bytes > limits.maxBytes) {
          throw new ExtractError(`The ZIP expands to more than ${Math.round(limits.maxBytes / 1024 / 1024)} MB.`);
        }
        await fs.mkdir(dirname(target), { recursive: true });
        const stream = await readStream(zip, entry);
        // Keep the executable bit (scripts such as gradlew); nothing else carries over.
        await pipeline(stream, createWriteStream(target, { mode: mode & 0o111 ? 0o755 : 0o644 }));
        files += 1;
        zip.readEntry();
      })().catch(failWith);
    });
    zip.readEntry();
  });

  const projectDir = await findProject(dest);
  if (!projectDir) {
    throw new ExtractError(
      'The ZIP has no pubspec.yaml. Upload the mobile repository as GitHub gives it (Code → Download ZIP).',
    );
  }
  return {
    sha,
    projectDir,
    rootName: projectDir === dest ? '' : projectDir.slice(dest.length + 1),
    files,
    bytes,
    skippedLinks,
  };
}

/** pubspec.yaml at the top, or one or two folders down (GitHub wraps everything in one). */
async function findProject(dir: string, depth = 0): Promise<string | null> {
  try {
    await fs.access(join(dir, 'pubspec.yaml'));
    return dir;
  } catch {
    /* not here */
  }
  if (depth >= 2) return null;
  const children = (await fs.readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort();
  for (const child of children) {
    const found = await findProject(join(dir, child), depth + 1);
    if (found) return found;
  }
  return null;
}

/** The app's version name from pubspec.yaml (`version: 1.0.1+9` → 1.0.1); null if absent. */
export async function pubspecVersion(projectDir: string): Promise<string | null> {
  const text = await fs.readFile(join(projectDir, 'pubspec.yaml'), 'utf8');
  const m = /^version:\s*([^+\s]+)/m.exec(text);
  return m ? m[1] : null;
}

/** Makes a tree owned by the build user, so the unprivileged steps can write build output. */
export async function chownTree(dir: string, uid: number, gid: number): Promise<void> {
  await fs.lchown(dir, uid, gid);
  for (const d of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) await chownTree(p, uid, gid);
    else await fs.lchown(p, uid, gid);
  }
}
