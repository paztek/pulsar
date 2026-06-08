import { app } from 'electron';
import { createCore, startCore } from './index';
import { PulsarTray } from './tray';
import { Core } from './core';
import { log } from './log';

// Phase 2: menu bar agent with a tray icon reflecting serial connectivity.
// Settings window and MCP server arrive in later phases.

let tray: PulsarTray | null = null;
let core: Core | null = null;
let quitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log('another Pulsar instance is already running — quitting');
  app.quit();
} else {
  app.whenReady().then(async () => {
    // Menu bar agent: no Dock icon. (Packaging also sets LSUIElement in Phase 7.)
    if (app.dock) app.dock.hide();
    log(`Electron ${process.versions.electron} ready — starting Pulsar`);
    try {
      core = createCore();
      // Attach the tray BEFORE starting so it catches the initial serial-status events.
      tray = new PulsarTray(core);
      await startCore(core);
    } catch (e) {
      log(`startup failed: ${(e as Error).message}`);
      app.quit();
    }
  });

  // Turn the LEDs off and close the serial port before exiting.
  app.on('before-quit', (e) => {
    if (quitting || !core) return;
    e.preventDefault();
    quitting = true;
    log('quitting — turning LEDs off and closing serial');
    core.stop().finally(() => app.exit(0));
  });

  // Stay resident with no windows open — this is a background menu bar app.
  app.on('window-all-closed', () => {
    /* intentionally do not quit */
  });
}
