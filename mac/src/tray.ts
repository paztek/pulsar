import { app, Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import { Core } from './core';
import { SerialStatus } from './serial';
import { showWindow } from './window';
import { log } from './log';

const ICON_FILE: Record<SerialStatus, string> = {
  connected: 'connected.png',
  connecting: 'connecting.png',
  disconnected: 'disconnected.png',
};

const LED_LABEL: Record<string, string> = {
  red: '🔴 red',
  yellow: '🟡 yellow',
  blue: '🔵 blue',
  green: '🟢 green',
};

/**
 * Menu bar presence. The icon is a colored dot reflecting serial connectivity;
 * the menu shows live status and offers Poll now / Quit. Subscribes to Core.
 */
export interface TrayCallbacks {
  onToggleMcp: () => void;
}

export class PulsarTray {
  private tray: Tray;
  private status: SerialStatus = 'disconnected';

  constructor(private core: Core, private cb: TrayCallbacks) {
    this.status = core.getSnapshot().serial;
    this.tray = new Tray(this.icon(this.status));
    this.render();

    core.on('serial-status', (s) => {
      this.status = s;
      log(`tray: serial status → ${s}`);
      this.render();
    });
    // Refresh the menu's status lines (last poll, lit LEDs) after each tick.
    core.on('tick', () => this.render());
  }

  destroy(): void {
    this.tray.destroy();
  }

  private icon(status: SerialStatus): Electron.NativeImage {
    // @2x variants are picked up automatically for retina displays.
    return nativeImage.createFromPath(
      path.join(__dirname, '..', 'assets', 'tray', ICON_FILE[status]),
    );
  }

  private statusLabel(): string {
    const port = this.core.getSnapshot().serialPort;
    switch (this.status) {
      case 'connected':
        return `Connected — ${port}`;
      case 'connecting':
        return 'Connecting…';
      case 'disconnected':
        return 'Arduino not found';
    }
  }

  private render(): void {
    this.tray.setImage(this.icon(this.status));

    const snap = this.core.getSnapshot();
    const lit = Object.entries(snap.leds)
      .filter(([, on]) => on)
      .map(([name]) => LED_LABEL[name] ?? name);
    const lastPoll = snap.lastTickAt
      ? new Date(snap.lastTickAt).toLocaleTimeString()
      : '—';

    this.tray.setToolTip(`Pulsar — ${this.statusLabel()}`);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Pulsar — ${this.statusLabel()}`, enabled: false },
        { label: lit.length ? `LEDs: ${lit.join(', ')}` : 'LEDs: none', enabled: false },
        { label: `Last poll: ${lastPoll}`, enabled: false },
        { type: 'separator' },
        { label: 'Open Pulsar…', click: () => showWindow() },
        { label: 'Poll now', click: () => void this.core.pollNow() },
        {
          label: snap.mcp.enabled ? `MCP server: on — ${snap.mcp.url}` : 'MCP server: off',
          type: 'checkbox',
          checked: snap.mcp.enabled,
          click: () => this.cb.onToggleMcp(),
        },
        { type: 'separator' },
        { label: 'Quit Pulsar', click: () => app.quit() },
      ]),
    );
  }
}
