const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('promptlyDesktop', {
  setMode: (mode) => ipcRenderer.invoke('widget:set-mode', mode),
  moveBy: (deltaX, deltaY) => ipcRenderer.invoke('widget:move-by', { deltaX, deltaY }),
  resize: (width, height) => ipcRenderer.invoke('widget:resize', { width, height }),
  hide: () => ipcRenderer.invoke('widget:hide'),
  unhide: () => ipcRenderer.invoke('widget:unhide'),
  minimize: () => ipcRenderer.invoke('widget:minimize'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('widget:toggle-always-on-top'),
  notify: (title, body) => ipcRenderer.invoke('widget:notify', { title, body }),
  onModeChange: (callback) => {
    const listener = (_event, mode) => callback(mode);
    ipcRenderer.on('widget:mode', listener);
    return () => ipcRenderer.removeListener('widget:mode', listener);
  },
  onShow: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('widget:show', listener);
    return () => ipcRenderer.removeListener('widget:show', listener);
  },
});
