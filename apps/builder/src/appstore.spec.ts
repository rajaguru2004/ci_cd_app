import { generateKeyPairSync, verify } from 'crypto';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { AppStoreClient, parseAppStoreKey, signAppStoreJwt } from './appstore';

/**
 * The App Store Connect client against a stand-in of its API that checks the ES256 JWT the way
 * Apple does (signature by the key's public half, kid, iss, aud, a lifetime of 20 minutes or
 * less) and answers in JSON:API shape.
 */

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const p8 = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const key = parseAppStoreKey({ keyId: 'abcde12345', issuerId: '69A6DE70-03DB-47E3-E053-5B8C7C11A4D1', p8 });

function jwtOk(header: string | undefined): boolean {
  const token = /^Bearer (.+)$/.exec(header ?? '')?.[1];
  if (!token) return false;
  const [h, p, s] = token.split('.');
  const head = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  const signed = verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  return signed && head.alg === 'ES256' && head.kid === 'ABCDE12345' && claims.iss === key.issuerId && claims.aud === 'appstoreconnect-v1' && claims.exp - claims.iat <= 1200;
}

let server: Server;
let url = '';
const calls: string[] = [];
let mode: 'ok' | 'forbidden' | 'empty' = 'ok';

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://asc');
    calls.push(`${u.pathname}?${u.searchParams.toString()}`);
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (!jwtOk(req.headers.authorization)) return json(401, { errors: [{ status: '401', code: 'NOT_AUTHORIZED', title: 'Authentication credentials are missing or invalid.' }] });
    if (mode === 'forbidden') return json(403, { errors: [{ status: '403', code: 'FORBIDDEN_ERROR', detail: 'This request is forbidden for security reasons' }] });
    if (u.pathname === '/v1/apps') {
      const bundleId = u.searchParams.get('filter[bundleId]');
      if (mode === 'empty' || bundleId !== 'com.acme.app') return json(200, { data: [] });
      return json(200, { data: [{ type: 'apps', id: '6449012345', attributes: { name: 'Acme', bundleId } }] });
    }
    if (u.pathname === '/v1/builds' && u.searchParams.get('filter[app]') === '6449012345') {
      const build = (id: string, version: string, pre: string, state: string) => ({
        type: 'builds',
        id,
        attributes: { version, uploadedDate: '2026-10-01T10:00:00Z', processingState: state, expired: false },
        relationships: { preReleaseVersion: { data: { type: 'preReleaseVersions', id: pre } } },
      });
      return json(200, {
        data: [build('b3', '41', 'p2', 'PROCESSING'), build('b2', '1.0.9', 'p1', 'VALID'), build('b1', '40', 'p1', 'VALID')],
        included: [
          { type: 'preReleaseVersions', id: 'p1', attributes: { version: '1.0.1' } },
          { type: 'preReleaseVersions', id: 'p2', attributes: { version: '1.0.2' } },
        ],
      });
    }
    json(404, { errors: [{ status: '404', title: 'Not found' }] });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((r) => server.close(r)));
beforeEach(() => {
  calls.length = 0;
  mode = 'ok';
});

describe('App Store Connect API keys', () => {
  it('takes the key ID in any case, the issuer ID, and an EC P-256 .p8; refuses the rest with the place to find it', () => {
    expect(key.keyId).toBe('ABCDE12345');
    expect(key.issuerId).toBe('69a6de70-03db-47e3-e053-5b8c7c11a4d1');
    expect(() => parseAppStoreKey({ keyId: 'short', issuerId: key.issuerId, p8 })).toThrow('AuthKey_');
    expect(() => parseAppStoreKey({ keyId: 'ABCDE12345', issuerId: 'nope', p8 })).toThrow('issuer ID');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    expect(() => parseAppStoreKey({ keyId: 'ABCDE12345', issuerId: key.issuerId, p8: rsa })).toThrow('EC P-256');
  });

  it('signs a JWT Apple accepts', () => {
    expect(jwtOk(`Bearer ${signAppStoreJwt(key)}`)).toBe(true);
  });
});

describe('AppStoreClient', () => {
  it('finds the app by bundle ID and reads the highest whole-number build of any version', async () => {
    const snap = await new AppStoreClient(url).snapshot(key, 'com.acme.app');
    expect(snap).toMatchObject({ appId: '6449012345', appName: 'Acme', bundleId: 'com.acme.app', keyId: 'ABCDE12345', highestBuild: 41 });
    expect(snap.builds[0]).toEqual({ buildNumber: '41', versionName: '1.0.2', uploadedAt: '2026-10-01T10:00:00Z', processingState: 'PROCESSING', expired: false });
    expect(calls[1]).toContain('sort=-uploadedDate');
  });

  it('serves a recent read from memory unless forced', async () => {
    const client = new AppStoreClient(url);
    await client.snapshot(key, 'com.acme.app');
    await client.snapshot(key, 'com.acme.app');
    expect(calls).toHaveLength(2);
    await client.snapshot(key, 'com.acme.app', true);
    expect(calls).toHaveLength(4);
  });

  it('says what is wrong: no such app, a role too small, a revoked key', async () => {
    mode = 'empty';
    await expect(new AppStoreClient(url).snapshot(key, 'com.acme.app')).rejects.toThrow('has no app with the bundle ID com.acme.app');
    mode = 'forbidden';
    await expect(new AppStoreClient(url).snapshot(key, 'com.acme.app')).rejects.toThrow('App Manager or Admin role');
    mode = 'ok';
    const other = parseAppStoreKey({ ...key, p8: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() });
    await expect(new AppStoreClient(url).snapshot(other, 'com.acme.app')).rejects.toThrow('refused key ABCDE12345');
  });

  it('marks an unreachable App Store Connect as worth another try', async () => {
    await expect(new AppStoreClient('http://127.0.0.1:1').snapshot(key, 'com.acme.app')).rejects.toMatchObject({ transient: true });
  });
});
