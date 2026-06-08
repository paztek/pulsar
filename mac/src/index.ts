import { Core } from './core';
import { config } from './config';
import { log } from './log';

/**
 * Boot a Core and wire process-level shutdown. Returns the Core so callers
 * (Electron main, later the tray) can subscribe and drive it.
 */
export async function startDaemon(): Promise<Core> {
  if (!config.github.username) {
    console.error('Missing GITHUB_USERNAME in .env');
    process.exit(1);
  }
  if (config.github.poller === 'api' && !config.github.token) {
    console.error('GITHUB_POLLER=api requires GITHUB_TOKEN in .env');
    process.exit(1);
  }

  const core = new Core();
  await core.start();
  log(`Pulsar started — driving Arduino on ${config.serial.port} (connecting/retrying in background)`);

  process.on('SIGINT', async () => {
    log('SIGINT — shutting down');
    await core.stop();
    process.exit(0);
  });

  return core;
}

// Run directly only when launched as a standalone Node process (`npm run dev`/
// `npm start`). Under Electron, `electron-main.ts` imports and drives startDaemon().
if (require.main === module) {
  startDaemon().catch(console.error);
}
