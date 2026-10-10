import { checkBranch, commitUrl, explainGitFailure, parseRepoUrl } from './git';

describe('parseRepoUrl', () => {
  it('reads the scp form GitHub shows, and the ssh:// form with a port', () => {
    expect(parseRepoUrl('git@github.com:the-reciprocal-solutions/human-resource-management-mobile-ess.git')).toMatchObject({
      user: 'git', host: 'github.com', port: null, path: 'the-reciprocal-solutions/human-resource-management-mobile-ess.git',
      webUrl: 'https://github.com/the-reciprocal-solutions/human-resource-management-mobile-ess', hostLabel: 'GitHub',
    });
    expect(parseRepoUrl('ssh://git@git.internal.lan:2222/mobile/app.git')).toMatchObject({ host: 'git.internal.lan', port: 2222, webUrl: null, hostLabel: 'git.internal.lan' });
    expect(parseRepoUrl('  git@gitlab.com:org/sub/app.git ')).toMatchObject({ hostLabel: 'GitLab', webUrl: 'https://gitlab.com/org/sub/app' });
  });

  it('turns an HTTPS address into the SSH one to use instead', () => {
    expect(() => parseRepoUrl('https://github.com/rajaguru2004/hive_sphere.git')).toThrow('Use git@github.com:rajaguru2004/hive_sphere.git');
  });

  it.each([
    ['', 'Paste the repository'],
    ['/srv/git/app.git', 'not an SSH URL'],
    ['file:///etc/passwd', 'not an SSH URL'],
    ['ext::sh -c touch% /tmp/pwned', 'not an SSH URL'],
    ['git@-oProxyCommand:org/app.git', 'cannot use safely'],
    ['git@-oProxyCommand=evil:org/app.git', 'not an SSH URL'],
    ['git@github.com:org/../../etc.git', 'cannot use safely'],
    ['git@github.com:-u/app.git', 'cannot use safely'],
    ['ssh://git@github.com:99999/org/app.git', 'cannot use safely'],
  ])('refuses %j', (url, message) => {
    expect(() => parseRepoUrl(url)).toThrow(message);
  });
});

describe('commitUrl', () => {
  it('links commits on the hosts it knows', () => {
    expect(commitUrl(parseRepoUrl('git@github.com:o/r.git'), 'abc')).toBe('https://github.com/o/r/commit/abc');
    expect(commitUrl(parseRepoUrl('git@gitlab.com:o/r.git'), 'abc')).toBe('https://gitlab.com/o/r/-/commit/abc');
    expect(commitUrl(parseRepoUrl('git@bitbucket.org:o/r.git'), 'abc')).toBe('https://bitbucket.org/o/r/commits/abc');
    expect(commitUrl(parseRepoUrl('ssh://git@gitserver/srv/r.git'), 'abc')).toBeNull();
  });
});

describe('checkBranch', () => {
  it('accepts branch names and refuses option-like or climbing ones', () => {
    expect(checkBranch('feat/crm-project-attendance')).toBe('feat/crm-project-attendance');
    for (const bad of ['', '-x', 'a..b', 'a//b', 'trailing/', 'a b']) expect(() => checkBranch(bad)).toThrow('is not a branch name');
  });
});

describe('explainGitFailure', () => {
  const repo = parseRepoUrl('git@github.com:org/app.git');
  const key = { id: 'k_0123456789', email: 'dev@company.com', name: null, publicKey: '', fingerprint: '', createdAt: '', lastUsedAt: null };

  it('says the key is not on the account yet', () => {
    expect(explainGitFailure('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', repo, key).message).toMatch(
      /^github.com refused the key for dev@company.com \(Permission denied\)\. Add its public key to the GitHub account that can open org\/app/,
    );
  });

  it('separates a missing repository, an unknown host, a silent host and a changed host key', () => {
    expect(explainGitFailure('ERROR: Repository not found.\nfatal: Could not read from remote repository.', repo, key).message).toContain('was not found there');
    expect(explainGitFailure('ssh: Could not resolve hostname github.co: Name or service not known', repo, key).message).toContain('could not be found (DNS)');
    expect(explainGitFailure('ssh: connect to host github.com port 22: Connection timed out', repo, key).status).toBe(502);
    expect(explainGitFailure('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@', repo, key).message).toContain('may be intercepted');
  });
});
