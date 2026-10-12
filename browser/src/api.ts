import type { ExportGrant, BrowserConfig, SessionResponse, LibraryResponse, RecordingDetail, ChunkGrantInput, ChunkGrant, ChunkDescriptor, FinalizeInput, UploadGrant, PlaybackGrant, ShareInput, CreateRecordingInput } from './contracts';

export class RequestError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 0) { super(message); this.name = 'RequestError'; }
}
export function errorMessage(value: unknown): string {
  if (value instanceof RequestError) return `${value.message} (${value.code})`;
  return value instanceof Error ? value.message : 'Something went wrong. Your local recordings are still saved.';
}
export function trustedURL(value: string): string {
  const url = new URL(value, location.origin);
  if (url.protocol !== 'https:' && !(url.origin === location.origin && url.protocol === 'http:')) throw new RequestError('UNSAFE_URL', 'The service returned an unsupported link.');
  return url.href;
}
export class RushesAPI {
  private csrf: string | null = null;
  constructor(private readonly transport: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  setSession(session: SessionResponse) { this.csrf = session.csrfToken; }
  async request<T>(path: string, method = 'GET', data?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.csrf) headers['X-CSRF-Token'] = this.csrf;
    if (method !== 'GET') {
      if (!this.csrf && !/^\/api\/shares\/[^/]+\/(unlock|playback)$/.test(path)) throw new RequestError('SIGN_IN_REQUIRED', 'Sign in again before making this change.');
      if (this.csrf) headers['X-CSRF-Token'] = this.csrf;
      if (data !== undefined) headers['Content-Type'] = 'application/json';
    }
    const deadline = AbortSignal.timeout(30000);
    const requestSignal = signal ? AbortSignal.any([signal,deadline]) : deadline;
    let response: Response;
    try { response = await this.transport(path, { method, headers, credentials: 'same-origin', cache: 'no-store', body: data === undefined ? undefined : JSON.stringify(data), signal:requestSignal }); }
    catch (error) { if (signal?.aborted) throw error; if (deadline.aborted) throw new RequestError('NETWORK_TIMEOUT','Rushes did not respond in time. Retry; local data remains saved.'); throw new RequestError('NETWORK', 'Could not reach Rushes. Check your connection and retry.'); }
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new RequestError(payload?.error?.code ?? 'SERVICE_ERROR', payload?.error?.message ?? 'Rushes could not complete this request.', response.status);
    if (payload === null) throw new RequestError('INVALID_RESPONSE', 'Rushes returned an unreadable response.');
    return payload as T;
  }
  config() { return this.request<BrowserConfig>('/api/config'); }
  async session() { const result = await this.request<SessionResponse>('/api/session'); this.setSession(result); return result; }
  logout() { return this.request<{ok: true}>('/api/logout', 'POST', {}); }
  library(cursor?: string) { return this.request<LibraryResponse>(`/api/recordings${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`); }
  create(input: CreateRecordingInput, signal?: AbortSignal) { return this.request<RecordingDetail>('/api/recordings', 'POST', input, signal); }
  recording(id: string) { return this.request<RecordingDetail>(`/api/recordings/${encodeURIComponent(id)}`); }
  rename(id: string, title: string) { return this.request<RecordingDetail>(`/api/recordings/${encodeURIComponent(id)}`, 'PATCH', { title }); }
  remove(id: string) { return this.request<{state: 'deleting' | 'deleted'}>(`/api/recordings/${encodeURIComponent(id)}`, 'DELETE'); }
  chunks(id: string, signal?: AbortSignal) { return this.request<{chunks: ChunkDescriptor[]}>(`/api/recordings/${encodeURIComponent(id)}/chunks`, 'GET', undefined, signal); }
  grant(id: string, input: ChunkGrantInput, signal?: AbortSignal) { return this.request<ChunkGrant>(`/api/recordings/${encodeURIComponent(id)}/chunks/grant`, 'POST', input, signal); }
  finalize(id: string, input: FinalizeInput, signal?: AbortSignal) { return this.request<{upload: UploadGrant; state: 'uploading'}>(`/api/recordings/${encodeURIComponent(id)}/finalize`, 'POST', input, signal); }
  process(id: string, signal?: AbortSignal) { return this.request<RecordingDetail>(`/api/recordings/${encodeURIComponent(id)}/process`, 'POST', {}, signal); }
  playback(id: string) { return this.request<PlaybackGrant>(`/api/recordings/${encodeURIComponent(id)}/playback`); }
  share(id: string, input: ShareInput) { return this.request<{id: string; url: string; expiresAt: string | null}>(`/api/recordings/${encodeURIComponent(id)}/share`, 'POST', input); }
  revoke(id: string) { return this.request<{ok: true}>(`/api/recordings/${encodeURIComponent(id)}/share`, 'DELETE'); }
  checkout() { return this.request<{url: string}>('/api/billing/checkout', 'POST', {}); }
  exportRecording(id: string) { return this.request<ExportGrant>(`/api/recordings/${encodeURIComponent(id)}/export`, 'POST', {}); }
  portal() { return this.request<{url: string}>('/api/billing/portal', 'POST', {}); }
}
