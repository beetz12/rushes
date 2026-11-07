import { contextBridge, ipcRenderer, webUtils } from 'electron';
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
  updates: (request) => invoke('rushes:updates', request),
  request: (cmd, args = {}) => invoke('rushes:request', { cmd, args }),
  chooseVideos: () => invoke('rushes:choose-videos'),
  // Only real dropped File objects carry a path; the renderer never sends one.
  allowDroppedVideos: (files) =>
    invoke(
      'rushes:allow-dropped-videos',
      [...files].map((file) => webUtils.getPathForFile(file)),
    ),
  importVideo: (path) => invoke('rushes:import-video', path),
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
  exportFile: (id, preset, atMs, title) =>
    invoke('rushes:export-file', { id, preset, atMs, title }),
  openEditor: (id) => invoke('rushes:open-editor', id),
  previewFile: (id) => invoke('rushes:preview-file', id),
  copyVideoFile: (id) => invoke('rushes:copy-video-file', id),
  media: (path) => invoke('rushes:media', path),
  libraryThumbnail: (folder) => invoke('rushes:library-thumbnail', folder),
  loginItem: (enabled) => invoke('rushes:login-item', enabled),
  reveal: (path) => invoke('rushes:reveal', path),
  confirm: (message) => invoke('rushes:confirm', message),
  dragApp: () => ipcRenderer.send('rushes:drag-app'),
  appIcon: () => invoke('rushes:app-icon'),
  cloudSettings: () => invoke('rushes:cloud-settings'),
  saveCloudSettings: (settings) => invoke('rushes:save-cloud', settings),
  testCloud: () => invoke('rushes:test-cloud'),
  shareSetupAccounts: (token) => invoke('rushes:share-setup-accounts', token),
  shareSetupRun: (input) => invoke('rushes:share-setup-run', input),
  shareSetupOpen: (page) => invoke('rushes:share-setup-open', page),
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
