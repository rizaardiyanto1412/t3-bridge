import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("bridgeDesktop", {
  local: (): Promise<{ baseUrl: string; token: string } | null> =>
    ipcRenderer.invoke("bridge:local"),
  remote: {
    get: (): Promise<{ baseUrl: string; label: string } | null> =>
      ipcRenderer.invoke("bridge:remote:get"),
    connect: (target: { baseUrl: string; token: string }) =>
      ipcRenderer.invoke("bridge:remote:connect", target),
    select: (selected: boolean) => ipcRenderer.invoke("bridge:remote:select", selected),
    forget: () => ipcRenderer.invoke("bridge:remote:forget"),
    rememberToken: (token: string) => ipcRenderer.invoke("bridge:remote:token", token),
  },
});
