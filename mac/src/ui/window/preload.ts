import { contextBridge, ipcRenderer } from 'electron';

// Minimal, typed bridge exposed to the renderer. No Node access leaks through;
// the renderer talks only to these channels.
contextBridge.exposeInMainWorld('pulsar', {
  getSnapshot: () => ipcRenderer.invoke('pulsar:getSnapshot'),
  getSettings: () => ipcRenderer.invoke('pulsar:getSettings'),
  updateSettings: (patch: unknown) => ipcRenderer.invoke('pulsar:updateSettings', patch),
  listSerialPorts: () => ipcRenderer.invoke('pulsar:listSerialPorts'),
  pollNow: () => ipcRenderer.invoke('pulsar:pollNow'),
  onSnapshot: (cb: (snapshot: unknown) => void) => {
    const listener = (_e: unknown, snapshot: unknown) => cb(snapshot);
    ipcRenderer.on('pulsar:snapshot', listener);
    return () => ipcRenderer.removeListener('pulsar:snapshot', listener);
  },
});
