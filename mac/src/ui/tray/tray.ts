import { app, Tray, Menu, nativeImage, nativeTheme } from 'electron';
import * as path from 'path';
import { Core } from '../../core/core';
import { SerialStatus } from '../../serial/serial';
import { showWindow } from '../window/window';
import { log } from '../../core/log';

const LED_LABEL: Record<string, string> = {
  red: '🔴 red',
  yellow: '🟡 yellow',
  blue: '🔵 blue',
  green: '🟢 green',
};

function trayRemaining(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'expiring';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

/**
 * Menu bar presence. The icon is the Pulsar glyph with a colored status badge
 * (green/amber/red) reflecting serial connectivity; the menu shows live status
 * and controls. Subscribes to Core (status) and nativeTheme (light/dark glyph).
 */
export interface TrayCallbacks {
  onToggleMcp: () => void;
  onToggleLaunchAtLogin: () => void;
  isLaunchAtLogin: () => boolean;
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
    // Swap the dark/light glyph when the menu bar appearance changes.
    nativeTheme.on('updated', () => this.render());
  }

  destroy(): void {
    this.tray.destroy();
  }

  /** Re-render the menu (for state not carried by Core events, e.g. launch-at-login). */
  refresh(): void {
    this.render();
  }

  private icon(status: SerialStatus): Electron.NativeImage {
    // Non-template (the status badge is colored), so pick the glyph variant for
    // the current menu bar appearance. @2x is auto-loaded for retina.
    const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    return nativeImage.createFromPath(
      path.join(__dirname, '..', '..', '..', 'assets', 'menubar', `${status}-${theme}.png`),
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

    const signalItems: Electron.MenuItemConstructorOptions[] = snap.signals.length
      ? [
          { type: 'separator' },
          { label: `Signals (${snap.signals.length})`, enabled: false },
          ...snap.signals.slice(0, 6).map((s) => ({
            label: `  ${s.source}: ${s.group}${s.expiresAt ? ` · ${trayRemaining(s.expiresAt)}` : ''}`,
            enabled: false,
          })),
        ]
      : [];

    this.tray.setToolTip(`Pulsar — ${this.statusLabel()}`);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Pulsar — ${this.statusLabel()}`, enabled: false },
        { label: lit.length ? `LEDs: ${lit.join(', ')}` : 'LEDs: none', enabled: false },
        { label: `Last poll: ${lastPoll}`, enabled: false },
        ...signalItems,
        { type: 'separator' },
        { label: 'Open Pulsar…', click: () => showWindow() },
        { label: 'Poll now', click: () => void this.core.pollNow() },
        {
          label: snap.mcp.enabled ? `MCP server: on — ${snap.mcp.url}` : 'MCP server: off',
          type: 'checkbox',
          checked: snap.mcp.enabled,
          click: () => this.cb.onToggleMcp(),
        },
        {
          label: 'Launch at login',
          type: 'checkbox',
          checked: this.cb.isLaunchAtLogin(),
          click: () => this.cb.onToggleLaunchAtLogin(),
        },
        { type: 'separator' },
        { label: 'Quit Pulsar', click: () => app.quit() },
      ]),
    );
  }
}
