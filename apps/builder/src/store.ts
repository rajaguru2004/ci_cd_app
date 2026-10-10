import { promises as fs } from 'fs';
import { join } from 'path';
import type { RunRecord, RunSource } from './types';

/**
 * Runs on disk, one folder each under runs/: run.json (the record the console reads), logs/,
 * artifacts/ and, while it runs, src/ and play/. Writes go to a temporary file and are renamed
 * into place, so a reader never sees half a record.
 */
export class RunStore {
  constructor(private readonly runsDir: string) {}

  dir(id: number): string {
    return join(this.runsDir, String(id));
  }

  async init(): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true });
  }

  async nextId(): Promise<number> {
    const counter = join(this.runsDir, '.counter');
    let last = 0;
    try {
      last = Number(JSON.parse(await fs.readFile(counter, 'utf8')).last) || 0;
    } catch {
      // First run, or a lost counter: never reuse a number that has a folder.
      const ids = await this.ids();
      last = ids.length ? Math.max(...ids) : 0;
    }
    const id = last + 1;
    await this.atomicWrite(counter, JSON.stringify({ last: id }));
    return id;
  }

  async save(run: RunRecord): Promise<void> {
    await fs.mkdir(this.dir(run.id), { recursive: true });
    await this.atomicWrite(join(this.dir(run.id), 'run.json'), JSON.stringify(run, null, 2));
  }

  async get(id: number): Promise<RunRecord | null> {
    try {
      return normalize(JSON.parse(await fs.readFile(join(this.dir(id), 'run.json'), 'utf8')) as RunRecord);
    } catch {
      return null;
    }
  }

  async list(): Promise<RunRecord[]> {
    const runs: RunRecord[] = [];
    for (const id of await this.ids()) {
      const run = await this.get(id);
      if (run) runs.push(run);
    }
    return runs.sort((a, b) => b.id - a.id);
  }

  async remove(id: number): Promise<void> {
    await fs.rm(this.dir(id), { recursive: true, force: true });
  }

  private async ids(): Promise<number[]> {
    const entries = await fs.readdir(this.runsDir, { withFileTypes: true }).catch(() => []);
    return entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name)).map((e) => Number(e.name));
  }

  private async atomicWrite(path: string, data: string): Promise<void> {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, path);
  }
}

/**
 * Runs recorded before the console had apps were all ZIP runs of one app: they read as such
 * (no app until `adopt-runs` gives them one, their own id as their number).
 */
export function normalize(run: RunRecord): RunRecord {
  const legacy = run.source as unknown as Partial<RunSource> & { uploadedBy?: string };
  const source: RunSource =
    legacy.kind === 'git' || legacy.kind === 'zip'
      ? (run.source as RunSource)
      : {
          kind: 'zip',
          fileName: (legacy as { fileName?: string }).fileName ?? 'source.zip',
          upload: (legacy as { upload?: string }).upload ?? '',
          sizeBytes: (legacy as { sizeBytes?: number }).sizeBytes ?? 0,
          sha: legacy.sha ?? null,
          root: legacy.root ?? null,
          commit: null,
          startedBy: legacy.uploadedBy ?? 'console',
          rerunOf: legacy.rerunOf ?? null,
        };
  return {
    ...run,
    app: run.app ?? null,
    number: run.number ?? run.id,
    source,
    params: { ...run.params, versionCode: run.params?.versionCode ?? null },
    // Runs recorded before GitHub Actions came back all ran on this server.
    runner: run.runner ?? 'server',
    remote: run.remote ?? null,
  };
}
