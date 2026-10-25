import { useEffect, useRef, useState } from 'react';
import type { BrowserConfig, SessionResponse } from '../contracts';
import { RushesAPI, errorMessage } from '../api';
import { Icon, Notice } from './common';
export const nativeReturnKey = 'rushes.native-link-return.v1';
export const validLinkId = (id: string) => /^[A-Za-z0-9_-]{16,128}$/.test(id);
type Link = {id: string; deviceName: string; status: 'pending' | 'approved'; expiresAt: string};
export default function NativeLink({api, id}: {api: RushesAPI; id: string}) {
  const [session, setSession] = useState<SessionResponse>({user: null, csrfToken: null});
  const [config, setConfig] = useState<BrowserConfig>();
  const [link, setLink] = useState<Link>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  async function load() {
    const revision = ++epoch.current; setError(''); setBusy(true); setLink(undefined);
    try {
      if (!validLinkId(id)) throw Error('This Mac connection link is invalid. Start a new connection from Rushes.');
      const configuration = await api.config(), account = await api.session();
      if (revision !== epoch.current) return;
      setConfig(configuration); setSession(account);
      if (account.user) { const value = await api.request<Link>(`/api/native/link/${id}`); if (revision === epoch.current) setLink(value); }
    } catch (value) { if (revision === epoch.current) setError(errorMessage(value)); }
    finally { if (revision === epoch.current) setBusy(false); }
  }
  useEffect(() => {void load(); return () => {epoch.current++; api.invalidateSessionReads();};}, [id]);
  async function connect() {
    if (!session.user || !link || link.status !== 'pending') return;
    const revision = epoch.current; setBusy(true); setError('');
    try {
      await api.request(`/api/native/link/${id}/approve`, 'POST', {});
      if (revision !== epoch.current) return;
      setLink({...link, status: 'approved'}); sessionStorage.removeItem(nativeReturnKey);
    } catch (value) { if (revision === epoch.current) setError(errorMessage(value)); }
    finally { if (revision === epoch.current) setBusy(false); }
  }
  return <main className="share-page"><a className="brand" href="/" onClick={() => sessionStorage.removeItem(nativeReturnKey)}><span className="brand-icon">r</span>rushes<span className="brand-period">.</span></a><div className="page-heading"><div><span className="eyebrow">RUSHES FOR MAC</span><h1>Connect your Mac</h1><p>Link the Mac app to your private cloud account.</p></div></div>
    {error && <Notice error>{error}<button className="text-button" disabled={busy} onClick={() => {void load();}}>Retry connection details</button></Notice>}
    <section className="card share-unlock">{link?.status === 'approved' ? <><Icon name="check" size={28}/><h2>Connection approved</h2><p>Return to Rushes on your Mac. The app will confirm your connected account before you share.</p></> : session.user && link ? <><Icon name="lock" size={28}/><h2>{link.deviceName}</h2><p>Connect this app as <strong>{session.user.email}</strong>?</p><p>The Mac app can upload, share and manage this account’s videos until you disconnect it. Connecting does not start a subscription or upload a recording.</p><p className="fineprint">Only connect if you just started this action in Rushes on your Mac. This request expires {new Date(link.expiresAt).toLocaleTimeString()}.</p><button className="primary" disabled={busy || Date.parse(link.expiresAt) <= Date.now()} onClick={() => {void connect();}}>{busy ? 'Connecting…' : 'Connect this Mac'}</button></> : <><h2>Sign in to connect</h2><p>After signing in, check the account and Mac name before approving access.</p><a className={`button primary ${!config?.googleConfigured || busy ? 'disabled' : ''}`} aria-disabled={!config?.googleConfigured || busy} href={config?.googleConfigured && !busy ? '/auth/google/start' : undefined} onClick={() => {if (validLinkId(id)) sessionStorage.setItem(nativeReturnKey, id);}}>Sign in with Google</a></>}</section><a className="button secondary" href="/" onClick={() => sessionStorage.removeItem(nativeReturnKey)}>Back to cloud library</a>
  </main>;
}
