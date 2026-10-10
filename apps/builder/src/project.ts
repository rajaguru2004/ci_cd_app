import { promises as fs } from 'fs';
import { join } from 'path';

/**
 * What a Flutter project says about itself: its pubspec, the applicationId Gradle builds, the
 * label Android shows, and whether it signs itself (key.properties). Read from files on disk
 * (a run's checkout) or straight out of git (the Add app check), through the same functions.
 */

export interface ProjectInfo {
  /** Folder of pubspec.yaml relative to the repository or ZIP root ('' = the root). */
  path: string;
  /** pubspec `name`. */
  name: string | null;
  /** pubspec `version` before the '+'. */
  versionName: string | null;
  /** pubspec `version` after the '+'. */
  buildNumber: number | null;
  /** The applicationId in android/app/build.gradle(.kts), else its namespace (Gradle's own fallback). */
  applicationId: string | null;
  gradleFile: string | null;
  /** android:label when the manifest spells it out (not a @string reference). */
  label: string | null;
  /** android/key.properties is in the project: it signs its own release builds. */
  keyProperties: boolean;
  /** pubspec depends on the Flutter SDK. */
  flutter: boolean;
}

const SKIP = new Set(['build', 'node_modules', 'Pods', 'ios', 'android', 'web', 'linux', 'macos', 'windows']);

/**
 * The folder holding the app's pubspec.yaml among a list of file paths: the configured one, or
 * the shallowest within two folders of the top (GitHub's ZIPs wrap everything in one folder).
 */
export function pickProjectPath(files: string[], configured = ''): string | null {
  const want = configured.replace(/^\/+|\/+$/g, '');
  const pubspecs = files
    .filter((f) => f === 'pubspec.yaml' || f.endsWith('/pubspec.yaml'))
    .map((f) => f.slice(0, -'pubspec.yaml'.length).replace(/\/$/, ''));
  if (want) return pubspecs.includes(want) ? want : null;
  const ok = pubspecs.filter((p) => {
    const parts = p ? p.split('/') : [];
    return parts.length <= 2 && parts.every((x) => !x.startsWith('.') && !SKIP.has(x));
  });
  ok.sort((a, b) => a.split('/').filter(Boolean).length - b.split('/').filter(Boolean).length || a.localeCompare(b));
  return ok[0] ?? null;
}

/**
 * The app's folder under `root` (a checkout or an unpacked ZIP): the configured folder, also
 * under a single wrapping folder (GitHub's ZIPs), else the shallowest pubspec.yaml.
 */
export async function locateProject(root: string, configured = ''): Promise<string | null> {
  const want = configured.replace(/^\/+|\/+$/g, '');
  const has = (rel: string) => fs.access(join(root, rel, 'pubspec.yaml')).then(() => true, () => false);
  if (want) {
    if (await has(want)) return want;
    for (const top of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (top.isDirectory() && !top.name.startsWith('.') && (await has(`${top.name}/${want}`))) return `${top.name}/${want}`;
    }
    return null;
  }
  return pickProjectPath(await pubspecPaths(root));
}

/** pubspec.yaml paths on disk within two folders of `root`, relative to it. */
export async function pubspecPaths(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string, depth: number) => {
    const entries = await fs.readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isFile() && e.name === 'pubspec.yaml') out.push(rel ? `${rel}/pubspec.yaml` : 'pubspec.yaml');
      if (e.isDirectory() && depth < 2 && !e.name.startsWith('.') && !SKIP.has(e.name)) await walk(rel ? `${rel}/${e.name}` : e.name, depth + 1);
    }
  };
  await walk('', 0);
  return out;
}

export function parsePubspec(text: string): Pick<ProjectInfo, 'name' | 'versionName' | 'buildNumber' | 'flutter'> {
  const name = /^name:\s*["']?([A-Za-z0-9_]+)/m.exec(text)?.[1] ?? null;
  const version = /^version:\s*["']?([0-9]+\.[0-9]+\.[0-9]+)(?:\+([0-9]+))?/m.exec(text);
  return {
    name,
    versionName: version?.[1] ?? null,
    buildNumber: version?.[2] ? Number(version[2]) : null,
    flutter: /sdk:\s*flutter\b/.test(text),
  };
}

const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export function parseApplicationId(gradle: string): string | null {
  // Groovy `applicationId "a.b"` and Kotlin `applicationId = "a.b"`; comments are skipped.
  const code = gradle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const id = /(?:^|[\s{;])applicationId\s*(?:=\s*)?["']([^"']+)["']/m.exec(code)?.[1];
  if (id && PACKAGE.test(id)) return id;
  const ns = /(?:^|[\s{;])namespace\s*(?:=\s*)?["']([^"']+)["']/m.exec(code)?.[1];
  return ns && PACKAGE.test(ns) ? ns : null;
}

export function parseManifestLabel(xml: string): string | null {
  const label = /<application\b[^>]*\bandroid:label\s*=\s*"([^"]+)"/s.exec(xml)?.[1];
  return label && !label.startsWith('@') ? label.trim() : null;
}

export const isPackageName = (s: string) => PACKAGE.test(s) && s.length <= 150;

/** Reads a project through `read` (relative to the repository root; null when absent). */
export async function describeProject(read: (rel: string) => Promise<string | null>, path: string): Promise<ProjectInfo> {
  const at = (rel: string) => (path ? `${path}/${rel}` : rel);
  const pubspec = (await read(at('pubspec.yaml'))) ?? '';
  let gradleFile: string | null = null;
  let gradle = '';
  for (const f of ['android/app/build.gradle.kts', 'android/app/build.gradle']) {
    const text = await read(at(f));
    if (text !== null) {
      gradleFile = f;
      gradle = text;
      break;
    }
  }
  const manifest = (await read(at('android/app/src/main/AndroidManifest.xml'))) ?? '';
  return {
    path,
    ...parsePubspec(pubspec),
    applicationId: gradle ? parseApplicationId(gradle) : null,
    gradleFile,
    label: manifest ? parseManifestLabel(manifest) : null,
    keyProperties: (await read(at('android/key.properties'))) !== null,
  };
}

/** describeProject over files on disk under `root`. */
export function describeDir(root: string, path: string): Promise<ProjectInfo> {
  return describeProject((rel) => fs.readFile(join(root, rel), 'utf8').catch(() => null), path);
}
