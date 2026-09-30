import { GithubError } from '../github/github.client';
import { VersionCodes } from '../local/version-codes';
import { SetupService } from './setup.service';

/** Just enough of each collaborator for status() to reach the token check. */
function service(opts: { repo: () => Promise<unknown>; user: () => Promise<unknown>; playHighest?: number; known?: number[] }) {
  const gh = { configured: true, rateLimit: null, get: jest.fn((path: string) => (path === '/user' ? opts.user() : Promise.reject(new Error(path)))) };
  const pipeline = { repo: jest.fn(opts.repo) };
  const snapshot = { packageName: 'com.example', highestVersionCode: opts.playHighest ?? null, tracks: [] };
  const play =
    opts.playHighest === undefined
      ? { keyState: () => ({ kind: 'missing', reason: 'no key' }) }
      : { keyState: () => ({ kind: 'ready', key: { client_email: 'ci@example.iam.gserviceaccount.com' } }), snapshot: jest.fn(async () => snapshot) };
  const builder = { configured: false, health: jest.fn() };
  const config = { githubRepo: 'acme-org/mobile-app', workflowFile: 'release.yml', playKeyFile: '/k.json' };
  const versions = new VersionCodes(play as never);
  const local = { knownCodes: jest.fn(async () => opts.known ?? []) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new SetupService(gh as any, pipeline as any, play as any, builder as any, config as any, versions, local as any);
}

describe('SetupService token check', () => {
  it('names the token owner and the fine-grained fix when the repository is hidden (404)', async () => {
    const s = service({
      repo: () => Promise.reject(new GithubError('GitHub has no repository (404), or the token cannot see acme-org/mobile-app.', 404, 404)),
      user: () => Promise.resolve({ login: 'dev-one' }),
    });
    const token = (await s.status()).checks.find((c) => c.key === 'token');
    expect(token?.state).toBe('error');
    expect(token?.detail).toBe('The token of @dev-one works, but GitHub hides acme-org/mobile-app from it (404).');
    expect(token?.fix).toContain('Resource owner "acme-org"');
    expect(token?.fix).toContain('Repository access "mobile-app"');
  });

  it('still explains a hidden repository when the owner cannot be read', async () => {
    const s = service({
      repo: () => Promise.reject(new GithubError('404', 404, 404)),
      user: () => Promise.reject(new GithubError('403', 403, 403)),
    });
    const token = (await s.status()).checks.find((c) => c.key === 'token');
    expect(token?.detail).toBe('The token works, but GitHub hides acme-org/mobile-app from it (404).');
  });

  it('shows the version code the next console run gets, above Play and every run on this server', async () => {
    const hidden = () => Promise.reject(new GithubError('404', 404, 404));
    const user = () => Promise.resolve({ login: 'x' });
    expect((await service({ repo: hidden, user, playHighest: 9 }).status()).nextVersionCode).toBe(1001);
    expect((await service({ repo: hidden, user, playHighest: 9, known: [1001, 1004] }).status()).nextVersionCode).toBe(1005);
    expect((await service({ repo: hidden, user, playHighest: 2000 }).status()).nextVersionCode).toBe(2001);
    expect((await service({ repo: hidden, user }).status()).nextVersionCode).toBeNull();
  });

  it('passes any other refusal through as GitHub worded it', async () => {
    const s = service({
      repo: () => Promise.reject(new GithubError('GitHub refused the token (401): it is wrong, expired or revoked.', 502, 401)),
      user: () => Promise.resolve({ login: 'x' }),
    });
    const token = (await s.status()).checks.find((c) => c.key === 'token');
    expect(token?.detail).toBe('GitHub refused the token (401): it is wrong, expired or revoked.');
    expect(token?.fix).toBeUndefined();
  });
});
