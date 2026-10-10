/**
 * Maintenance commands, run inside the builder container:
 *
 *   docker compose exec builder node /opt/runner/dist/cli.js adopt-runs <app-id>
 *
 * adopt-runs: runs recorded before the console had apps (uploaded ZIPs of one app) join the
 * given app, keeping their numbers, so its history and AABs stay in the console.
 */
import { readConfig } from './config';
import { boot } from './main';

async function main(): Promise<void> {
  const [command, appId] = process.argv.slice(2);
  if (command !== 'adopt-runs' || !appId) {
    console.error('usage: cli.js adopt-runs <app-id>');
    process.exit(2);
  }
  const deps = await boot(readConfig());
  const app = await deps.apps.require(appId);
  const orphans = (await deps.store.list()).filter((r) => !r.app);
  for (const run of orphans) {
    run.app = deps.apps.snapshot(app);
    // Builds of that era were signed by the project itself (its committed key.properties).
    run.app.signing = 'repository';
    await deps.store.save(run);
  }
  // New runs number on from the highest number the app's runs carry (see startRun).
  const highest = Math.max(0, ...(await deps.store.list()).filter((r) => r.app?.id === app.id).map((r) => r.number));
  console.log(`${orphans.length} run(s) now belong to ${app.name}; its next run is #${highest + 1}.`);
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
