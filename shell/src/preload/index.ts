import {contextBridge,ipcRenderer} from 'electron';
import type {EngineEvent,RushesAPI} from '../shared/contracts';
const api:RushesAPI={
 request:(cmd,args={})=>ipcRenderer.invoke('rushes:request',{cmd,args}),
 bootstrap:()=>ipcRenderer.invoke('rushes:bootstrap'),saveOptions:options=>ipcRenderer.invoke('rushes:save-options',options),
 onEvent(listener){const wrapped=(_event:unknown,payload:EngineEvent)=>listener(payload);ipcRenderer.on('rushes:event',wrapped);return()=>ipcRenderer.removeListener('rushes:event',wrapped);},
 window:(action,value,x,y)=>ipcRenderer.invoke('rushes:window',{action,value,x,y}),
 selectArea:area=>ipcRenderer.invoke('rushes:select-area',area),
 exportFile:(id,preset)=>ipcRenderer.invoke('rushes:export-file',{id,preset}),media:path=>ipcRenderer.invoke('rushes:media',path),reveal:path=>ipcRenderer.invoke('rushes:reveal',path),confirm:message=>ipcRenderer.invoke('rushes:confirm',message),
 cloudSettings:()=>ipcRenderer.invoke('rushes:cloud-settings'),saveCloudSettings:settings=>ipcRenderer.invoke('rushes:save-cloud',settings),testCloud:()=>ipcRenderer.invoke('rushes:test-cloud'),share:id=>ipcRenderer.invoke('rushes:share',id),copyLink:url=>ipcRenderer.invoke('rushes:copy-link',url)
};contextBridge.exposeInMainWorld('rushes',api);
