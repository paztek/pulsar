import { Core } from './core';
import { config } from './config';
import { log } from './log';

/** Validate env and construct a Core (does not connect or start polling yet). */
export function createCore(): Core {
  if (!config.github.username) {
    console.error('Missing GITHUB_USERNAME in .env');
    process.exit(1);
  }
  if (config.github.poller === 'api' && !config.github.token) {
    console.error('GITHUB_POLLER=api requires GITHUB_TOKEN in .env');
    process.exit(1);
  }
  return new Core();
}

/** Connect, run the first tick, start the loop, and wire process shutdown. */
export async function startCore(core: Core): Promise<void> {
  await core.start();
  log(`Pulsar started — driving Arduino on ${config.serial.port} (connecting/retrying in background)`);

  process.on('SIGINT', async () => {
    log('SIGINT — shutting down');
    await core.stop();
    process.exit(0);
  });
}

/**
 * Standalone entry: construct and start in one call. Electron instead calls
 * createCore() + startCore() so it can attach the tray between the two (the tray
 * must subscribe before the first connect to catch the initial status events).
 */
export async function startDaemon(): Promise<Core> {
  const core = createCore();
  await startCore(core);
  return core;
}

// Run directly only when launched as a standalone Node process (`npm run dev`/
// `npm start`). Under Electron, `electron-main.ts` drives the Core.
if (require.main === module) {
  startDaemon().catch(console.error);
}
