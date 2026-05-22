import notifier from 'node-notifier';
import { exec } from 'child_process';

export function notify(title: string, message: string, url?: string): void {
  notifier.notify(
    { title, message, sound: true, wait: !!url },
    (_err, response) => {
      if (response === 'activate' && url) {
        exec(`open "${url}"`);
      }
    }
  );
}
