import { contextBridge, ipcRenderer } from 'electron';

const api = {
  state: () => ipcRenderer.invoke('screenspot:state'),
  config: (value: unknown) => ipcRenderer.invoke('screenspot:config', value),
  start: () => ipcRenderer.invoke('screenspot:start'),
  stop: () => ipcRenderer.invoke('screenspot:stop'),
  submit: (value: unknown) => ipcRenderer.invoke('screenspot:submit', value),
  clear: () => ipcRenderer.invoke('screenspot:clear'),
  calibrate: () => ipcRenderer.invoke('screenspot:calibrate'),
  nudge: (dx: number, dy: number) => ipcRenderer.invoke('screenspot:nudge', dx, dy),
  resetAlignment: () => ipcRenderer.invoke('screenspot:reset-alignment'),
  forgetKey: () => ipcRenderer.invoke('screenspot:forget-key'),
  quit: () => ipcRenderer.invoke('screenspot:quit'),
  onEvent: (callback: (value: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: any) => callback(value);
    ipcRenderer.on('screenspot:event', listener);
    return () => ipcRenderer.removeListener('screenspot:event', listener);
  },
  onOverlay: (callback: (value: any) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: any) => callback(value);
    ipcRenderer.on('screenspot:overlay', listener);
    return () => ipcRenderer.removeListener('screenspot:overlay', listener);
  },
};

contextBridge.exposeInMainWorld('screenspot', api);
