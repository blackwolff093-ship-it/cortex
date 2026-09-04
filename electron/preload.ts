import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("cortex", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
  },
});
