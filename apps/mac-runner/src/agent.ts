import { promises as fs } from 'fs';
import { join } from 'path';
import { ConsoleApi, ConsoleError } from './api';
import type { AgentConfig } from './config';
import { Executor, LocalExecutor, SshExecutor } from './executor';
import { probeHost, type HostEnv } from './host';
import { HostKeyPin, loadKeys, type AgentKeys } from './keys';
import { PROTOCOL, type Assignment, type ConnectReply, type HostFacts } from './protocol';
import { RunExecution, SWEEP_SCRIPT } from './run';

/**
 * The Mac runner: dials out to the console, says what its Mac can do, long-polls for an iOS run,
 * runs it on the Mac and reports back, then polls again. One run at a time. Every failure is
 * waited out and tried again (the console restarting, the network, the Mac asleep), never a
 * reason to exit; what a person must fix is said in the log and on the console's Runners page.
 */

export const HEALTH_FILE = '/tmp/release-console-runner.alive';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function say(line: string): void {
  if (process.env.RUNNER_QUIET === '1') return;
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

export function makeExecutor(cfg: AgentConfig, keys: AgentKeys): Executor {
  return cfg.executor === 'local'
    ? new LocalExecutor()
    : new SshExecutor({ host: cfg.macHost, port: cfg.macPort, user: cfg.macUser, privateKey: keys.sshPrivate, pin: new HostKeyPin(join(cfg.dataDir, 'ssh', 'host_key')) });
}

export class Agent {
  private keys!: AgentKeys;
  private exec!: Executor;
  private readonly api: ConsoleApi;
  private facts: HostFacts | null = null;
  private env: HostEnv | null = null;
  private runner: ConnectReply['runner'] | null = null;
  private pollSeconds = 25;
  private current: RunExecution | null = null;
  private activeRun: number | null = null;
  private stopping = false;
  private swept = false;
  private lastProblem = '';

  constructor(private readonly cfg: AgentConfig) {
    this.api = new ConsoleApi(cfg.serverUrl, cfg.token);
  }

  async init(): Promise<void> {
    this.keys = await loadKeys(this.cfg.dataDir);
    this.exec = makeExecutor(this.cfg, this.keys);
  }

  /** Checks the Mac; returns its facts (and remembers its PATH and home for the runs). */
  async probe(): Promise<HostFacts> {
    const { facts, env } = await probeHost(this.exec, this.cfg.pathPrefix, this.cfg.macUser);
    this.facts = facts;
    if (env) this.env = env;
    if (facts.reachable && env && !this.swept) {
      // Runs a crash or a stopped container left behind: their keychains and profiles go.
      const root = this.cfg.workDir.replace(/^~(?=\/|$)/, env.home).replace(/\/+$/, '');
      const res = await this.exec.exec(SWEEP_SCRIPT(`${root}/runs`, ''), { env: { PATH: env.path }, timeoutMs: 120_000 });
      for (const l of res.stdout.split('\n').filter(Boolean)) say(l);
      this.swept = true;
    }
    const problem = facts.problems.join(' ');
    if (problem !== this.lastProblem) {
      if (problem) say(`The Mac cannot take iOS runs yet: ${problem}`);
      else say(`The Mac is ready: ${[facts.os, facts.arch, facts.xcode, facts.iosSdk, facts.flutter && `Flutter ${facts.flutter}`, facts.cocoapods && `CocoaPods ${facts.cocoapods}`, facts.fastlane && `Fastlane ${facts.fastlane}`].filter(Boolean).join(' · ')}`);
      this.lastProblem = problem;
    }
    return facts;
  }

  async connect(): Promise<ConnectReply> {
    const reply = await this.api.connect({
      protocol: PROTOCOL,
      version: this.cfg.version,
      publicKey: this.keys.sealPublic,
      executor: this.exec.kind,
      hostUser: this.env?.user || this.cfg.macUser || null,
      hostAddress: this.exec.address,
      host: this.facts,
      activeRun: this.activeRun,
    });
    if (!this.runner || this.runner.name !== reply.runner.name) say(`Connected to the console at ${this.cfg.serverUrl} as "${reply.runner.name}".`);
    this.runner = reply.runner;
    this.pollSeconds = reply.pollSeconds || 25;
    if (this.activeRun !== null && reply.abort.includes(this.activeRun)) this.current?.cancel('the console no longer wants this run');
    await this.alive();
    return reply;
  }

  async start(): Promise<void> {
    await this.init();
    say(`Release Console Mac runner ${this.cfg.version}: console ${this.cfg.serverUrl}, Mac ${this.exec.address ?? 'this machine'} (${this.exec.kind}).`);
    let lastProbe = 0;
    let lastConnect = 0;
    let failures = 0;
    let lastError = '';
    while (!this.stopping) {
      try {
        const every = this.facts?.ready ? 10 * 60_000 : 30_000;
        if (!this.facts || Date.now() - lastProbe > every) {
          await this.probe();
          lastProbe = Date.now();
          lastConnect = 0;
        }
        if (!this.runner || Date.now() - lastConnect > 5 * 60_000) {
          await this.connect();
          lastConnect = Date.now();
        }
        const reply = await this.api.poll(null, this.pollSeconds);
        await this.alive();
        if (lastError) say('The console answers again.');
        failures = 0;
        lastError = '';
        if (reply.assignment) {
          await this.take(reply.assignment);
          lastProbe = 0;
        }
      } catch (e) {
        failures += 1;
        const message = (e as Error).message;
        if (message !== lastError) say(message);
        lastError = message;
        if (e instanceof ConsoleError) {
          this.runner = e.status === 401 || e.status === 409 ? null : this.runner;
          if (e.status === 401 || e.status === 409) await sleep(60_000);
          else if (e.status === 426) await sleep(5 * 60_000);
          else await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
        } else await sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)));
      }
    }
  }

  /** Takes an offered run, runs it on the Mac, and reports how it ended. */
  private async take(a: Assignment): Promise<void> {
    if (!this.env) return;
    this.activeRun = a.runId;
    try {
      await this.api.accept(a.runId);
    } catch (e) {
      say(`Run ${a.runId} was offered, then withdrawn: ${(e as Error).message}`);
      this.activeRun = null;
      return;
    }
    say(`Running ${a.title} (run ${a.runId}).`);
    const exec = new RunExecution(a, {
      api: this.api,
      exec: this.exec,
      keys: this.keys,
      env: this.env,
      facts: this.facts,
      cfg: this.cfg,
      runnerName: this.runner?.name ?? 'this Mac',
      say,
      heartbeat: () => void this.alive(),
    });
    this.current = exec;
    try {
      const end = await exec.execute();
      say(`${a.title}: ${end.conclusion}${end.error ? ` (${end.error})` : ''}.`);
    } finally {
      this.current = null;
      this.activeRun = null;
    }
  }

  /** Stops taking runs; a run in progress is cancelled (its cleanup still runs) before the agent exits. */
  async stop(reason: string): Promise<void> {
    this.stopping = true;
    if (this.current) {
      this.current.cancel(reason);
      for (let i = 0; i < 100 && this.current; i += 1) await sleep(1000);
    }
    this.exec?.close();
  }

  private async alive(): Promise<void> {
    await fs.writeFile(HEALTH_FILE, new Date().toISOString()).catch(() => undefined);
  }
}

