import { contextBridge, ipcRenderer } from 'electron';
import type { EngineEvent, RushesAPI } from '../shared/contracts';
async function invoke(channel: string, value?: unknown) {
  const response = await ipcRenderer.invoke(channel, value);
  if (response?.__rushesError)
    throw Object.assign(new Error(response.__rushesError.message), {
      code: response.__rushesError.code,
    });
  return response;
}
const api: RushesAPI = {
  request: (cmd, args = {}) => invoke('rushes:request', { cmd, args }),
  presets: (action, name, options) => invoke('rushes:presets', { action, name, options }),
  bootstrap: () => invoke('rushes:bootstrap'),
  saveOptions: (options) => invoke('rushes:save-options', options),
  onEvent(listener) {
    const wrapped = (_event: unknown, payload: EngineEvent) => listener(payload);
    ipcRenderer.on('rushes:event', wrapped);
    return () => ipcRenderer.removeListener('rushes:event', wrapped);
  },
  window: (action, value, x, y) => invoke('rushes:window', { action, value, x, y }),
  selectArea: (area) => invoke('rushes:select-area', area),
  exportFile: (id, preset, atMs) => invoke('rushes:export-file', { id, preset, atMs }),
  previewFile: (id) => invoke('rushes:preview-file', id),
  media: (path) => invoke('rushes:media', path),
  reveal: (path) => invoke('rushes:reveal', path),
  confirm: (message) => invoke('rushes:confirm', message),
  cloudSettings: () => invoke('rushes:cloud-settings'),
  saveCloudSettings: (settings) => invoke('rushes:save-cloud', settings),
  testCloud: () => invoke('rushes:test-cloud'),
  share: (id) => invoke('rushes:share', id),
  copyLink: (url) => invoke('rushes:copy-link', url),
};
contextBridge.exposeInMainWorld('rushes', api);
