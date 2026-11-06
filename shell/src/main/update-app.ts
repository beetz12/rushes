// Electron wiring for the update notice: real fetch, desktop notifications and the browser.
import { app, Notification, shell } from 'electron';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { updateActionSchema } from '../shared/updates';
import { UpdateChecker, detectChannel } from './update-check';

export function createAppUpdates(statePath: string, busy: () => boolean, quitting: () => boolean) {
  const version = app.getVersion();
  // Electron collects a notification that nothing references, which drops its click handler.
  let notice: Notification | undefined;
  const checker = new UpdateChecker({
    version,
    statePath,
    channel: () =>
      detectChannel(version, {
        packaged: app.isPackaged,
        // .../Rushes.app/Contents/MacOS/Rushes -> .../Rushes.app
        appPath: resolve(process.execPath, '..', '..', '..'),
        // A hung codesign must not leave every later update check waiting forever.
        exec: (file: string, args: string[]) => promisify(execFile)(file, args, { timeout: 5000, maxBuffer: 1 << 20 }),
      }),
    fetch: (url, init) => fetch(url, init),
    busy,
    notify: (title, body, onClick) => {
      if (quitting() || !Notification.isSupported()) return false;
      notice = new Notification({ title, body });
      notice.on('click', onClick);
      notice.show();
      return true;
    },
    openExternal: (url) => shell.openExternal(url),
  });
  const action = async (value: unknown) => {
    const request = updateActionSchema.parse(value);
    if (request.action === 'check') await checker.checkNow();
    if (request.action === 'set-automatic') await checker.setAutomatic(request.enabled);
    if (request.action === 'open-release') await checker.openRelease();
    return checker.status();
  };
  return { checker, action };
}
