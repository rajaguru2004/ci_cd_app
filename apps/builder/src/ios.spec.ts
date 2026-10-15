import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { iosProblems, parseAppleSubject, parseBundleIds, parsePlist, parseProfile, profileCovers, profileFor, readP12 } from './ios';
import { makeAppleCert, makeP12, makeProfile, pbxproj, useJdk } from './testing';
import type { IosSetup } from './types';

/**
 * The iOS checks against files made the way Apple makes them: certificates and .p12 files from
 * openssl (both encryption schemes Keychain Access exports), and provisioning profiles that are
 * real CMS-signed plists. keytool reads the .p12 as the builder image's does.
 */

const hasJdk = useJdk();
const maybe = hasJdk ? describe : describe.skip;
const dir = mkdtempSync(join(tmpdir(), 'rc-ios-'));
const uuid = (n: number) => `0000000${n}-AAAA-BBBB-CCCC-DDDDEEEEFFFF`.slice(-36);

describe('property lists', () => {
  it('reads dicts, arrays, strings with entities, numbers, booleans, dates and data', () => {
    const v = parsePlist(`<?xml version="1.0"?><!DOCTYPE plist><plist version="1.0"><dict>
      <key>name</key><string>Acme &amp; Co &lt;3 &#x263A;</string>
      <key>n</key><integer>42</integer><key>r</key><real>1.5</real>
      <key>yes</key><true/><key>no</key><false/>
      <key>when</key><date>2026-01-02T03:04:05Z</date>
      <key>blob</key><data>
        aGVs
        bG8=
      </data>
      <key>list</key><array><string>a</string><string></string><dict/></array>
      <key>space</key><string>  two  </string>
    </dict></plist>`) as Record<string, unknown>;
    expect(v.name).toBe('Acme & Co <3 ☺');
    expect([v.n, v.r, v.yes, v.no, v.when]).toEqual([42, 1.5, true, false, '2026-01-02T03:04:05.000Z']);
    expect((v.blob as Buffer).toString()).toBe('hello');
    expect(v.list).toEqual(['a', '', {}]);
    expect(v.space).toBe('  two  ');
  });

  it('refuses a damaged one with a sentence', () => {
    expect(() => parsePlist('<plist><dict><key>a</key>')).toThrow('damaged');
    expect(() => parsePlist('<plist><dict><string>x</string></dict></plist>')).toThrow('without its <key>');
  });
});

describe('bundle IDs', () => {
  it('lists every PRODUCT_BUNDLE_IDENTIFIER of a Flutter project, quoted or not', () => {
    expect(parseBundleIds(pbxproj('com.acme.app', ['com.acme.app.NotificationService']))).toEqual(['com.acme.app', 'com.acme.app.RunnerTests', 'com.acme.app.NotificationService']);
  });

  it('matches App IDs the way Apple does', () => {
    expect(profileCovers('com.acme.app', 'com.acme.app')).toBe(true);
    expect(profileCovers('com.acme.*', 'com.acme.app.widget')).toBe(true);
    expect(profileCovers('*', 'org.other')).toBe(true);
    expect(profileCovers('com.acme.app', 'com.acme.app.widget')).toBe(false);
    expect(profileCovers('com.acme.*', 'com.acmex.app')).toBe(false);
  });

  it("reads an Apple certificate's name, team and kind from its subject", () => {
    expect(parseAppleSubject('CN=Apple Distribution: Acme Ltd (A1B2C3D4E5), OU=A1B2C3D4E5, O=Acme Ltd, C=US')).toEqual({ name: 'Apple Distribution: Acme Ltd (A1B2C3D4E5)', teamId: 'A1B2C3D4E5', kind: 'distribution' });
    expect(parseAppleSubject('CN=iPhone Distribution: Old Co (Z9Y8X7W6V5)')).toMatchObject({ teamId: 'Z9Y8X7W6V5', kind: 'distribution' });
    expect(parseAppleSubject('CN=Apple Development: Dev (Q1W2E3R4T5), OU=Q1W2E3R4T5').kind).toBe('development');
  });
});

describe('provisioning profiles', () => {
  const signer = makeAppleCert(dir, { name: 'Apple iPhone OS Provisioning Profile Signing' });
  const dist = makeAppleCert(dir);

  it('reads an App Store profile: name, UUID, team, App ID, expiry and the certificates it allows', () => {
    const p = parseProfile(makeProfile(dir, signer, { uuid: uuid(1), name: 'Acme App Store', appId: 'com.acme.app', certs: [dist.der] }), 'Acme.mobileprovision');
    expect(p).toMatchObject({ uuid: uuid(1), name: 'Acme App Store', teamId: 'A1B2C3D4E5', appId: 'com.acme.app', type: 'app-store', fileName: 'Acme.mobileprovision', platforms: ['iOS'] });
    expect(p.certificates).toEqual([dist.sha1]);
    expect(Date.parse(p.expiresAt)).toBeGreaterThan(Date.now());
  });

  it.each([
    ['ad-hoc', 'ad-hoc'],
    ['development', 'development'],
    ['enterprise', 'enterprise'],
  ] as const)('tells a %s profile apart', (type, expected) => {
    expect(parseProfile(makeProfile(dir, signer, { uuid: uuid(2), name: 'X', appId: 'com.acme.*', type, certs: [dist.der] }), 'x').type).toBe(expected);
  });

  it('refuses a file that is not one', () => {
    expect(() => parseProfile(Buffer.from('not a profile'), 'x')).toThrow('not a provisioning profile');
  });

  it('picks the profile that signs a bundle ID: App Store, carrying the certificate, unexpired, exact before wildcard', () => {
    const base = { teamId: 'A1B2C3D4E5', fileName: 'x', uploadedAt: '', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), certificates: [dist.sha1] };
    const ios: IosSetup = {
      bundleId: 'com.acme.app',
      certificate: { fileName: 'c.p12', name: dist.name, teamId: 'A1B2C3D4E5', kind: 'distribution', sha1: dist.sha1, sha256: '', validFrom: '', validUntil: new Date(Date.now() + 86_400_000).toISOString(), uploadedAt: '' },
      profiles: [
        { ...base, uuid: 'w', name: 'Wildcard', appId: 'com.acme.*', type: 'app-store' },
        { ...base, uuid: 'e', name: 'Exact', appId: 'com.acme.app', type: 'app-store' },
        { ...base, uuid: 'a', name: 'Ad hoc', appId: 'com.acme.app', type: 'ad-hoc' },
      ],
      appStore: null,
      updatedAt: '',
    };
    expect(profileFor(ios, 'com.acme.app')?.name).toBe('Exact');
    expect(profileFor(ios, 'com.acme.app.widget')?.name).toBe('Wildcard');
    expect(iosProblems(ios, 'Acme', false)).toEqual([]);
    expect(iosProblems(ios, 'Acme', true)).toEqual(['There is no App Store Connect API key: add one in the app’s settings → iOS.']);
    expect(iosProblems({ ...ios, profiles: ios.profiles.filter((p) => p.type !== 'app-store') }, 'Acme', false)[0]).toMatch('needs an App Store profile');
    expect(iosProblems({ ...ios, profiles: ios.profiles.map((p) => ({ ...p, certificates: ['00'] })) }, 'Acme', false)[0]).toMatch(`includes ${dist.name}`);
    expect(iosProblems({ ...ios, certificate: null }, 'Acme', false)[0]).toMatch('no distribution certificate');
    expect(iosProblems(null, 'Acme', false)[0]).toMatch('Acme has no iOS setup');
  });
});

maybe('distribution certificates (.p12, read with keytool)', () => {
  const dist = makeAppleCert(dir);

  it.each([
    ['current', false],
    ['older 3DES/SHA-1', true],
  ])('opens a %s .p12 with its password and reads the certificate', async (_label, older) => {
    const cert = await readP12(makeP12(dir, dist, 's3cret pass', older), 's3cret pass', 'Certificates.p12', dir);
    expect(cert).toMatchObject({ fileName: 'Certificates.p12', name: dist.name, teamId: 'A1B2C3D4E5', kind: 'distribution', sha1: dist.sha1 });
    expect(cert.sha256).toMatch(/^[0-9A-F]{64}$/);
  });

  it('says when the password is wrong, the file is not a .p12, or the certificate expired', async () => {
    const p12 = makeP12(dir, dist, 'right');
    await expect(readP12(p12, 'wrong', 'c.p12', dir)).rejects.toThrow('The .p12 password is wrong.');
    await expect(readP12(Buffer.from('nope'), 'x', 'c.p12', dir)).rejects.toThrow(/not a \.p12|could not read/);
    await expect(readP12(p12, '', 'c.p12', dir)).rejects.toThrow('Enter the .p12 password');
    const old = makeAppleCert(dir, { expired: true });
    await expect(readP12(makeP12(dir, old, 'pw'), 'pw', 'c.p12', dir)).rejects.toThrow('expired on 2021-01-01');
  });

  it('reads a development certificate as one', async () => {
    const devCert = makeAppleCert(dir, { name: 'Apple Development: Dev Person (A1B2C3D4E5)' });
    expect((await readP12(makeP12(dir, devCert, 'pw'), 'pw', 'dev.p12', dir)).kind).toBe('development');
  });
});
