import { ipcMain } from 'electron';
import { SerialPort } from 'serialport';
import { Core } from '../../core/core';
import { getSettings, updateSettings, PulsarSettings, SettingsPatch } from '../../core/settings';
import { getWindow } from './window';
import { log } from '../../core/log';

/** Settings view sent to the renderer — the token is never exposed, only whether one is set. */
function redact(s: PulsarSettings) {
  const { githubTokenEnc, ...rest } = s;
  return { ...rest, hasToken: Boolean(githubTokenEnc) };
}

export function registerIpc(core: Core): void {
  ipcMain.handle('pulsar:getSnapshot', () => core.getSnapshot());
  ipcMain.handle('pulsar:getSettings', () => redact(getSettings()));
  ipcMain.handle('pulsar:pollNow', () => core.pollNow());

  ipcMain.handle('pulsar:listSerialPorts', async () => {
    const ports = await SerialPort.list();
    return ports.map((p) => p.path);
  });

  ipcMain.handle('pulsar:updateSettings', async (_e, patch: SettingsPatch) => {
    const prevPort = getSettings().serialPort;
    const next = updateSettings(patch);
    log('ipc: settings updated from GUI');
    await core.applySettings({ reconnectSerial: next.serialPort !== prevPort });
    return redact(next);
  });

  // Push live snapshots to the window whenever Core state changes.
  const push = () => {
    const w = getWindow();
    if (w) w.webContents.send('pulsar:snapshot', core.getSnapshot());
  };
  core.on('serial-status', push);
  core.on('tick', push);
}
