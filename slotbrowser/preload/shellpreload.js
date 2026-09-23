// Shell window preload: toolbar <-> main IPC bridge.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("visiontap", {
  getState: () => ipcRenderer.invoke("vt-state-get"),
  onState: (cb) => ipcRenderer.on("vt-state", (_e, state) => cb(state)),
  addSlot: () => ipcRenderer.invoke("vt-slot-add"),
  addSlotEcnl: () => ipcRenderer.invoke("vt-slot-add-ecnl"),
  addSlotPmath: () => ipcRenderer.invoke("vt-slot-add-pmath"),
  removeSlot: (id) => ipcRenderer.invoke("vt-slot-remove", id),
  toggleLoop: (id) => ipcRenderer.invoke("vt-slot-toggle", id),
  reloadSlot: (id) => ipcRenderer.invoke("vt-slot-reload", id),
  focusSlot: (id) => ipcRenderer.invoke("vt-slot-focus", id),
  bootSlot: (id) => ipcRenderer.invoke("vt-slot-boot", id),
  pauseAll: (paused) => ipcRenderer.invoke("vt-pause-all", paused),
  getSettings: () => ipcRenderer.invoke("vt-settings-get"),
  setSettings: (patch) => ipcRenderer.invoke("vt-settings-set", patch),
  setSlotCreds: (id, user, pass) => ipcRenderer.invoke("vt-slot-set-creds", id, user, pass),
  setSlotFlags: (id, flags) => ipcRenderer.invoke("vt-slot-set-flags", id, flags),
  logoutSlot: (id) => ipcRenderer.invoke("vt-slot-logout", id),
  minimize: () => ipcRenderer.invoke("vt-win-minimize"),
  close: () => ipcRenderer.invoke("vt-win-close"),
  openSettings: () => ipcRenderer.invoke("vt-settings-open"),
  closeSettingsWin: () => ipcRenderer.invoke("vt-settings-close"),
  createDesktopShortcut: () => ipcRenderer.invoke("vt-desktop-shortcut"),
  restartAll: () => ipcRenderer.invoke("vt-server-restart"),
  stopAll: () => ipcRenderer.invoke("vt-server-stop"),
  startAll: () => ipcRenderer.invoke("vt-server-start"),
  onServerAction: (cb) => ipcRenderer.on("vt-server-action", (_e, action) => cb(action)),
  setTaskMode: (mode) => ipcRenderer.invoke("vt-set-task-mode", mode),
  getTaskMode: () => ipcRenderer.invoke("vt-get-task-mode")
});