import { app } from 'electron';
import { startDaemon } from './index';
import { log } from './log';

// Phase 0 scaffold: boot the existing daemon inside Electron's main process as a
// menu bar agent. Tray, settings window, and MCP server arrive in later phases.

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log('another Pulsar instance is already running — quitting');
  app.quit();
} else {
  app.whenReady().then(() => {
    // Menu bar agent: no Dock icon. (Packaging also sets LSUIElement in Phase 7.)
    if (app.dock) app.dock.hide();
    log(`Electron ${process.versions.electron} ready — starting Pulsar daemon`);
    startDaemon().catch((e: unknown) => log(`daemon failed: ${(e as Error).message}`));
  });

  // Stay resident with no windows open — this is a background menu bar app.
  app.on('window-all-closed', () => {
    /* intentionally do not quit */
  });
}
