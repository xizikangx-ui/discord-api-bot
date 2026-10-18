'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('bookUpdates',{status:()=>ipcRenderer.invoke('book:update-status'),check:()=>ipcRenderer.invoke('book:update-check'),install:()=>ipcRenderer.invoke('book:update-install'),onChange:callback=>{const listener=(event,state)=>callback(state);ipcRenderer.on('book:update-state',listener);return()=>ipcRenderer.removeListener('book:update-state',listener);}});
