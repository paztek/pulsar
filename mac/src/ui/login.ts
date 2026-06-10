import { app } from 'electron';
import { updateSettings } from '../core/settings';
import { log } from '../core/log';

// Launch-at-login, backed by the OS login item. The persisted setting is the
// source of truth; we reconcile the OS item to it on boot.

export function isLaunchAtLogin(): boolean {
  return app.getLoginItemSettings().openAtLogin;
}

export function setLaunchAtLogin(on: boolean): void {
  app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
  updateSettings({ launchAtLogin: on });
  log(`login: launch at login → ${on}`);
}

/** On boot, make the OS login item match the persisted setting. */
export function reconcileLaunchAtLogin(persisted: boolean): void {
  if (isLaunchAtLogin() !== persisted) {
    app.setLoginItemSettings({ openAtLogin: persisted, openAsHidden: true });
    log(`login: reconciled OS login item → ${persisted}`);
  }
}
