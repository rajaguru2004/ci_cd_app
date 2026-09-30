import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { createVerify, generateKeyPairSync } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readConfig } from '../config';
import { loadServiceAccount, PlayClient, PlayError, PUBLISHER_SCOPE, signServiceJwt } from './play.client';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

describe('signServiceJwt', () => {
  it('signs an RS256 JWT-bearer assertion Google can verify', () => {
    const key = { type: 'service_account', client_email: 'ci@p.iam.gserviceaccount.com', private_key: PEM, private_key_id: 'kid1', token_uri: 'https://oauth2.googleapis.com/token' };
    const jwt = signServiceJwt(key, PUBLISHER_SCOPE, 1_000_000);
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid1' });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toEqual({
      iss: 'ci@p.iam.gserviceaccount.com',
      scope: PUBLISHER_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_000_000,
      exp: 1_003_600,
    });
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });
});

describe('loadServiceAccount', () => {
  const dir = mkdtempSync(join(tmpdir(), 'play-key-'));
  it('reports a missing file as missing, naming where it looked', () => {
    const s = loadServiceAccount({ playKeyJson: '', playKeyFile: join(dir, 'nope.json') });
    expect(s.kind).toBe('missing');
  });
  it('reports a malformed key as invalid with the reason', () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, JSON.stringify({ type: 'authorized_user' }));
    const s = loadServiceAccount({ playKeyJson: '', playKeyFile: file });
    expect(s).toEqual({ kind: 'invalid', reason: expect.stringContaining('not a service-account key') });
  });
  it('prefers the inline key over the file', () => {
    const inline = JSON.stringify({ type: 'service_account', client_email: 'a@b', private_key: PEM });
    const s = loadServiceAccount({ playKeyJson: inline, playKeyFile: join(dir, 'nope.json') });
    expect(s.kind === 'ready' && s.source).toBe('PLAY_SERVICE_ACCOUNT_JSON');
  });
});

describe('PlayClient over HTTP', () => {
  let server: Server;
  let base: string;
  const seen: string[] = [];
  let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push(`${req.method} ${req.url}`);
        handler(req, res, body);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    seen.length = 0;
  });

  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  const client = () =>
    new PlayClient(
      readConfig({
        CONSOLE_PASSWORD: 'x',
        PLAY_API_URL: `${base}/publisher`,
        PLAY_SERVICE_ACCOUNT_JSON: JSON.stringify({
          type: 'service_account',
          client_email: 'ci@proj.iam.gserviceaccount.com',
          project_id: 'proj',
          private_key: PEM,
          token_uri: `${base}/token`,
        }),
      }),
    );

  const happy = (req: IncomingMessage, res: ServerResponse, body: string) => {
    if (req.url === '/token') {
      expect(new URLSearchParams(body).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      return json(res, 200, { access_token: 'ya29.test', expires_in: 3600 });
    }
    expect(req.headers.authorization).toBe('Bearer ya29.test');
    if (req.method === 'POST') return json(res, 200, { id: 'edit-1' });
    if (req.method === 'GET') {
      return json(res, 200, {
        tracks: [
          { track: 'internal', releases: [{ name: '1.0.1', versionCodes: ['1001'], status: 'draft' }] },
          { track: 'production', releases: [{ name: 'Second Release', versionCodes: ['9'], status: 'completed', releaseNotes: [{ language: 'en-US', text: 'Hi' }] }] },
        ],
      });
    }
    res.writeHead(204);
    res.end();
  };

  it('opens an edit, reads the tracks, deletes the edit, and never commits', async () => {
    handler = happy;
    const snap = await client().snapshot();
    expect(seen).toEqual([
      'POST /token',
      'POST /publisher/applications/com.fusionapps.fusionhrm/edits',
      'GET /publisher/applications/com.fusionapps.fusionhrm/edits/edit-1/tracks',
      'DELETE /publisher/applications/com.fusionapps.fusionhrm/edits/edit-1',
    ]);
    expect(snap.tracks.map((t) => t.track)).toEqual(['production', 'internal']);
    expect(snap.highestVersionCode).toBe(1001);
    expect(snap.tracks[0].releases[0]).toEqual({ name: 'Second Release', versionCodes: [9], status: 'completed', userFraction: null, releaseNotes: [{ language: 'en-US', text: 'Hi' }] });
  });

  it('serves a recent snapshot from memory and reuses the access token', async () => {
    handler = happy;
    const play = client();
    await play.snapshot();
    const after = seen.length;
    await play.snapshot();
    expect(seen.length).toBe(after);
    await play.snapshot(true);
    expect(seen.slice(after)).not.toContain('POST /token');
  });

  it('explains a service account that was never invited to Play Console', async () => {
    handler = (req, res) =>
      req.url === '/token'
        ? json(res, 200, { access_token: 'ya29.test', expires_in: 3600 })
        : json(res, 403, { error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } });
    const err = await client().snapshot().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlayError);
    expect((err as Error).message).toContain('Users and permissions');
    expect((err as Error).message).toContain('ci@proj.iam.gserviceaccount.com');
  });

  it('says which API to switch on when the publisher API is disabled', async () => {
    handler = (req, res) =>
      req.url === '/token'
        ? json(res, 200, { access_token: 'ya29.test', expires_in: 3600 })
        : json(res, 403, { error: { code: 403, message: 'Google Play Android Developer API has not been used in project 1 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } });
    await expect(client().snapshot()).rejects.toThrow('androidpublisher.googleapis.com?project=proj');
  });

  it('tries once more when Google could not be reached at all', async () => {
    let dropped = false;
    handler = (req, res, body) => {
      if (!dropped) {
        dropped = true;
        req.socket.destroy();
        return;
      }
      happy(req, res, body);
    };
    const snap = await client().snapshot();
    expect(dropped).toBe(true);
    expect(snap.highestVersionCode).toBe(1001);
  });

  it('shares one read between callers that arrive together: two open edits would end each other', async () => {
    handler = happy;
    const play = client();
    const [a, b, c] = await Promise.all([play.snapshot(), play.snapshot(true), play.snapshot()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(seen.filter((l) => l.startsWith('POST /publisher')).length).toBe(1);
  });

  it('opens no edit while a pipeline may hold one: the last read is shown instead', async () => {
    handler = happy;
    const play = client();
    let holder: string | null = null;
    play.setEditHolderProbe(async () => holder);
    const first = await play.snapshot();
    holder = 'ZIP run #7 is uploading to Google Play.';
    const edits = seen.filter((l) => l.startsWith('POST /publisher')).length;
    expect(await play.snapshot(true)).toBe(first);
    expect(seen.filter((l) => l.startsWith('POST /publisher')).length).toBe(edits);
    holder = null;
    await play.snapshot(true);
    expect(seen.filter((l) => l.startsWith('POST /publisher')).length).toBe(edits + 1);
  });

  it('says why there is nothing to show when a pipeline holds the edit before the first read', async () => {
    handler = happy;
    const play = client();
    play.setEditHolderProbe(async () => 'GitHub run #12 is working on Google Play.');
    await expect(play.snapshot()).rejects.toThrow('GitHub run #12 is working on Google Play. The console reads Google Play again once that is done.');
    expect(seen.filter((l) => l.startsWith('POST /publisher'))).toEqual([]);
  });

  it('says the key itself was refused when Google will not sign it in', async () => {
    handler = (_req, res) => json(res, 400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
    await expect(client().snapshot()).rejects.toThrow('Invalid JWT Signature.');
  });
});
