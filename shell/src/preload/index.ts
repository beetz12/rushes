import { contextBridge, ipcRenderer } from 'electron';
import type { EngineEvent, RushesAPI } from '../shared/contracts';
async function invoke(channel: string, value?: unknown) {
  // Keep coded failures as data until the renderer has crossed contextBridge.
  return ipcRenderer.invoke(channel, value);
}
const api: RushesAPI = {
  openRecording: (id) => invoke('rushes:open-recording', id),
  restorePrimaryView: (view) => invoke('rushes:restore-primary-view', view),
  draftFlushed: (token, error) => invoke('rushes:draft-flushed', { token, error }),
  onboarding: (action) => invoke('rushes:onboarding', action),
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
  openEditor: (id) => invoke('rushes:open-editor', id),
  previewFile: (id) => invoke('rushes:preview-file', id),
  copyVideoFile: (id) => invoke('rushes:copy-video-file', id),
  media: (path) => invoke('rushes:media', path),
  reveal: (path) => invoke('rushes:reveal', path),
  confirm: (message) => invoke('rushes:confirm', message),
  cloudSettings: () => invoke('rushes:cloud-settings'),
  saveCloudSettings: (settings) => invoke('rushes:save-cloud', settings),
  testCloud: () => invoke('rushes:test-cloud'),
  share: (id, policy) => invoke('rushes:share-command', { cmd: 'share', args: { id, ...policy } }),
  shareStatus: (id) => invoke('rushes:share-command', { cmd: 'share.status', args: { id } }),
  getSharePolicy: (id) => invoke('rushes:share-command', { cmd: 'share.policy.get', args: { id } }),
  setSharePolicy: (id, policy) =>
    invoke('rushes:share-command', { cmd: 'share.policy.set', args: { id, ...policy } }),
  shareFeedback: (id) => invoke('rushes:share-command', { cmd: 'share.feedback', args: { id } }),
  copyLink: (url) => invoke('rushes:copy-link', url),
  copyText: (text) => invoke('rushes:copy-text', text),
  drawing: (action, options = {}) => invoke('rushes:drawing', { action, ...options }),
};
contextBridge.exposeInMainWorld('rushes', api);
