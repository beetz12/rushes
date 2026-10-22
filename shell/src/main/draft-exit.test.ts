import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftExitRequests } from './draft-exit';
afterEach(() => vi.useRealTimers());
describe('save draft before leaving the application', () => {
  it('joins repeated requests and requires the matching renderer confirmation', async () => {
    const sent: string[] = [],
      requests = new DraftExitRequests((token) => sent.push(token));
    const first = requests.flush();
    expect(requests.flush()).toBe(first);
    expect(requests.reply('obsolete')).toBe(false);
    expect(sent).toHaveLength(1);
    expect(requests.reply(sent[0])).toBe(true);
    await first;
    const second = requests.flush();
    expect(requests.reply(sent[0])).toBe(false);
    requests.reply(sent[1], 'disk write failed');
    await expect(second).rejects.toMatchObject({
      code: 'draft-save-failed',
      message: 'disk write failed',
    });
  });
  it('timeout preserves failure and a late reply cannot approve the retry', async () => {
    vi.useFakeTimers();
    const sent: string[] = [],
      requests = new DraftExitRequests((token) => sent.push(token), 50);
    const first = requests.flush();
    const rejected = expect(first).rejects.toMatchObject({ code: 'draft-save-failed' });
    await vi.advanceTimersByTimeAsync(51);
    await rejected;
    const retry = requests.flush();
    expect(requests.reply(sent[0])).toBe(false);
    requests.reply(sent[1]);
    await retry;
  });
});
