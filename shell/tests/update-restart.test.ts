import {describe, expect, it, vi} from 'vitest';
import {UpdateRestartGate} from '../src/main/update-restart';
import type {UpdateSnapshot} from '../src/main/updater';
const hold = {token: 'owned-token', pid: 12345};
function rig() {
  let status: UpdateSnapshot = {status: 'downloaded', version: '0.1.2'}, busy = false, committed = false;
  const d = {snapshot: () => status, recordingBusy: () => busy, flush: vi.fn(async () => {}), acquire: vi.fn(async (_token: string) => hold), release: vi.fn(async () => {}), restart: vi.fn(() => {committed = true; status = {status: 'restarting', version: '0.1.2'}; return status;}), committed: () => committed, preparing: vi.fn()};
  return {d, gate: new UpdateRestartGate(d), setBusy(value: boolean) {busy = value;}, setStatus(value: UpdateSnapshot) {status = value;}};
}
describe('native update restart admission', () => {
  it('flushes, acquires an owned idle hold and retains it after native commit', async () => {
    const r = rig(); expect((await r.gate.run()).status).toBe('restarting');
    expect(r.d.flush).toHaveBeenCalledOnce(); expect(r.d.acquire).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(r.d.release).not.toHaveBeenCalled(); expect(r.d.preparing.mock.calls).toEqual([[true], [false]]);
  });
  it('refuses changed capture before native acquisition', async () => {
    const r = rig(); r.d.flush.mockImplementation(async () => {r.setBusy(true);});
    await expect(r.gate.run()).rejects.toThrow('activity changed'); expect(r.d.acquire).not.toHaveBeenCalled(); expect(r.d.restart).not.toHaveBeenCalled();
  });
  it('releases its exact hold when native install refuses the restart', async () => {
    const r = rig(); r.d.restart.mockImplementation(() => ({status: 'downloaded', version: '0.1.2'}));
    expect((await r.gate.run()).status).toBe('downloaded'); expect(r.d.release).toHaveBeenCalledWith(hold);
  });
  it('never installs after a failed hold admission or failed draft save', async () => {
    const r = rig(); r.d.acquire.mockRejectedValue(Error('The native engine is active.'));
    await expect(r.gate.run()).rejects.toThrow('active'); expect(r.d.restart).not.toHaveBeenCalled();
    const save = rig(); save.d.flush.mockRejectedValue(Error('Draft was not saved.')); await expect(save.gate.run()).rejects.toThrow('Draft'); expect(save.d.acquire).not.toHaveBeenCalled();
  });
  it('joins repeated restart clicks while a flush is pending', async () => {
    const r = rig(), flush = Promise.withResolvers<void>(); r.d.flush.mockImplementation(() => flush.promise);
    const a = r.gate.run(), b = r.gate.run(); expect(a).toBe(b); flush.resolve(); await a; expect(r.d.acquire).toHaveBeenCalledOnce(); expect(r.d.restart).toHaveBeenCalledOnce();
  });
  it('surfaces an unconfirmed native release and always clears only its preparation flag', async () => {
    const r = rig(); r.d.restart.mockImplementation(() => ({status: 'downloaded'})); r.d.release.mockRejectedValue(Error('Update hold cleanup was not confirmed.'));
    await expect(r.gate.run()).rejects.toThrow('not confirmed'); expect(r.d.preparing.mock.calls.at(-1)).toEqual([false]);
  });
});
it('recovers an uncertain exact hold without issuing an installation',async()=>{
  const r=rig();let owned: typeof hold | undefined;
  r.d.acquire.mockImplementation(async token=>{owned={token,pid:12345};throw Object.assign(Error('Cleanup unknown'),{code:'update-hold-cleanup-unknown',hold:owned});});
  await expect(r.gate.run()).rejects.toThrow('unknown');expect(r.d.restart).not.toHaveBeenCalled();
  await expect(r.gate.run()).rejects.toThrow('Recover');
  await r.gate.recover();expect(r.d.release).toHaveBeenCalledWith(owned);expect(r.d.restart).not.toHaveBeenCalled();
  if(!owned)throw Error('The owned acquisition did not run.');
  expect(JSON.stringify(r.gate)).not.toContain(owned.token);
});
it('joins concurrent recover clicks and blocks a fresh restart until recovery settles',async()=>{
  const r=rig(),release=Promise.withResolvers<void>();let owned;
  r.d.acquire.mockImplementation(async token=>{owned={token,pid:12345};throw Object.assign(Error('Cleanup unknown'),{code:'update-hold-cleanup-unknown',hold:owned});});
  await expect(r.gate.run()).rejects.toThrow('unknown');r.d.release.mockImplementation(()=>release.promise);
  const first=r.gate.recover(),second=r.gate.recover(),restart=r.gate.run();expect(first).toBe(second);expect(restart).toBe(first);
  expect(r.d.release).toHaveBeenCalledOnce();release.resolve();await first;expect(r.d.restart).not.toHaveBeenCalled();
});
