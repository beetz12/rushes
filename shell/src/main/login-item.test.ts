import { describe, expect, it } from 'vitest';
import { readLoginItem, setLoginItem, type LoginItemApp } from './login-item';

function fakeApp(options: { packaged?: boolean; status?: string; ignoreWrites?: boolean } = {}) {
  let openAtLogin = false;
  const writes: boolean[] = [];
  const app: LoginItemApp = {
    isPackaged: options.packaged ?? true,
    getLoginItemSettings: () => ({ openAtLogin, status: options.status }),
    setLoginItemSettings: (settings) => {
      writes.push(settings.openAtLogin);
      if (!options.ignoreWrites) openAtLogin = settings.openAtLogin;
    },
  };
  return { app, writes, setExternally: (value: boolean) => (openAtLogin = value) };
}

describe('launch at login', () => {
  it('is off by default and reads nothing it did not ask the OS for', () => {
    const { app, writes } = fakeApp();
    expect(readLoginItem(app)).toEqual({
      enabled: false,
      supported: true,
      requiresApproval: false,
    });
    expect(writes).toEqual([]);
  });
  it('turns on and off through the OS and reports the state read back', () => {
    const { app, writes } = fakeApp();
    expect(setLoginItem(app, true).enabled).toBe(true);
    expect(setLoginItem(app, false).enabled).toBe(false);
    expect(writes).toEqual([true, false]);
  });
  it('follows changes made outside Rushes, e.g. in System Settings', () => {
    const { app, setExternally } = fakeApp();
    setLoginItem(app, true);
    setExternally(false);
    expect(readLoginItem(app).enabled).toBe(false);
  });
  it('fails loudly when the OS does not apply the change', () => {
    const { app } = fakeApp({ ignoreWrites: true });
    expect(() => setLoginItem(app, true)).toThrow(/did not add/);
  });
  it('reports pending approval instead of failing', () => {
    const { app } = fakeApp({ ignoreWrites: true, status: 'requires-approval' });
    expect(setLoginItem(app, true)).toEqual({
      enabled: false,
      supported: true,
      requiresApproval: true,
    });
  });
  it('never registers a development build', () => {
    const { app, writes } = fakeApp({ packaged: false });
    expect(readLoginItem(app).supported).toBe(false);
    expect(() => setLoginItem(app, true)).toThrow(/installed app/);
    expect(writes).toEqual([]);
  });
  it('rejects non-boolean input', () => {
    const { app, writes } = fakeApp();
    expect(() => setLoginItem(app, 'yes' as unknown as boolean)).toThrow();
    expect(writes).toEqual([]);
  });
});
