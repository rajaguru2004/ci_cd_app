import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import sodium from 'libsodium-wrappers';
import { readConfig } from '../config';
import { GithubClient, GithubError } from './github.client';
import { sealForGithub } from './sealed-box';

/**
 * Runs GithubClient against a real HTTP server on loopback, so the ETag, redirect and error
 * paths are exercised over actual HTTP rather than a mocked axios.
 */
describe('GithubClient over HTTP', () => {
  let server: Server;
  let base: string;
  const seen: Array<{ url: string; auth?: string; ifNoneMatch?: string }> = [];
  let handler: (req: IncomingMessage, res: ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, ifNoneMatch: req.headers['if-none-match'] as string | undefined });
      handler(req, res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    seen.length = 0;
  });

  const client = () =>
    new GithubClient(readConfig({ GITHUB_TOKEN: 'ghp_test', GITHUB_API_URL: base, GITHUB_REPO: 'o/r', CONSOLE_PASSWORD: 'x' }));

  it('replays the cached body on 304 and sends the ETag it was given', async () => {
    handler = (req, res) => {
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304, { etag: '"v1"', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4998', 'x-ratelimit-reset': '1' });
      res.end(JSON.stringify({ n: 1 }));
    };
    const gh = client();
    expect(await gh.get('/repos/o/r/actions/runs/1')).toEqual({ n: 1 });
    expect(await gh.get('/repos/o/r/actions/runs/1')).toEqual({ n: 1 });
    expect(seen[1].ifNoneMatch).toBe('"v1"');
    expect(gh.rateLimit).toEqual({ limit: 5000, remaining: 4999, reset: 1 });
  });

  it('follows a download redirect without sending the token to storage', async () => {
    handler = (req, res) => {
      if (req.url?.startsWith('/repos/o/r/actions/jobs/9/logs')) {
        res.writeHead(302, { location: `${base}/storage/log.txt?sig=abc` });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('2026-09-29T10:00:00Z hello');
    };
    const text = (await client().download('/repos/o/r/actions/jobs/9/logs')).toString('utf8');
    expect(text).toBe('2026-09-29T10:00:00Z hello');
    expect(seen[0].auth).toBe('Bearer ghp_test');
    expect(seen[1].url).toBe('/storage/log.txt?sig=abc');
    expect(seen[1].auth).toBeUndefined();
  });

  it('turns a 401 into a sentence about the token, without the token in it', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Bad credentials' }));
    };
    const err = await client().get('/repos/o/r').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect((err as GithubError).message).toContain('Replace GITHUB_TOKEN');
    expect((err as GithubError).message).not.toContain('ghp_test');
  });

  it('answers notFound instead of throwing where a 404 is meaningful', async () => {
    handler = (_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
    };
    expect(await client().getOrNotFound('/repos/o/r/actions/workflows/release.yml')).toEqual({ notFound: true });
  });

  it('refuses to call GitHub at all without a token', async () => {
    const gh = new GithubClient(readConfig({ GITHUB_API_URL: base, CONSOLE_PASSWORD: 'x' }));
    await expect(gh.get('/repos/o/r')).rejects.toThrow('No GitHub token is configured');
    expect(seen).toHaveLength(0);
  });
});

describe('sealForGithub', () => {
  it('produces a sealed box only the repository key can open', async () => {
    await sodium.ready;
    const pair = sodium.crypto_box_keypair();
    const publicKey = sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL);
    const sealed = await sealForGithub('{"type":"service_account"}', publicKey);
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL),
      pair.publicKey,
      pair.privateKey,
    );
    expect(sodium.to_string(opened)).toBe('{"type":"service_account"}');
  });
});
