import { PlayEditGuard } from './edit-guard';

const job = (name: string, status: string) => ({ id: 1, name, status, conclusion: null, started_at: null, completed_at: null, steps: [] });

function guard(opts: { local?: unknown[]; ghRuns?: Array<{ id: number; run_number: number }>; ghJobs?: Record<number, unknown[]>; ghFails?: boolean }) {
  const play = { setEditHolderProbe: jest.fn() };
  const builder = { configured: opts.local !== undefined, list: jest.fn(async () => opts.local ?? []) };
  const gh = {
    configured: opts.ghRuns !== undefined || opts.ghFails === true,
    repoPath: (p: string) => `/repos/o/r${p}`,
    get: jest.fn(async (path: string) => {
      if (opts.ghFails) throw new Error('404');
      if (path.endsWith('/runs')) return { total_count: opts.ghRuns?.length ?? 0, workflow_runs: opts.ghRuns ?? [] };
      const id = Number(/runs\/(\d+)\/jobs/.exec(path)?.[1]);
      return { total_count: 0, jobs: opts.ghJobs?.[id] ?? [] };
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { g: new PlayEditGuard(play as any, builder as any, gh as any, { workflowFile: 'release.yml' } as any), play, gh };
}

describe('PlayEditGuard', () => {
  it('registers itself as the Play client\'s probe', () => {
    const { g, play } = guard({});
    g.onModuleInit();
    expect(play.setEditHolderProbe).toHaveBeenCalled();
  });

  it('names a ZIP run whose Google Play job is running', async () => {
    const { g } = guard({
      local: [
        { id: 3, status: 'completed', jobs: [job('Google Play', 'completed')] },
        { id: 4, status: 'in_progress', jobs: [job('Signed AAB', 'completed'), job('Google Play', 'in_progress')] },
      ],
    });
    expect(await g.holder()).toBe('ZIP run #4 is uploading to Google Play.');
  });

  it('does not hold Play for a ZIP run that is still building', async () => {
    const { g } = guard({ local: [{ id: 5, status: 'in_progress', jobs: [job('Signed AAB', 'in_progress'), job('Google Play', 'queued')] }] });
    expect(await g.holder()).toBeNull();
  });

  it('names a GitHub run in its Google Play or Play access job', async () => {
    const { g, gh } = guard({
      ghRuns: [
        { id: 11, run_number: 7 },
        { id: 12, run_number: 8 },
      ],
      ghJobs: { 11: [job('Tests', 'in_progress')], 12: [job('Google Play access', 'in_progress')] },
    });
    expect(await g.holder()).toBe('GitHub run #8 is working on Google Play.');
    expect(gh.get).toHaveBeenCalledWith('/repos/o/r/actions/workflows/release.yml/runs', { status: 'in_progress', per_page: 10 });
  });

  it('holds nothing when GitHub cannot be read', async () => {
    const { g } = guard({ ghFails: true });
    expect(await g.holder()).toBeNull();
  });
});
