/**
 * One-off check of the Google Play key from a shell, without starting the console:
 *
 *   PLAY_SERVICE_ACCOUNT_FILE=../../secrets/play-service-account.json node dist/cli/play-check.js
 *
 * Prints what is on every track, or the reason Google refused. Read-only: it opens an edit,
 * reads the tracks and deletes the edit.
 */
import { readConfig } from '../config';
import { PlayClient } from '../play/play.client';

async function main(): Promise<void> {
  const config = readConfig({ ...process.env, CONSOLE_PASSWORD: process.env.CONSOLE_PASSWORD || 'unused', SESSION_SECRET: 'x'.repeat(32) });
  const play = new PlayClient(config);
  const key = play.keyState();
  if (key.kind !== 'ready') {
    console.error(key.reason);
    process.exit(2);
  }
  console.log(`Key: ${key.key.client_email} (project ${key.key.project_id ?? '?'}) from ${key.source}`);
  const snap = await play.snapshot(true);
  console.log(`App: ${snap.packageName} — highest versionCode ${snap.highestVersionCode ?? 'none'}`);
  for (const t of snap.tracks) {
    const releases = t.releases.length
      ? t.releases.map((r) => `${r.name ?? '(unnamed)'} [${r.versionCodes.join(', ') || 'no codes'}] ${r.status}`).join('; ')
      : 'no releases';
    console.log(`  ${t.track.padEnd(12)} ${releases}`);
  }
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
