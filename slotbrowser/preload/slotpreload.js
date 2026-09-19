// Slot preload: exposes a tiny host bridge to the page (main world).
const { contextBridge, ipcRenderer } = require("electron");

let slotId = "1";

contextBridge.exposeInMainWorld("__vtHost", {
  getSlotId: () => slotId,
  getCreds: () => ipcRenderer.invoke("vt-get-creds", slotId).catch(() => null),
  getSettings: () => ipcRenderer.invoke("vt-slot-settings").catch(() => ({ adBlock: false })),
  signal: (msg) => ipcRenderer.send("vt-slot-msg", slotId, msg || {}),
  setSlotId: (id) => { slotId = id || "1"; }
});
