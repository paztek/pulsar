import notifier from 'node-notifier';
import { exec } from 'child_process';
import { log } from './log';

export function notify(title: string, message: string, url?: string): void {
  log(`notify: ${title} — ${message}${url ? ` ${url}` : ''}`);
  notifier.notify(
    { title, message, sound: true, wait: !!url },
    (_err, response) => {
      if (response === 'activate' && url) {
        log(`open url: ${url}`);
        exec(`open "${url}"`);
      }
    }
  );
}
