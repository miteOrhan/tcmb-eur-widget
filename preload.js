"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("widget", {
  getRates: () => ipcRenderer.invoke("rates:get"),
  refresh: () => ipcRenderer.invoke("rates:refresh"),
  hide: () => ipcRenderer.invoke("widget:hide"),
  onRates: (callback) => {
    ipcRenderer.on("rates:update", (_event, data) => callback(data));
  },
  rendered: () => ipcRenderer.send("widget:rendered"),
  debug: (message) => ipcRenderer.send("widget:debug", message),
});
