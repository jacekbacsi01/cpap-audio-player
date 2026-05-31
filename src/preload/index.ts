import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  selectMusicFiles: () => ipcRenderer.invoke('select-music-files'),
  selectMusicFolder: (recursive: boolean) => ipcRenderer.invoke('select-music-folder', recursive),
  minimizeWindow: () => ipcRenderer.send('window-minimize'), // <-- ÚJ
  closeWindow: () => ipcRenderer.send('window-close')       // <-- ÚJ
})