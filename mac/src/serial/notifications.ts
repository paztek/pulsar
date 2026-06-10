import { exec } from 'child_process';
import { log } from '../core/log';

// Under Electron we use the native Notification API (no bundled binary, so it
// survives asar packaging). The standalone path (npm run dev, pure Node) falls
// back to node-notifier. Click opens the URL.

function isElectron(): boolean {
  return Boolean(process.versions.electron);
}

function notifyElectron(title: string, message: string, url?: string): void {
  // Lazy require: 'electron' isn't a usable module outside an Electron process.
  const { Notification, shell } = require('electron') as typeof import('electron');
  if (!Notification.isSupported()) {
    log('notify: native notifications not supported');
    return;
  }
  const n = new Notification({ title, body: message });
  if (url) n.on('click', () => void shell.openExternal(url));
  n.show();
}

function notifyStandalone(title: string, message: string, url?: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const notifier = require('node-notifier');
  notifier.notify(
    { title, message, sound: true, wait: Boolean(url) },
    (_err: unknown, response: string) => {
      if (response === 'activate' && url) exec(`open "${url}"`);
    },
  );
}

export function notify(title: string, message: string, url?: string): void {
  log(`notify: ${title} — ${message}${url ? ` ${url}` : ''}`);
  try {
    if (isElectron()) notifyElectron(title, message, url);
    else notifyStandalone(title, message, url);
  } catch (e) {
    log(`notify: failed — ${(e as Error).message}`);
  }
}
