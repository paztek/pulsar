import { app, Tray, Menu, MenuItem, nativeImage, nativeTheme } from 'electron';
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

const MAX_SIGNAL_ROWS = 6;

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
 *
 * The context menu is built **once** and its items are mutated in place on each
 * event. Replacing the whole menu (setContextMenu) on every tick would tear down
 * an open menu mid-click on macOS — eating the user's first click right after a
 * fresh start, when serial + the first poll churn fastest.
 */
export interface TrayCallbacks {
  onToggleLaunchAtLogin: () => void;
  isLaunchAtLogin: () => boolean;
}

export class PulsarTray {
  private tray: Tray;
  private menu: Menu;
  private status: SerialStatus = 'disconnected';

  constructor(private core: Core, private cb: TrayCallbacks) {
    this.status = core.getSnapshot().serial;
    this.tray = new Tray(this.icon(this.status));
    this.menu = this.buildMenu();
    this.tray.setContextMenu(this.menu);
    this.update();

    core.on('serial-status', (s) => {
      this.status = s;
      log(`tray: serial status → ${s}`);
      this.tray.setImage(this.icon(this.status));
      this.update();
    });
    // Refresh the menu's live lines (last poll, lit LEDs, MCP) after each tick.
    core.on('tick', () => this.update());
    // Swap the dark/light glyph when the menu bar appearance changes.
    nativeTheme.on('updated', () => this.tray.setImage(this.icon(this.status)));
  }

  destroy(): void {
    this.tray.destroy();
  }

  /** Re-sync the menu (for state not carried by Core events, e.g. launch-at-login). */
  refresh(): void {
    this.update();
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

  /** Build the menu once with stable item ids; `update()` mutates these in place. */
  private buildMenu(): Menu {
    const signalRows = Array.from({ length: MAX_SIGNAL_ROWS }, (_, i) => ({
      id: `signal-${i}`,
      label: '',
      enabled: false,
      visible: false,
    }));

    return Menu.buildFromTemplate([
      { id: 'status', label: 'Pulsar', enabled: false },
      { id: 'leds', label: 'LEDs: none', enabled: false },
      { id: 'lastPoll', label: 'Last poll: —', enabled: false },
      { id: 'signalSep', type: 'separator', visible: false },
      { id: 'signalHeader', label: 'Signals', enabled: false, visible: false },
      ...signalRows,
      { type: 'separator' },
      { label: 'Open Pulsar…', click: () => showWindow() },
      { label: 'Poll now', click: () => void this.core.pollNow() },
      { id: 'mcp', label: 'MCP server: starting…', enabled: false },
      {
        id: 'launch',
        label: 'Launch at login',
        type: 'checkbox',
        checked: false,
        click: () => this.cb.onToggleLaunchAtLogin(),
      },
      { type: 'separator' },
      { label: 'Quit Pulsar', click: () => app.quit() },
    ]);
  }

  private item(id: string): MenuItem | null {
    return this.menu.getMenuItemById(id);
  }

  /** Sync the (already-attached) menu items + tooltip to the current snapshot. */
  private update(): void {
    const snap = this.core.getSnapshot();

    const statusText = `Pulsar — ${this.statusLabel()}`;
    const status = this.item('status');
    if (status) status.label = statusText;

    const lit = Object.entries(snap.leds)
      .filter(([, on]) => on)
      .map(([name]) => LED_LABEL[name] ?? name);
    const leds = this.item('leds');
    if (leds) leds.label = lit.length ? `LEDs: ${lit.join(', ')}` : 'LEDs: none';

    const lastPoll = this.item('lastPoll');
    if (lastPoll) {
      lastPoll.label = `Last poll: ${snap.lastTickAt ? new Date(snap.lastTickAt).toLocaleTimeString() : '—'}`;
    }

    const shown = Math.min(snap.signals.length, MAX_SIGNAL_ROWS);
    const signalSep = this.item('signalSep');
    if (signalSep) signalSep.visible = snap.signals.length > 0;
    const signalHeader = this.item('signalHeader');
    if (signalHeader) {
      signalHeader.visible = snap.signals.length > 0;
      signalHeader.label = `Signals (${snap.signals.length})`;
    }
    for (let i = 0; i < MAX_SIGNAL_ROWS; i++) {
      const row = this.item(`signal-${i}`);
      if (!row) continue;
      row.visible = i < shown;
      if (i < shown) {
        const s = snap.signals[i];
        row.label = `  ${s.source}: ${s.group}${s.expiresAt ? ` · ${trayRemaining(s.expiresAt)}` : ''}`;
      }
    }

    const mcp = this.item('mcp');
    if (mcp) mcp.label = snap.mcp.url ? `MCP server: ${snap.mcp.url}` : 'MCP server: starting…';

    const launch = this.item('launch');
    if (launch) launch.checked = this.cb.isLaunchAtLogin();

    this.tray.setToolTip(statusText);
  }
}
