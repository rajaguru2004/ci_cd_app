import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { createWriteStream, promises as fs } from 'fs';
import type { IncomingMessage } from 'http';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { PROTOCOL, type Assignment, type CompleteRequest, type ConnectReply, type ConnectRequest, type EventsRequest, type HostFacts, type JobReport, type PollReply } from './mac-protocol';
import { fingerprint, parsePublicKey, SealError } from './seal';
import type { RunStore } from './store';
import type { Conclusion, MacRemote, MacRunnerRecord, RunRecord, Status } from './types';
import type { Vault } from './vault';

/**
 * The Macs the console hands iOS runs to, and the runs waiting for one.
 *
 * A Mac runner is an agent on a Mac (a container, or a process) that dials out to the console with
 * a token made here: it connects, long-polls for work, takes one run at a time and reports its
 * jobs, steps and log lines as they happen. The console never reaches into the Mac. Tokens are
 * kept as hashes; each agent's X25519 key is pinned on its first connect, and a run's secrets
 * are sealed to that key when the run is offered.
 *
 * A run is followed here from the moment its Plan job hands it over until it ends: offered to the
 * first free Mac, accepted, reported on, completed, or failed when its Mac goes quiet, when no
 * Mac takes it in time, or cancelled.
 */

export class MacError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'MacError';
  }
}

/** A run the pool follows: the runner's live record (the only copy anyone writes) and its folders. */
export interface MacRun {
  run: RunRecord;
  save(): Promise<void>;
  logsDir: string;
  artifactsDir: string;
  /** The packed source the Mac downloads. */
  sourceFile: string;
  /** The work order for the Mac that takes the run, its secrets sealed to that Mac's key. */
  assignment(runner: MacRunnerRecord): Promise<Assignment>;
  /** A line in the Plan job's log: who took the run, who went quiet. */
  note(text: string): void;
}

export interface MacRunnerView {
  id: string;
  name: string;
  tokenHint: string;
  tokenCreatedAt: string;
  createdAt: string;
  lastSeenAt: string | null;
  lastAddress: string | null;
  online: boolean;
  /** offline · not-ready (online, but its Mac cannot build) · idle · busy */
  state: 'offline' | 'not-ready' | 'idle' | 'busy';
  run: { id: number; appId: string | null; appName: string | null; number: number } | null;
  keyFingerprint: string | null;
  keyPinnedAt: string | null;
  refusedKey: MacRunnerRecord['refusedKey'];
  agent: MacRunnerRecord['agent'];
  host: HostFacts | null;
}

interface Followed extends MacRun {
  finished: boolean;
  wake: () => void;
}

interface Poller {
  runnerId: string;
  resolve: (reply: Assignment | null) => void;
}

/** Artifacts a Mac may send, and the file names allowed in them. */
export const MAC_ARTIFACTS = ['test-results', 'app-release-ipa', 'build-info', 'store-release'] as const;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TOKEN = /^rcr_([a-f0-9]{8})_([A-Za-z0-9_-]{43})$/;
const ID = /^[a-f0-9]{8}$/;
const MAX_LOG_TEXT = 2 * 1024 * 1024;
const MAX_ARTIFACT = 4 * 1024 * 1024 * 1024;

const now = () => new Date().toISOString();
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : null);

export const macRemote = (run: RunRecord): MacRemote => {
  if (run.remote?.kind !== 'mac') throw new MacError(`Run ${run.id} does not run on a Mac.`, 409);
  return run.remote;
};

const STATUS = (s: unknown): Status => (s === 'completed' || s === 'in_progress' ? s : 'queued');
const CONCLUSION = (status: Status, c: unknown): Conclusion =>
  status !== 'completed' ? null : c === 'success' || c === 'skipped' || c === 'cancelled' ? c : 'failure';

function sanitizeHost(h: unknown): HostFacts | null {
  if (!h || typeof h !== 'object') return null;
  const x = h as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  const problems = Array.isArray(x.problems) ? x.problems.filter((p): p is string => typeof p === 'string').map((p) => p.slice(0, 400)).slice(0, 12) : [];
  return {
    checkedAt: clip(x.checkedAt, 40) ?? now(),
    reachable: x.reachable === true,
    os: clip(x.os, 80),
    arch: clip(x.arch, 20),
    hostname: clip(x.hostname, 120),
    cpu: clip(x.cpu, 120),
    memoryGb: n(x.memoryGb),
    diskFreeGb: n(x.diskFreeGb),
    xcode: clip(x.xcode, 80),
    iosSdk: clip(x.iosSdk, 40),
    flutter: clip(x.flutter, 80),
    cocoapods: clip(x.cocoapods, 40),
    ruby: clip(x.ruby, 80),
    fastlane: clip(x.fastlane, 80),
    problems,
    ready: x.ready === true && x.reachable === true && problems.length === 0,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class MacPool {
  /** How long a poll is held open waiting for work. */
  static pollMs = 25_000;
  /** Seen within this long: online. */
  static onlineMs = 75_000;
  /** An offer not taken in this long goes back to the queue. */
  static offerMs = 60_000;
  /** No report from the Mac for this long while it runs: the run failed. */
  static leaseMs = 3 * 60_000;
  /** A run waits this long for a Mac. */
  static waitMs = 12 * 60 * 60_000;
  /** After a cancel, the Mac has this long to say it stopped. */
  static cancelGraceMs = 2 * 60_000;
  /** How often followed runs are checked for the deadlines above. */
  static tickMs = 5_000;

  private readonly queue: number[] = [];
  private readonly followed = new Map<number, Followed>();
  private readonly pollers: Poller[] = [];
  private readonly seen = new Map<string, { at: number; address: string | null; written: number }>();

  constructor(
    private readonly vault: Vault,
    private readonly store: RunStore,
  ) {}

  // ─── Records ─────────────────────────────────────────────────────────────────────────

  async records(): Promise<MacRunnerRecord[]> {
    const out: MacRunnerRecord[] = [];
    for (const f of await this.vault.list('macs')) {
      const id = f.replace(/\.json$/, '');
      if (!ID.test(id)) continue;
      const rec = await this.record(id);
      if (rec) out.push(rec);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async record(id: string): Promise<MacRunnerRecord | null> {
    return ID.test(id) ? this.vault.getJson<MacRunnerRecord>(`macs/${id}.json`) : null;
  }

  async list(): Promise<MacRunnerView[]> {
    return (await this.records()).map((r) => this.view(r));
  }

  async create(nameInput: unknown): Promise<{ runner: MacRunnerView; token: string }> {
    const name = this.checkName(nameInput);
    if ((await this.records()).some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new MacError(`There is already a Mac runner called ${name}.`, 409);
    let id = randomBytes(4).toString('hex');
    while (await this.record(id)) id = randomBytes(4).toString('hex');
    const t = newToken(id);
    const at = now();
    const rec: MacRunnerRecord = {
      id,
      name,
      tokenHash: t.hash,
      tokenHint: t.hint,
      tokenCreatedAt: at,
      publicKey: null,
      keyFingerprint: null,
      keyPinnedAt: null,
      refusedKey: null,
      createdAt: at,
      lastSeenAt: null,
      lastAddress: null,
      agent: null,
      host: null,
    };
    await this.write(rec);
    return { runner: this.view(rec), token: t.token };
  }

  /** A new token for the runner; the old one stops working at once. */
  async rotate(id: string): Promise<{ runner: MacRunnerView; token: string }> {
    const rec = await this.require(id);
    const t = newToken(id);
    rec.tokenHash = t.hash;
    rec.tokenHint = t.hint;
    rec.tokenCreatedAt = now();
    await this.write(rec);
    this.dropPollers(id);
    return { runner: this.view(rec), token: t.token };
  }

  async rename(id: string, nameInput: unknown): Promise<MacRunnerView> {
    const rec = await this.require(id);
    const name = this.checkName(nameInput);
    if ((await this.records()).some((r) => r.id !== id && r.name.toLowerCase() === name.toLowerCase())) throw new MacError(`There is already a Mac runner called ${name}.`, 409);
    rec.name = name;
    await this.write(rec);
    return this.view(rec);
  }

  /** Forgets the pinned agent key, so the next agent that connects with the token is pinned instead. */
  async resetKey(id: string): Promise<MacRunnerView> {
    const rec = await this.require(id);
    rec.publicKey = null;
    rec.keyFingerprint = null;
    rec.keyPinnedAt = null;
    rec.refusedKey = null;
    await this.write(rec);
    return this.view(rec);
  }

  async remove(id: string): Promise<void> {
    const rec = await this.require(id);
    const busy = this.runOf(id);
    if (busy) throw new MacError(`${rec.name} is running ${busy.run.app?.name ?? 'a run'} #${busy.run.number}; cancel it, or wait for it to end.`, 409);
    await this.vault.remove(`macs/${id}.json`);
    this.dropPollers(id);
    this.seen.delete(id);
  }

  view(rec: MacRunnerRecord): MacRunnerView {
    const seen = Math.max(this.seen.get(rec.id)?.at ?? 0, Date.parse(rec.lastSeenAt ?? '') || 0);
    const online = seen > 0 && Date.now() - seen < MacPool.onlineMs;
    const busy = this.runOf(rec.id);
    return {
      id: rec.id,
      name: rec.name,
      tokenHint: rec.tokenHint,
      tokenCreatedAt: rec.tokenCreatedAt,
      createdAt: rec.createdAt,
      lastSeenAt: seen ? new Date(seen).toISOString() : null,
      lastAddress: this.seen.get(rec.id)?.address ?? rec.lastAddress,
      online,
      state: !online ? 'offline' : busy ? 'busy' : rec.host?.ready ? 'idle' : 'not-ready',
      run: busy ? { id: busy.run.id, appId: busy.run.app?.id ?? null, appName: busy.run.app?.name ?? null, number: busy.run.number } : null,
      keyFingerprint: rec.keyFingerprint,
      keyPinnedAt: rec.keyPinnedAt,
      refusedKey: rec.refusedKey,
      agent: rec.agent,
      host: rec.host,
    };
  }

  /** Runs handed over by their Plan job and still waiting for a Mac, oldest first. */
  waiting(): Array<{ id: number; appId: string | null; appName: string | null; number: number; queuedAt: string | null }> {
    return this.queue
      .map((id) => this.followed.get(id))
      .filter((f): f is Followed => Boolean(f))
      .map((f) => ({ id: f.run.id, appId: f.run.app?.id ?? null, appName: f.run.app?.name ?? null, number: f.run.number, queuedAt: macRemote(f.run).queuedAt }));
  }

  async summary(): Promise<{ registered: number; online: number; ready: number; busy: number; waiting: number }> {
    const views = await this.list();
    return {
      registered: views.length,
      online: views.filter((v) => v.online).length,
      ready: views.filter((v) => v.state === 'idle' || v.state === 'busy').length,
      busy: views.filter((v) => v.state === 'busy').length,
      waiting: this.queue.length,
    };
  }

  // ─── The agent's side ────────────────────────────────────────────────────────────────

  async authenticate(header: unknown): Promise<MacRunnerRecord> {
    const m = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
    const t = m ? TOKEN.exec(m[1]) : null;
    const refused = new MacError('The console does not know this runner token (wrong, rotated, or its runner was removed): put the token from the console’s Runners page in the Mac’s .env.', 401);
    if (!t) throw refused;
    const rec = await this.record(t[1]);
    if (!rec) throw refused;
    const given = sha256(t[2]);
    const held = Buffer.from(rec.tokenHash, 'hex');
    if (held.length !== given.length || !timingSafeEqual(held, given)) throw refused;
    return rec;
  }

  async connect(rec: MacRunnerRecord, body: Partial<ConnectRequest>, address: string | null): Promise<ConnectReply> {
    if (body.protocol !== PROTOCOL) {
      throw new MacError(`This runner speaks protocol ${String(body.protocol ?? '?')} and the console speaks ${PROTOCOL}: pull the image this console names (docker compose pull), then start it again.`, 426);
    }
    let raw: Buffer;
    try {
      raw = parsePublicKey(body.publicKey);
    } catch (e) {
      throw new MacError((e as SealError).message);
    }
    const key = raw.toString('base64');
    const fp = fingerprint(raw);
    if (!rec.publicKey) {
      rec.publicKey = key;
      rec.keyFingerprint = fp;
      rec.keyPinnedAt = now();
      rec.refusedKey = null;
    } else if (rec.publicKey !== key) {
      rec.refusedKey = { fingerprint: fp, at: now() };
      await this.write(rec);
      throw new MacError(
        `This runner’s key changed: it offers ${fp}, the console holds ${rec.keyFingerprint}. If the runner was reinstalled (its data volume is new), reset its key on the console’s Runners page.`,
        409,
      );
    }
    rec.agent = {
      version: clip(body.version, 40) ?? '?',
      executor: body.executor === 'local' ? 'local' : 'ssh',
      hostUser: clip(body.hostUser, 64),
      hostAddress: clip(body.hostAddress, 120),
    };
    rec.host = sanitizeHost(body.host);
    rec.lastSeenAt = now();
    rec.lastAddress = address;
    await this.write(rec);
    this.touch(rec.id, address, true);
    return { runner: { id: rec.id, name: rec.name }, pollSeconds: Math.round(MacPool.pollMs / 1000), abort: await this.reconcile(rec, body.activeRun ?? null) };
  }

  /** Waits up to pollMs for a run to offer this Mac; a Mac that is busy or not ready gets none. */
  async poll(rec: MacRunnerRecord, body: { activeRun?: unknown }, address: string | null, signal: AbortSignal): Promise<PollReply> {
    if (!rec.publicKey) throw new MacError('Connect first: the console has no key for this runner yet.', 409);
    await this.touch(rec.id, address);
    const active = typeof body.activeRun === 'number' ? body.activeRun : null;
    const abort = await this.reconcile(rec, active);
    if (active !== null || !rec.host?.ready) {
      // Nothing to hand out: hold the poll anyway, so an agent that keeps asking does not spin.
      await new Promise<void>((r) => {
        const t = setTimeout(r, active !== null ? 0 : MacPool.pollMs);
        signal.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
      });
      return { assignment: null, abort };
    }
    this.dropPollers(rec.id);
    const assignment = await new Promise<Assignment | null>((resolve) => {
      const poller: Poller = { runnerId: rec.id, resolve: (a) => (clearTimeout(timer), resolve(a)) };
      const timer = setTimeout(() => {
        this.removePoller(poller);
        resolve(null);
      }, MacPool.pollMs);
      signal.addEventListener('abort', () => {
        this.removePoller(poller);
        clearTimeout(timer);
        resolve(null);
      }, { once: true });
      this.pollers.push(poller);
      this.dispatch();
    });
    return { assignment, abort };
  }

  async accept(rec: MacRunnerRecord, runId: number): Promise<void> {
    const f = this.followed.get(runId);
    const remote = f ? macRemote(f.run) : null;
    if (!f || !remote || remote.runnerId !== rec.id || (remote.state !== 'offered' && remote.state !== 'running')) {
      throw new MacError('That run is no longer offered to this runner (it was cancelled, or it waited too long and went to another Mac).', 409);
    }
    if (remote.state === 'offered') {
      remote.state = 'running';
      remote.acceptedAt = remote.lastHeardAt = now();
      await f.save();
      f.note(`${rec.name} took the run${rec.host?.os ? ` (${rec.host.os}${rec.host.xcode ? `, ${rec.host.xcode}` : ''})` : ''}.`);
    }
  }

  /** The packed source of a run offered to or running on this Mac. */
  sourceFor(rec: MacRunnerRecord, runId: number): string {
    return this.mine(rec, runId, true).sourceFile;
  }

  async report(rec: MacRunnerRecord, runId: number, body: Partial<EventsRequest>): Promise<{ cancel: boolean }> {
    const f = this.followed.get(runId);
    if (!f) return this.untracked(runId);
    const remote = macRemote(f.run);
    if (remote.state === 'done' || f.run.status === 'completed') return { cancel: true };
    if (remote.runnerId !== rec.id) throw new MacError('That run is not this runner’s.', 409);
    if (remote.state === 'offered') remote.state = 'running';
    remote.acceptedAt ??= now();
    remote.lastHeardAt = now();
    // A Mac busy with a run reports instead of polling: that keeps it online too.
    await this.touch(rec.id, this.seen.get(rec.id)?.address ?? null);
    await this.apply(f, body);
    await f.save();
    return { cancel: remote.cancelRequested };
  }

  async complete(rec: MacRunnerRecord, runId: number, body: Partial<CompleteRequest>): Promise<void> {
    const f = this.followed.get(runId);
    if (!f) {
      await this.untracked(runId);
      return;
    }
    const remote = macRemote(f.run);
    if (remote.state === 'done' || f.run.status === 'completed') return;
    if (remote.runnerId !== rec.id) throw new MacError('That run is not this runner’s.', 409);
    remote.lastHeardAt = now();
    await this.apply(f, body);
    const ends = f.run.jobs.filter((j) => j.name !== 'Plan').map((j) => j.conclusion);
    const said = body.conclusion;
    const conclusion: Conclusion =
      said === 'cancelled' || ends.includes('cancelled') ? 'cancelled' : said === 'failure' || ends.includes('failure') || said !== 'success' ? 'failure' : 'success';
    const error = clip(body.error, 1000);
    this.finish(f, conclusion, error && conclusion !== 'success' ? `${rec.name}: ${error}` : null);
    f.note(`${rec.name} finished the run: ${conclusion}.`);
  }

  /** Stores one output file of a run (streamed; at most 4 GB). */
  async artifact(rec: MacRunnerRecord, runId: number, name: string, file: string, body: IncomingMessage): Promise<{ sizeBytes: number }> {
    const f = this.mine(rec, runId, false);
    if (!(MAC_ARTIFACTS as readonly string[]).includes(name)) throw new MacError(`A Mac runner sends ${MAC_ARTIFACTS.join(', ')}; not ${name}.`);
    if (!FILE.test(file)) throw new MacError(`'${file}' is not an artifact file name.`);
    const declared = Number(body.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_ARTIFACT) throw new MacError('That file is larger than 4 GB.', 413);
    const dir = join(f.artifactsDir, name);
    await fs.mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${file}.${randomBytes(4).toString('hex')}.part`);
    let size = 0;
    try {
      await pipeline(
        body,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > MAX_ARTIFACT) throw new MacError('That file is larger than 4 GB.', 413);
            yield chunk;
          }
        },
        createWriteStream(tmp, { mode: 0o640 }),
      );
      await fs.rename(tmp, join(dir, file));
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    macRemote(f.run).lastHeardAt = now();
    return { sizeBytes: size };
  }

  // ─── The runner's side ───────────────────────────────────────────────────────────────

  /**
   * Hands a planned run to the Macs and follows it until it ends. Resolves with the run's
   * conclusion (and error) set on the record; the caller closes the jobs and saves.
   */
  async follow(m: MacRun, signal: AbortSignal): Promise<void> {
    const run = m.run;
    const remote = macRemote(run);
    let wake: () => void = () => undefined;
    const f: Followed = Object.assign(m, { finished: false, wake: () => wake() });
    this.followed.set(run.id, f);
    try {
      if (remote.state === 'running') {
        // Picked up again after the console restarted: the Mac carried on and reports soon.
        remote.lastHeardAt = now();
        m.note(`Following the run on ${remote.runnerName ?? 'its Mac'} again after the console restarted.`);
      } else {
        await this.enqueue(f);
      }
      let cancelAt = 0;
      while (!f.finished) {
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, MacPool.tickMs);
        });
        if (f.finished) break;
        const t = Date.now();
        const since = (iso: string | null) => t - (Date.parse(iso ?? '') || t);
        if (signal.aborted) {
          if (remote.state === 'waiting' || remote.state === 'offered') {
            m.note(remote.state === 'offered' ? `Cancelled while ${remote.runnerName} was taking it.` : 'Cancelled before a Mac took it.');
            this.finish(f, 'cancelled', null);
            break;
          }
          if (!cancelAt) {
            cancelAt = t;
            remote.cancelRequested = true;
            await m.save();
            m.note(`Cancel sent to ${remote.runnerName}.`);
          } else if (t - cancelAt > MacPool.cancelGraceMs) {
            this.finish(f, 'cancelled', `${remote.runnerName} did not confirm the cancel in ${Math.round(MacPool.cancelGraceMs / 60_000)} minutes; the console stopped waiting for it.`);
            break;
          }
        }
        if (remote.state === 'offered' && since(remote.offeredAt) > MacPool.offerMs) {
          m.note(`${remote.runnerName} did not take the run in time; it waits for a Mac again.`);
          await this.enqueue(f);
        } else if (remote.state === 'waiting' && since(remote.queuedAt) > MacPool.waitMs) {
          this.finish(f, 'failure', `No Mac runner took this run in ${Math.round(MacPool.waitMs / 3_600_000)} hours. Check the Runners page: a Mac must be online and ready.`);
        } else if (remote.state === 'running' && since(remote.lastHeardAt) > MacPool.leaseMs) {
          const minutes = Math.max(1, Math.round(since(remote.lastHeardAt) / 60_000));
          this.finish(
            f,
            'failure',
            `${remote.runnerName} stopped reporting during the run (last heard ${minutes} minute${minutes === 1 ? '' : 's'} ago). Check the Mac and its runner (docker compose logs runner on the Mac), then start the run again.`,
          );
        }
      }
    } finally {
      this.followed.delete(run.id);
      this.unqueue(run.id);
    }
  }

  // ─── internals ───────────────────────────────────────────────────────────────────────

  private async enqueue(f: Followed): Promise<void> {
    const remote = macRemote(f.run);
    remote.state = 'waiting';
    remote.runnerId = null;
    remote.runnerName = null;
    remote.offeredAt = null;
    remote.queuedAt ??= now();
    await f.save();
    if (!this.queue.includes(f.run.id)) this.queue.push(f.run.id);
    const s = await this.summary();
    f.note(
      s.registered === 0
        ? 'Waiting for a Mac runner: none is set up yet (Runners → Add a Mac).'
        : s.ready - s.busy > 0
          ? `Waiting for a Mac runner: ${s.ready - s.busy} ready.`
          : `Waiting for a Mac runner: ${s.registered} set up, ${s.online} online, ${s.busy} busy; the run starts when one is free and ready.`,
    );
    this.dispatch();
  }

  /** Pairs waiting polls with waiting runs, oldest of each first. */
  private dispatch(): void {
    while (this.queue.length && this.pollers.length) {
      const poller = this.pollers.shift()!;
      const runId = this.queue.shift()!;
      void this.offer(poller.runnerId, runId).then(
        (a) => {
          poller.resolve(a);
          if (!a) this.dispatch();
        },
        (e: unknown) => {
          console.error(`offering run ${runId}: ${(e as Error).stack ?? e}`);
          poller.resolve(null);
        },
      );
    }
  }

  private async offer(runnerId: string, runId: number): Promise<Assignment | null> {
    const f = this.followed.get(runId);
    const rec = await this.record(runnerId);
    if (!f || f.finished || f.run.status === 'completed') return null;
    if (!rec) {
      if (!this.queue.includes(runId)) this.queue.unshift(runId);
      return null;
    }
    const remote = macRemote(f.run);
    remote.state = 'offered';
    remote.runnerId = rec.id;
    remote.runnerName = rec.name;
    remote.offeredAt = now();
    try {
      const a = await f.assignment(rec);
      await f.save();
      f.note(`Offered to ${rec.name}.`);
      return a;
    } catch (e) {
      this.finish(f, 'failure', `The run could not be handed to ${rec.name}: ${(e as Error).message}`);
      return null;
    }
  }

  private finish(f: Followed, conclusion: Conclusion, error: string | null): void {
    if (f.finished) return;
    const remote = macRemote(f.run);
    remote.state = 'done';
    remote.cancelRequested = false;
    f.run.conclusion = conclusion;
    if (error) f.run.error ??= error;
    f.finished = true;
    this.unqueue(f.run.id);
    f.wake();
  }

  /**
   * What the agent says it runs against what the console thinks: a run the console has on this
   * Mac that the agent no longer has failed (the agent restarted); one the agent has that the
   * console does not want any more is to be stopped.
   */
  private async reconcile(rec: MacRunnerRecord, active: number | null): Promise<number[]> {
    for (const f of this.followed.values()) {
      const remote = macRemote(f.run);
      if (remote.runnerId !== rec.id || f.run.id === active || f.finished) continue;
      if (remote.state === 'running') {
        f.note(`${rec.name} no longer has the run (its agent restarted).`);
        this.finish(f, 'failure', `${rec.name} restarted during the run, so it was lost there. Start the run again.`);
      } else if (remote.state === 'offered' && active === null) {
        // The offer never reached the agent (its poll was cut): back to the queue at once.
        await this.enqueue(f);
      }
    }
    if (active === null) return [];
    const f = this.followed.get(active);
    if (f && macRemote(f.run).runnerId === rec.id && !f.finished) return [];
    const run = f ? null : await this.store.get(active);
    // Unknown here but still running on disk: the console is starting and resumes it in a moment.
    if (run && run.status !== 'completed' && run.remote?.kind === 'mac' && run.remote.runnerId === rec.id) return [];
    return [active];
  }

  private async untracked(runId: number): Promise<{ cancel: boolean }> {
    const run = await this.store.get(runId);
    if (run && run.status !== 'completed' && run.remote?.kind === 'mac') {
      throw new MacError('The console is resuming this run after a restart; report it again in a moment.', 503);
    }
    return { cancel: true };
  }

  private mine(rec: MacRunnerRecord, runId: number, offeredToo: boolean): Followed {
    const f = this.followed.get(runId);
    const remote = f ? macRemote(f.run) : null;
    const ok = remote && remote.runnerId === rec.id && (remote.state === 'running' || (offeredToo && remote.state === 'offered'));
    if (!f || !ok) throw new MacError('That run is not running on this runner.', 409);
    return f;
  }

  private runOf(runnerId: string): Followed | null {
    for (const f of this.followed.values()) {
      const remote = macRemote(f.run);
      if (remote.runnerId === runnerId && (remote.state === 'offered' || remote.state === 'running') && !f.finished) return f;
    }
    return null;
  }

  /** Job and step states and log lines from the Mac into the run (only its Mac jobs, never Plan). */
  private async apply(f: Followed, body: Partial<EventsRequest>): Promise<void> {
    for (const j of (Array.isArray(body.jobs) ? body.jobs : []).slice(0, 10) as JobReport[]) {
      const job = f.run.jobs.find((x) => x.name === j?.name && x.name !== 'Plan');
      if (!job) continue;
      job.status = STATUS(j.status);
      job.conclusion = CONCLUSION(job.status, j.conclusion);
      job.started_at = clip(j.started_at, 40);
      job.completed_at = job.status === 'completed' ? clip(j.completed_at, 40) : null;
      if (Array.isArray(j.steps) && j.steps.length) {
        job.steps = j.steps.slice(0, 60).map((s, i) => {
          const status = STATUS(s?.status);
          return {
            name: clip(s?.name, 200) ?? `Step ${i + 1}`,
            number: Number.isInteger(s?.number) ? s.number : i + 1,
            status,
            conclusion: CONCLUSION(status, s?.conclusion),
            started_at: clip(s?.started_at, 40),
            completed_at: status === 'completed' ? clip(s?.completed_at, 40) : null,
          };
        });
      }
    }
    let budget = MAX_LOG_TEXT;
    for (const l of Array.isArray(body.logs) ? body.logs : []) {
      const job = f.run.jobs.find((x) => x.name === l?.job && x.name !== 'Plan');
      if (!job || typeof l.text !== 'string' || !l.text) continue;
      const text = l.text.slice(0, budget);
      budget -= text.length;
      await fs.appendFile(join(f.logsDir, `${job.id}.log`), text.endsWith('\n') ? text : `${text}\n`);
      if (budget <= 0) break;
    }
  }

  private async touch(id: string, address: string | null, written = false): Promise<void> {
    const prev = this.seen.get(id);
    const t = Date.now();
    this.seen.set(id, { at: t, address, written: written ? t : (prev?.written ?? 0) });
    // lastSeenAt reaches the record at most once a minute; presence lives in memory.
    if (!written && t - (prev?.written ?? 0) > 60_000) {
      const rec = await this.record(id);
      if (!rec) return;
      rec.lastSeenAt = new Date(t).toISOString();
      rec.lastAddress = address;
      await this.write(rec);
      this.seen.get(id)!.written = t;
    }
  }

  private dropPollers(runnerId: string): void {
    for (const p of this.pollers.filter((x) => x.runnerId === runnerId)) {
      this.removePoller(p);
      p.resolve(null);
    }
  }

  private removePoller(p: Poller): void {
    const i = this.pollers.indexOf(p);
    if (i >= 0) this.pollers.splice(i, 1);
  }

  private unqueue(runId: number): void {
    const i = this.queue.indexOf(runId);
    if (i >= 0) this.queue.splice(i, 1);
  }

  private async require(id: string): Promise<MacRunnerRecord> {
    const rec = await this.record(id);
    if (!rec) throw new MacError('There is no such Mac runner.', 404);
    return rec;
  }

  private checkName(input: unknown): string {
    const name = (typeof input === 'string' ? input : '').trim().replace(/\s+/g, ' ');
    if (!name) throw new MacError('Give the Mac a name (e.g. "Studio Mac mini").');
    if (name.length > 60) throw new MacError('Keep the name under 60 characters.');
    return name;
  }

  private async write(rec: MacRunnerRecord): Promise<void> {
    await this.vault.putJson(`macs/${rec.id}.json`, rec);
  }
}

function newToken(id: string): { token: string; hash: string; hint: string } {
  const secret = randomBytes(32).toString('base64url');
  return { token: `rcr_${id}_${secret}`, hash: sha256(secret).toString('hex'), hint: secret.slice(-4) };
}

export { sleep as macSleep };
