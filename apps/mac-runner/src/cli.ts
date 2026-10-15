import { promises as fs } from 'fs';
import { Agent, HEALTH_FILE, makeExecutor, say } from './agent';
import { ConsoleApi, ConsoleError } from './api';
import { ConfigError, readConfig } from './config';
import { probeHost } from './host';
import { authorizedLine, loadKeys } from './keys';
import { PROTOCOL } from './protocol';

/**
 *   node dist/cli.js start     run the agent (the container's default)
 *   node dist/cli.js check     connect to the console and check the Mac once, then say what is wrong, if anything
 *   node dist/cli.js pubkey    the line to add to the Mac's ~/.ssh/authorized_keys
 *   node dist/cli.js health    exit 0 while the agent hears from the console (the container health check)
 */

async function check(): Promise<number> {
  const cfg = readConfig();
  const keys = await loadKeys(cfg.dataDir);
  const exec = makeExecutor(cfg, keys);
  const out = (ok: boolean | null, text: string) => console.log(`${ok === null ? '  ·' : ok ? '  ✓' : '  ✗'} ${text}`);
  console.log(`Release Console Mac runner ${cfg.version}\n`);
  let failed = false;
  console.log(`Mac (${exec.address ?? 'this machine'}, ${exec.kind}):`);
  const { facts, env } = await probeHost(exec, cfg.pathPrefix, cfg.macUser);
  if (!facts.reachable) out(false, facts.problems[0] ?? 'not reachable');
  else {
    out(true, `${facts.os ?? '?'} · ${facts.arch ?? '?'} · ${facts.hostname ?? ''} · ${facts.diskFreeGb ?? '?'} GB free`);
    out(Boolean(facts.xcode), `Xcode: ${facts.xcode ?? 'not found'}${facts.iosSdk ? `, ${facts.iosSdk}` : ''}`);
    out(Boolean(facts.flutter), `Flutter: ${facts.flutter ?? 'not on PATH'}`);
    out(Boolean(facts.cocoapods), `CocoaPods: ${facts.cocoapods ?? 'not installed'}`);
    out(Boolean(facts.fastlane), `Fastlane: ${facts.fastlane ?? 'neither Ruby 3 with bundler nor fastlane'}`);
    if (env) out(null, `PATH for builds: ${env.path}`);
    for (const p of facts.problems) out(false, p);
  }
  if (facts.problems.length) failed = true;
  console.log(`\nConsole (${cfg.serverUrl}):`);
  try {
    const reply = await new ConsoleApi(cfg.serverUrl, cfg.token).connect({
      protocol: PROTOCOL,
      version: cfg.version,
      publicKey: keys.sealPublic,
      executor: exec.kind,
      hostUser: env?.user || cfg.macUser || null,
      hostAddress: exec.address,
      host: facts,
      activeRun: null,
    });
    out(true, `connected as "${reply.runner.name}" (runner ${reply.runner.id})`);
    out(facts.ready, facts.ready ? 'the console hands this Mac iOS runs' : 'the console shows this Mac as not ready until the problems above are fixed');
  } catch (e) {
    failed = true;
    out(false, e instanceof ConsoleError ? e.message : (e as Error).message);
  }
  exec.close();
  return failed ? 1 : 0;
}

async function main(): Promise<number> {
  const cmd = process.argv[2] ?? 'start';
  switch (cmd) {
    case 'start': {
      const agent = new Agent(readConfig());
      for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        process.once(sig, () => {
          say(`Stopping (${sig}).`);
          void agent.stop('the runner was stopped on the Mac').then(() => process.exit(0));
        });
      }
      await agent.start();
      return 0;
    }
    case 'check':
      return check();
    case 'pubkey': {
      const cfg = readConfig(process.env, false);
      console.log(authorizedLine(await loadKeys(cfg.dataDir)));
      return 0;
    }
    case 'health': {
      const at = await fs.readFile(HEALTH_FILE, 'utf8').catch(() => '');
      return Date.now() - Date.parse(at) < 120_000 ? 0 : 1;
    }
    case 'version':
      console.log(readConfig(process.env, false).version);
      return 0;
    default:
      console.error('Usage: node dist/cli.js start | check | pubkey | health | version');
      return 2;
  }
}

main().then(
  (code) => {
    if (process.argv[2] !== 'start' && process.argv[2] !== undefined) process.exit(code);
  },
  (e: unknown) => {
    console.error(e instanceof ConfigError ? e.message : (e as Error).stack ?? e);
    process.exit(e instanceof ConfigError ? 78 : 1);
  },
);
