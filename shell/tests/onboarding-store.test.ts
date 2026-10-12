import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OnboardingStore } from '../src/main/onboarding-store';
const roots: string[] = [];
afterEach(async () => {
  const ownedFixtures = roots.splice(0);
  await Promise.all(
    ownedFixtures.map((fixturePath) => rm(fixturePath, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rushes-onboarding-'));
  roots.push(root);
  return join(root, 'onboarding.json');
}
describe('durable first-use guide choice', () => {
  it.each(['dismiss', 'complete'] as const)(
    'keeps %s across an app restart; replay is explicit',
    async (action) => {
      const path = await fixture();
      const store = new OnboardingStore(path);
      expect(await store.action('get')).toEqual({ version: 1, status: 'unseen' });
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      const saved = await store.action(action);
      expect(saved.status).toBe(action === 'dismiss' ? 'dismissed' : 'completed');
      const restarted = new OnboardingStore(path);
      expect(await restarted.action('get')).toEqual(saved);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await restarted.action('reset')).toEqual({ version: 1, status: 'unseen' });
      expect(await new OnboardingStore(path).action('get')).toEqual({
        version: 1,
        status: 'unseen',
      });
    },
  );
  it('orders writes and read-back without losing the last choice', async () => {
    const path = await fixture();
    const store = new OnboardingStore(path);
    const result = await Promise.all([
      store.action('dismiss'),
      store.action('reset'),
      store.action('complete'),
      store.action('get'),
    ]);
    expect(result.map((x) => x.status)).toEqual(['dismissed', 'unseen', 'completed', 'completed']);
    expect(JSON.parse(await readFile(path, 'utf8')).status).toBe('completed');
  });
  it('rejects invalid actions, corrupt data and symlinks without resetting a saved choice', async () => {
    const path = await fixture();
    const store = new OnboardingStore(path);
    expect(() => store.action('unknown')).toThrow();
    await writeFile(path, '{bad');
    await expect(store.action('get')).rejects.toMatchObject({ code: 'onboarding-store-invalid' });
    await expect(store.action('dismiss')).rejects.toThrow('saved recording guide');
    expect(await readFile(path, 'utf8')).toBe('{bad');
    await rm(path);
    await writeFile(path + '.target', JSON.stringify({ version: 1, status: 'dismissed' }));
    await symlink(path + '.target', path);
    await expect(store.action('reset')).rejects.toMatchObject({ code: 'onboarding-store-invalid' });
    expect(JSON.parse(await readFile(path + '.target', 'utf8')).status).toBe('dismissed');
  });
  it('does not report success when preferences cannot be saved', async () => {
    const path = await fixture();
    await writeFile(path, 'block directory');
    const store = new OnboardingStore(join(path, 'onboarding.json'));
    await expect(store.action('dismiss')).rejects.toThrow();
  });
});
