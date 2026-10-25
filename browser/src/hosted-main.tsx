import * as UI from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RushesAPI, errorMessage, trustedURL } from './api';
import type { BrowserConfig, LibraryResponse, SessionResponse } from './contracts';
import { AccountPanel, CloudLibrary, ShareViewer } from './components/Cloud';
import { Icon, Notice } from './components/common';
import './style.css';

const NativeLink = UI.lazy(() => import('./components/NativeLink'));
const LegacyDrafts = UI.lazy(() => import('./components/LegacyDrafts'));
const api = new RushesAPI();
const signedOut: SessionResponse = {user: null, csrfToken: null};
type Page = 'cloud' | 'account' | 'desktop' | 'legacy';
function App() {
  const [page, setPage] = UI.useState<Page>(location.pathname === '/local-drafts' ? 'legacy' : /^\/(record|studio)(\/|$)/.test(location.pathname) ? 'desktop' : 'cloud');
  const [config, setConfig] = UI.useState<BrowserConfig | null>(null);
  const [session, setSession] = UI.useState<SessionResponse>(signedOut);
  const [library, setLibrary] = UI.useState<LibraryResponse | null>(null);
  const [error, setError] = UI.useState('');
  const [message, setMessage] = UI.useState('');
  const currentSession = UI.useRef(signedOut);
  const epoch = UI.useRef(0);
  const refresh = UI.useCallback(async () => {
    const revision = ++epoch.current;
    const next = await api.session();
    if (revision !== epoch.current) return;
    if (next.user?.id !== currentSession.current.user?.id || next.user?.tenantId !== currentSession.current.user?.tenantId) setLibrary(null);
    currentSession.current = next; setSession(next);
    if (!next.user) { setLibrary(null); return; }
    const result = await api.library();
    if (revision === epoch.current && next.user.id === currentSession.current.user?.id && next.user.tenantId === currentSession.current.user?.tenantId) setLibrary(result);
  }, []);
  UI.useEffect(() => {
    let alive = true;
    void Promise.allSettled([api.config(), refresh()]).then(([configuration, account]) => {
      if (!alive) return;
      if (configuration.status === 'fulfilled') setConfig(configuration.value);
      if (configuration.status === 'rejected' || account.status === 'rejected') setError('Could not load your cloud account. Check your connection and retry.');
    });
    return () => { alive = false; epoch.current++; api.invalidateSessionReads(); };
  }, [refresh]);
  async function reconnect() {
    setError('');
    try { const [configuration] = await Promise.all([api.config(), refresh()]); setConfig(configuration); }
    catch (value) { setError(errorMessage(value)); }
  }
  async function logout() {
    epoch.current++; api.invalidateSessionReads();
    await api.logout();
    epoch.current++; currentSession.current = signedOut; setSession(signedOut); setLibrary(null);
    setMessage('Signed out. Your recordings remain saved on your Mac.');
  }
  async function loadMore() {
    const revision = epoch.current, cursor = library?.nextCursor, owner = currentSession.current.user;
    if (!cursor || !owner) return;
    const next = await api.library(cursor);
    if (revision !== epoch.current || owner.id !== currentSession.current.user?.id || owner.tenantId !== currentSession.current.user?.tenantId) return;
    setLibrary(value => value ? {...next, recordings: Array.from(new Map([...value.recordings, ...next.recordings].map(item => [item.id, item])).values())} : value);
  }
  const nav = [['cloud', 'cloud', 'Cloud library'], ['desktop', 'record', 'Record on Mac']] as const;
  return <div className="app"><aside className="sidebar">
    <a className="brand" href="/" aria-label="Rushes home" onClick={event => {event.preventDefault(); setPage('cloud');}}><span className="brand-icon">r</span>rushes<span className="brand-period">.</span></a>
    <div className="nav-label">WORKSPACE</div><nav>{nav.map(([value, icon, label]) => <button key={value} className={`nav ${page === value ? 'active' : ''}`} onClick={() => setPage(value)}><Icon name={icon}/>{label}</button>)}</nav>
    <div className="sidebar-bottom"><button className={`nav ${page === 'account' ? 'active' : ''}`} onClick={() => setPage('account')}><Icon name="user"/>Cloud account</button><div className="sidebar-foot"><span className="avatar">{(session.user?.name || 'r').slice(0, 1).toUpperCase()}</span><div><strong>{session.user?.name || 'Rushes Cloud'}</strong><small>Record on Mac. Watch anywhere.</small></div></div></div>
  </aside><div className="workspace"><header className="topbar"><span>{page === 'cloud' ? 'Cloud library' : page === 'account' ? 'Cloud account' : page === 'legacy' ? 'Existing browser drafts' : 'Record on Mac'}</span><button className="text-button" onClick={() => setPage('account')}>{session.user ? 'Account & usage' : 'Sign in'}<Icon name="arrow" size={15}/></button></header>
    <main className="main-content">{error && <Notice error>{error}<button className="text-button" onClick={() => {void reconnect();}}>Retry cloud connection</button></Notice>}{message && <Notice>{message}<button className="text-button" onClick={() => setMessage('')}>Dismiss</button></Notice>}
      {page === 'cloud' && <CloudLibrary api={api} config={config} session={session} library={library} refresh={refresh} loadMore={loadMore} account={() => setPage('account')}/>}
      {page === 'account' && <AccountPanel api={api} config={config} session={session} library={library} refresh={refresh} logout={logout}/>}
      {page === 'legacy' && <UI.Suspense fallback={<p>Opening saved drafts…</p>}><LegacyDrafts/></UI.Suspense>}
      {page === 'desktop' && <section><div className="page-heading"><div><span className="eyebrow">RUSHES FOR MAC</span><h1>Record on your Mac. Share anywhere.</h1><p>A small recorder for your screen, camera and microphone.</p></div></div><div className="card"><h2>Start in the Mac app</h2><ol className="benefits"><li>Choose your screen, camera and microphone.</li><li>Record, then review your video and keep the separate originals.</li><li>Share to your cloud account. Manage links and playback here.</li></ol>{config?.macDownloadURL ? <a className="button primary" href={trustedURL(config.macDownloadURL)}>Download Rushes for Mac<Icon name="down" size={16}/></a> : <p>The signed Mac installer is being prepared. Existing Mac installations can still record locally.</p>}<p className="fineprint">Web recording is deferred. This website does not request camera, microphone or screen access.</p><button className="text-button" onClick={() => setPage('legacy')}>Recover old browser drafts</button></div></section>}
    </main><footer className="workspace-footer">Made for the moments a message cannot explain.<span>Record on Mac. Share deliberately.</span></footer>
  </div></div>;
}
let nativeLink = location.pathname.match(/^\/desktop\/link\/([A-Za-z0-9_-]{16,128})\/?$/)?.[1];
if (location.pathname === '/') {
  try {
    const pending = sessionStorage.getItem('rushes.native-link-return.v1');
    if (pending && /^[A-Za-z0-9_-]{16,128}$/.test(pending)) {nativeLink = pending; history.replaceState(null, '', `/desktop/link/${pending}`);}
  } catch {}
}
const share = location.pathname.match(/^\/s\/([^/]+)\/?$/);
const reactRoot: Root = import.meta.hot?.data.root ?? createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.dispose(data => {data.root = reactRoot;});
reactRoot.render(nativeLink ? <UI.Suspense fallback={<p>Opening Mac connection…</p>}><NativeLink api={api} id={nativeLink}/></UI.Suspense> : share ? <ShareViewer api={api} id={decodeURIComponent(share[1])}/> : <App/>);
