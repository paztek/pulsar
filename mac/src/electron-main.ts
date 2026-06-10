import { app } from 'electron';
import { createCore, startCore } from './index';
import { loadAndApplySettings } from './settings';
import { registerIpc } from './ipc';
import { showWindow } from './window';
import { isLaunchAtLogin, setLaunchAtLogin, reconcileLaunchAtLogin } from './login';
import { PulsarTray } from './tray';
import { McpManager } from './mcp/server';
import { TestPushSource } from './test-push';
import { Core } from './core';
import { log } from './log';

// Menu bar agent: tray icon, settings/status window, and a toggleable MCP server.

let tray: PulsarTray | null = null;
let core: Core | null = null;
let mcp: McpManager | null = null;
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
      // Load settings (migrating from .env/config.json on first run) into the
      // runtime config before constructing the Core.
      const settings = loadAndApplySettings();
      // Make the OS login item match the persisted setting.
      reconcileLaunchAtLogin(settings.launchAtLogin);
      core = createCore();
      mcp = new McpManager(core);
      // Attach the tray and IPC BEFORE starting so they catch the initial events.
      tray = new PulsarTray(core, {
        onToggleMcp: () => void mcp!.setEnabled(!mcp!.isRunning()),
        onToggleLaunchAtLogin: () => {
          setLaunchAtLogin(!isLaunchAtLogin());
          tray?.refresh();
        },
        isLaunchAtLogin,
      });
      registerIpc(core);
      await startCore(core);

      // Honor persisted state (or the dev flag) without re-persisting; only the
      // tray toggle calls setEnabled() to write the flag.
      if (settings.mcpEnabled || process.env.PULSAR_MCP === '1') {
        await mcp.start();
      }
      // Dev: exercise the push/onChange path without a real push source.
      if (process.env.PULSAR_TEST_PUSH === '1') core.addPushSource(new TestPushSource());
      // Dev affordance: auto-open the window (no need to click the tray).
      if (process.env.PULSAR_OPEN === '1') showWindow();
    } catch (e) {
      log(`startup failed: ${(e as Error).message}`);
      app.quit();
    }
  });

  // Turn the LEDs off, stop the MCP server, and close serial before exiting.
  app.on('before-quit', (e) => {
    if (quitting || !core) return;
    e.preventDefault();
    quitting = true;
    log('quitting — turning LEDs off, stopping MCP, closing serial');
    Promise.resolve(mcp?.stop())
      .then(() => core!.stop())
      .finally(() => {
        tray?.destroy();
        app.exit(0);
      });
  });

  // Stay resident with no windows open — this is a background menu bar app.
  app.on('window-all-closed', () => {
    /* intentionally do not quit */
  });
}
