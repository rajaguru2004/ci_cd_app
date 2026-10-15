import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { listKeystore, SigningError } from './signing';
import type { IosCertificate, IosProfile, IosSetup } from './types';

/**
 * The iOS side of an app, read and checked on this server: the bundle ID a Flutter project
 * builds (ios/Runner.xcodeproj), the Apple Distribution certificate (.p12, opened with its
 * password), and provisioning profiles (.mobileprovision: a signed plist, read without a Mac).
 * Every refusal is one sentence that says what to fix.
 */

export class IosError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'IosError';
  }
}

// ─── Bundle IDs ────────────────────────────────────────────────────────────────────────

const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const isBundleId = (s: string) => BUNDLE_ID.test(s) && s.length <= 155;

/** Every PRODUCT_BUNDLE_IDENTIFIER an Xcode project sets (the app, its extensions, its test targets). */
export function parseBundleIds(pbxproj: string): string[] {
  const ids = new Set<string>();
  for (const m of pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([^";\n]+?)"?\s*;/g)) ids.add(m[1].trim());
  return [...ids];
}

/** Whether a profile's App ID (com.acme.app, com.acme.*, *) covers a bundle ID. */
export function profileCovers(appId: string, bundleId: string): boolean {
  if (appId === '*' || appId === bundleId) return true;
  return appId.endsWith('.*') && bundleId.startsWith(appId.slice(0, -1));
}

// ─── Property lists ────────────────────────────────────────────────────────────────────

export type PlistValue = string | number | boolean | Buffer | PlistValue[] | { [key: string]: PlistValue };

interface Tok {
  kind: 'open' | 'close' | 'empty' | 'text';
  name: string;
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (all, e: string) =>
    e.startsWith('#x') ? String.fromCodePoint(parseInt(e.slice(2), 16)) : e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e] ?? all),
  );

/** An XML property list (what a provisioning profile carries) as plain values; dates stay ISO strings. */
export function parsePlist(xml: string): PlistValue {
  const body = xml
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const toks: Tok[] = [];
  for (const m of body.matchAll(/<(\/)?([A-Za-z]+)[^>]*?(\/)?>|([^<]+)/g)) {
    if (m[4] !== undefined) toks.push({ kind: 'text', name: '', text: m[4] });
    else toks.push({ kind: m[1] ? 'close' : m[3] ? 'empty' : 'open', name: m[2], text: '' });
  }
  let i = 0;
  const bad = (what: string): never => {
    throw new IosError(`The property list is damaged (${what}).`);
  };
  const skipText = () => {
    while (i < toks.length && toks[i].kind === 'text' && !toks[i].text.trim()) i += 1;
  };
  const textUntil = (name: string): string => {
    let out = '';
    while (i < toks.length && toks[i].kind === 'text') out += toks[i++].text;
    if (toks[i]?.kind !== 'close' || toks[i].name !== name) bad(`unclosed <${name}>`);
    i += 1;
    return decode(out);
  };
  const value = (): PlistValue => {
    skipText();
    const t = toks[i++];
    if (!t) return bad('it ends early');
    if (t.kind === 'empty') {
      if (t.name === 'true') return true;
      if (t.name === 'false') return false;
      if (t.name === 'string') return '';
      if (t.name === 'dict') return {};
      if (t.name === 'array') return [];
      if (t.name === 'data') return Buffer.alloc(0);
      return bad(`<${t.name}/>`);
    }
    if (t.kind !== 'open') return bad(`unexpected ${t.kind === 'text' ? 'text' : `</${t.name}>`}`);
    switch (t.name) {
      case 'plist': {
        const v = value();
        skipText();
        if (toks[i]?.kind === 'close' && toks[i].name === 'plist') i += 1;
        return v;
      }
      case 'dict': {
        const out: Record<string, PlistValue> = {};
        for (;;) {
          skipText();
          const k = toks[i];
          if (!k) return bad('unclosed <dict>');
          if (k.kind === 'close' && k.name === 'dict') {
            i += 1;
            return out;
          }
          if (k.kind !== 'open' || k.name !== 'key') return bad('a <dict> entry without its <key>');
          i += 1;
          const key = textUntil('key');
          out[key] = value();
        }
      }
      case 'array': {
        const out: PlistValue[] = [];
        for (;;) {
          skipText();
          const k = toks[i];
          if (!k) return bad('unclosed <array>');
          if (k.kind === 'close' && k.name === 'array') {
            i += 1;
            return out;
          }
          out.push(value());
        }
      }
      case 'string':
        return textUntil('string');
      case 'integer':
      case 'real': {
        const n = Number(textUntil(t.name).trim());
        return Number.isFinite(n) ? n : bad(`a <${t.name}> that is not a number`);
      }
      case 'date': {
        const d = new Date(textUntil('date').trim());
        return Number.isFinite(d.getTime()) ? d.toISOString() : bad('a <date> that is not a date');
      }
      case 'data':
        return Buffer.from(textUntil('data').replace(/\s+/g, ''), 'base64');
      case 'true':
      case 'false':
        textUntil(t.name);
        return t.name === 'true';
      default:
        return bad(`<${t.name}>`);
    }
  };
  return value();
}

// ─── Provisioning profiles ─────────────────────────────────────────────────────────────

const str = (v: PlistValue | undefined) => (typeof v === 'string' ? v : '');
const dict = (v: PlistValue | undefined) => (v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) ? v : {});
const list = (v: PlistValue | undefined) => (Array.isArray(v) ? v : []);
export const sha1Hex = (data: Buffer) => createHash('sha1').update(data).digest('hex').toUpperCase();
/** A fingerprint as keytool or the console prints it, to compare: upper-case hex without separators. */
export const normalizeFingerprint = (s: string) => s.replace(/[^0-9a-f]/gi, '').toUpperCase();

/** What a .mobileprovision says about itself. The file is a CMS envelope around an XML plist. */
export function parseProfile(data: Buffer, fileName: string, uploadedAt = new Date().toISOString()): IosProfile & { platforms: string[] } {
  const text = data.toString('latin1');
  const start = text.indexOf('<?xml');
  const end = text.indexOf('</plist>', start);
  if (start < 0 || end < 0) throw new IosError('That file is not a provisioning profile: download the .mobileprovision from developer.apple.com → Profiles.');
  const p = dict(parsePlist(data.subarray(start, end + '</plist>'.length).toString('utf8')));
  const ents = dict(p.Entitlements);
  const teamId = str(list(p.TeamIdentifier)[0]) || str(ents['com.apple.developer.team-identifier']);
  const prefix = str(list(p.ApplicationIdentifierPrefix)[0]) || teamId;
  const full = str(ents['application-identifier']);
  const uuid = str(p.UUID);
  if (!uuid || !full || !teamId) throw new IosError('That provisioning profile has no UUID, App ID or team: download it again from developer.apple.com.');
  const devices = list(p.ProvisionedDevices).length > 0;
  const type: IosProfile['type'] = p.ProvisionsAllDevices === true ? 'enterprise' : devices ? (ents['get-task-allow'] === true ? 'development' : 'ad-hoc') : ents['get-task-allow'] === true ? 'development' : 'app-store';
  return {
    uuid,
    name: str(p.Name) || uuid,
    teamId,
    appId: full.startsWith(`${prefix}.`) ? full.slice(prefix.length + 1) : full,
    type,
    expiresAt: str(p.ExpirationDate),
    certificates: list(p.DeveloperCertificates).filter((c): c is Buffer => Buffer.isBuffer(c)).map(sha1Hex),
    fileName: fileName.replace(/[^\w.\- ]/g, '').slice(0, 120) || `${uuid}.mobileprovision`,
    uploadedAt,
    platforms: list(p.Platform).map((x) => str(x)).filter(Boolean),
  };
}

// ─── Certificates ──────────────────────────────────────────────────────────────────────

/** The common name and team of an Apple certificate's subject ("CN=Apple Distribution: Acme (TEAM), OU=TEAM, …"). */
export function parseAppleSubject(owner: string): { name: string; teamId: string | null; kind: IosCertificate['kind'] } {
  const name = /(?:^|,\s*)CN=("[^"]*"|[^,]+)/.exec(owner)?.[1]?.replace(/^"|"$/g, '').trim() ?? owner;
  const teamId = /(?:^|,\s*)OU=([A-Z0-9]{10})(?:,|$)/.exec(owner)?.[1] ?? /\(([A-Z0-9]{10})\)\s*$/.exec(name)?.[1] ?? null;
  const kind = /^(Apple|iPhone) Distribution\b/.test(name) ? 'distribution' : /^(Apple Development|iPhone Developer)\b/.test(name) ? 'development' : 'other';
  return { name, teamId, kind };
}

/**
 * Opens a .p12 with its password (keytool reads both the legacy and the current PKCS#12
 * encryption Keychain Access exports) and returns the certificate of its one private key.
 */
export async function readP12(p12: Buffer, password: string, fileName: string, scratchDir: string): Promise<IosCertificate> {
  if (!p12.length) throw new IosError('Choose the certificate’s .p12 file.');
  if (p12.length > 64 * 1024) throw new IosError('That file is too large to be an exported certificate (.p12).');
  if (!password) throw new IosError('Enter the .p12 password (Keychain Access asks for one when it exports the certificate).');
  const dir = join(scratchDir, `rc-${randomBytes(8).toString('hex')}`);
  await fs.mkdir(dir, { mode: 0o700 });
  try {
    const file = join(dir, 'certificate.p12');
    await fs.writeFile(file, p12, { mode: 0o600 });
    let entries;
    try {
      entries = await listKeystore(file, password);
    } catch (e) {
      if (!(e instanceof SigningError)) throw e;
      if (/password is wrong/.test(e.message)) throw new IosError('The .p12 password is wrong.', 422);
      if (/not a Java keystore/.test(e.message)) throw new IosError('That file is not a .p12: in Keychain Access, select the certificate with its private key and choose Export → Personal Information Exchange (.p12).', 422);
      if (/holds no private key/.test(e.message)) throw new IosError('The .p12 holds no private key: export the certificate together with its key (expand it in Keychain Access and select both).', 422);
      throw new IosError(e.message.replace(/keystore/g, '.p12'), 422);
    }
    const certs = entries.map((e) => ({ ...e, apple: parseAppleSubject(e.certificate.owner) }));
    const pick = certs.find((c) => c.apple.kind === 'distribution') ?? certs[0];
    const until = Date.parse(pick.certificate.validUntil);
    if (Number.isFinite(until) && until < Date.now()) {
      throw new IosError(`${pick.apple.name} expired on ${pick.certificate.validUntil.slice(0, 10)}: make a new Apple Distribution certificate at developer.apple.com → Certificates.`, 422);
    }
    return {
      fileName: fileName.replace(/[^\w.\- ]/g, '').slice(0, 120) || 'certificate.p12',
      name: pick.apple.name,
      teamId: pick.apple.teamId,
      kind: pick.apple.kind,
      sha1: normalizeFingerprint(pick.certificate.sha1),
      sha256: normalizeFingerprint(pick.certificate.sha256),
      validFrom: pick.certificate.validFrom,
      validUntil: pick.certificate.validUntil,
      uploadedAt: new Date().toISOString(),
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ─── Readiness ─────────────────────────────────────────────────────────────────────────

/** The profile that signs a bundle ID: an App Store profile covering it, carrying the certificate, unexpired. */
export function profileFor(ios: IosSetup, bundleId: string, now = Date.now()): IosProfile | null {
  const cert = ios.certificate?.sha1;
  const fits = ios.profiles.filter((p) => p.type === 'app-store' && profileCovers(p.appId, bundleId) && (!cert || p.certificates.includes(cert)) && Date.parse(p.expiresAt) > now);
  // An exact App ID beats a wildcard; then the one that lasts longest.
  fits.sort((a, b) => Number(b.appId === bundleId) - Number(a.appId === bundleId) || Date.parse(b.expiresAt) - Date.parse(a.expiresAt));
  return fits[0] ?? null;
}

/**
 * What stops an app's iOS release, each a sentence with the way out; empty when it is ready.
 * `forRelease` adds the App Store Connect key (a build needs only signing).
 */
export function iosProblems(ios: IosSetup | null, appName: string, forRelease: boolean, now = Date.now()): string[] {
  if (!ios) return [`${appName} has no iOS setup: add its bundle ID, certificate and profile in its settings → iOS.`];
  const out: string[] = [];
  const cert = ios.certificate;
  if (!cert) out.push('There is no distribution certificate: upload the .p12 in the app’s settings → iOS.');
  else if (Date.parse(cert.validUntil) < now) out.push(`${cert.name} expired on ${cert.validUntil.slice(0, 10)}: upload a new certificate.`);
  else if (cert.kind !== 'distribution') out.push(`${cert.name} is not an Apple Distribution certificate; App Store Connect takes only distribution-signed builds.`);
  if (!profileFor(ios, ios.bundleId, now)) {
    const any = ios.profiles.filter((p) => profileCovers(p.appId, ios.bundleId));
    if (!any.length) out.push(`There is no provisioning profile for ${ios.bundleId}: upload its App Store profile in the app’s settings → iOS.`);
    else if (!any.some((p) => p.type === 'app-store')) out.push(`The profiles for ${ios.bundleId} are ${[...new Set(any.map((p) => p.type))].join(', ')}; App Store Connect needs an App Store profile.`);
    else if (!any.some((p) => Date.parse(p.expiresAt) > now)) out.push(`The App Store profile for ${ios.bundleId} has expired: download it again from developer.apple.com.`);
    else if (cert) out.push(`No App Store profile for ${ios.bundleId} includes ${cert.name}: edit the profile at developer.apple.com to include it, then upload it again.`);
  }
  if (forRelease) {
    if (!ios.appStore) out.push('There is no App Store Connect API key: add one in the app’s settings → iOS.');
    else if (ios.appStore.message) out.push(ios.appStore.message);
  }
  return out;
}
