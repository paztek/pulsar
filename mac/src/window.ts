import { BrowserWindow } from 'electron';
import * as path from 'path';
import { log } from './log';

// The settings/status window. Created lazily and hidden (not destroyed) on close
// so the menu bar app stays resident and reopening is instant.

let win: BrowserWindow | null = null;

export function showWindow(): void {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }

  win = new BrowserWindow({
    width: 460,
    height: 640,
    title: 'Pulsar',
    resizable: true,
    fullscreenable: false,
    minimizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const wc = win.webContents;
  wc.on('did-finish-load', () => log('window: renderer loaded'));
  wc.on('did-fail-load', (_e, code, desc) => log(`window: renderer FAILED to load (${code} ${desc})`));
  // Forward renderer console to the main log (signature varies across Electron versions).
  (wc as { on: (event: string, cb: (...args: unknown[]) => void) => void }).on(
    'console-message',
    (...args: unknown[]) => {
      const msg = typeof args[2] === 'string' ? args[2] : (args[0] as { message?: string })?.message ?? '';
      if (msg) log(`renderer: ${msg}`);
    },
  );

  // Hide instead of quitting; app.exit() during real shutdown bypasses this.
  win.on('close', (e) => {
    e.preventDefault();
    win?.hide();
  });
}

export function getWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}
