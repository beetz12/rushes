// Launch at login. The OS login-item registration is the source of truth:
// the state shown in Settings is always read back, never a saved flag.
export interface LoginItemApp {
  isPackaged: boolean;
  getLoginItemSettings(): { openAtLogin: boolean; status?: string };
  setLoginItemSettings(settings: { openAtLogin: boolean; openAsHidden?: boolean }): void;
}

import type { LoginItemState } from '../shared/login-item';
export type { LoginItemState };

export function readLoginItem(app: LoginItemApp): LoginItemState {
  if (!app.isPackaged) return { enabled: false, supported: false, requiresApproval: false };
  try {
    const settings = app.getLoginItemSettings();
    return {
      enabled: settings.openAtLogin === true,
      supported: true,
      requiresApproval: settings.status === 'requires-approval',
    };
  } catch {
    return { enabled: false, supported: false, requiresApproval: false };
  }
}

export function setLoginItem(app: LoginItemApp, enabled: boolean): LoginItemState {
  if (typeof enabled !== 'boolean') throw new Error('Launch at login needs on or off.');
  if (!app.isPackaged) throw new Error('Launch at login is only available in the installed app.');
  app.setLoginItemSettings({ openAtLogin: enabled });
  const state = readLoginItem(app);
  if (state.enabled !== enabled && !state.requiresApproval)
    throw new Error(
      enabled
        ? 'macOS did not add Rushes to your login items.'
        : 'macOS did not remove Rushes from your login items.',
    );
  return state;
}
