import { useState, useRef, useEffect, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createDraftStore } from './capture/storage';
import type { BrowserConfig, DraftManifest, DraftStore, LibraryResponse, SessionResponse } from './contracts';
import { RushesAPI, RequestError, errorMessage } from './api';
import { uploadDraft, createLiveBackup } from './upload';
import type { UploadProgress } from './upload';
import { Studio } from './components/Studio';
import { DraftList, Review } from './components/Review';
import { AccountPanel, CloudLibrary, ShareViewer } from './components/Cloud';
import { Guide, useGuide } from './components/Guide';
import { Icon, Notice } from './components/common';
import './style.css';

const api = new RushesAPI();
type Page = 'studio' | 'drafts' | 'cloud' | 'account';
type ReservationCleanup = {id:string; cloudId:string; owner:string};
const cleanupKey = 'rushes.browser.reservation-cleanup.v1';
function readCleanups(): ReservationCleanup[] { try { const value: unknown = JSON.parse(localStorage.getItem(cleanupKey) ?? '[]'); return Array.isArray(value) ? value.filter(item => item && typeof item.id === 'string' && typeof item.cloudId === 'string' && typeof item.owner === 'string') : []; } catch { return []; } }
function App() {
  const [page, setPage] = useState<Page>('studio');
  const [config, setConfig] = useState<BrowserConfig | null>(null);
  const [session, setSession] = useState<SessionResponse>({user: null, csrfToken: null});
  const sessionCurrent = useRef<SessionResponse>({user: null,csrfToken:null});
  const authEpoch = useRef(0);
  const [library, setLibrary] = useState<LibraryResponse | null>(null);
  const [store, setStore] = useState<DraftStore | null>(null);
  const [drafts, setDrafts] = useState<DraftManifest[]>([]);
  const [draft, setDraft] = useState<DraftManifest | null>(null);
  const [persistent, setPersistent] = useState(false);
  const [backupFolder, setBackupFolder] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [networkError, setNetworkError] = useState('');
  const [message, setMessage] = useState('');
  const [captureBusy, setCaptureBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>();
  const [uploadRunning, setUploadRunning] = useState(false);
  const [uploadPaused, setUploadPaused] = useState(false);
  const uploadController = useRef<AbortController | null>(null);
  const uploadingId = useRef('');
  const [pendingCleanups,setPendingCleanups] = useState<ReservationCleanup[]>(readCleanups);
  const cleanupQueue = useRef(pendingCleanups);
  const cleanupRunning = useRef(false);
  const liveBackups = useRef(new Map<string, ReturnType<typeof createLiveBackup>>());
  const storeCurrent = useRef<DraftStore | null>(null);
  const guide = useGuide();
  const onBusy = useCallback((value: boolean) => setCaptureBusy(value), []);
  async function loadDrafts(next = storeCurrent.current) { if (!next) return; setDrafts((await next.list()).sort((a,b) => b.createdAt.localeCompare(a.createdAt))); }
  const refresh = useCallback(async () => { const revision = ++authEpoch.current; const current = await api.session(); if (revision !== authEpoch.current) return; if (current.user?.id !== sessionCurrent.current.user?.id || current.user?.tenantId !== sessionCurrent.current.user?.tenantId) setLibrary(null); sessionCurrent.current = current; setSession(current); if (current.user) { const result = await api.library(); if (revision === authEpoch.current && sessionCurrent.current.user?.id === current.user.id) setLibrary(result); } else setLibrary(null); }, []);
  useEffect(() => {
    let current = true; const revision = authEpoch.current;
    void Promise.allSettled([api.config(), api.session()]).then(async ([configResult, sessionResult]) => {
      if (!current) return;
      if (configResult.status === 'fulfilled') setConfig(configResult.value); else setNetworkError('Cloud service is unavailable. Local recording works independently when browser capture and storage are supported.');
      if (revision === authEpoch.current && sessionResult.status === 'fulfilled') { sessionCurrent.current = sessionResult.value; setSession(sessionResult.value); if (sessionResult.value.user) try { const result = await api.library(); if (current && revision === authEpoch.current && sessionCurrent.current.user?.id === sessionResult.value.user?.id) setLibrary(result); } catch (value) { if (current) setNetworkError(errorMessage(value)); } }
    });
    void createDraftStore().then(async next => { if (!current) return; storeCurrent.current = next; setStore(next); await loadDrafts(next); }).catch(value => { if (current) setStorageError(errorMessage(value)); });
    void navigator.storage?.persisted().then(value => { if (current) setPersistent(value); }).catch(() => {});
    return () => { current = false; uploadController.current?.abort(); liveBackups.current.forEach(lane => { void lane.cancel(); }); };
  }, []);
  useEffect(() => {
    if (!captureBusy && !uploadRunning) return;
    function leaving(event: BeforeUnloadEvent) { event.preventDefault(); event.returnValue = ''; }
    window.addEventListener('beforeunload', leaving);
    return () => window.removeEventListener('beforeunload', leaving);
  }, [captureBusy, uploadRunning]);
  async function chooseBackup() {
    setMessage('');
    try {
      const picker = (window as Window & {showDirectoryPicker?: (options: {mode: string}) => Promise<FileSystemDirectoryHandle>}).showDirectoryPicker;
      if (!picker) throw new Error('Backup folders require desktop Chrome. You can download each original after recording.');
      const folder = await picker.call(window, {mode: 'readwrite'});
      const next = await createDraftStore(folder); storeCurrent.current = next; setStore(next); setBackupFolder(true); setStorageError(''); await loadDrafts(next); setMessage('Backup folder connected. Each saved chunk is closed before its checkpoint is shown.');
    } catch (value) { if (!(value instanceof DOMException && value.name === 'AbortError')) setMessage(errorMessage(value)); }
  }
  async function requestPersistence() { try { const allowed = await navigator.storage.persist(); setPersistent(allowed); setMessage(allowed ? 'Persistent browser storage granted. Keep downloads or a backup folder for important recordings.' : 'This browser did not grant persistent storage. Choose a backup folder or download your originals after recording.'); } catch (value) { setMessage(errorMessage(value)); } }
  function openDraft(value: DraftManifest) { setDraft(value); setPage('drafts'); setMessage(''); }
  async function completed(value: DraftManifest) { setCaptureBusy(false); setDraft(value); setPage('drafts'); await loadDrafts(); if (value.cloudRecordingId && value.state === 'complete') void startUpload(value); }
  async function logout() { authEpoch.current++; uploadController.current?.abort(); liveBackups.current.forEach(lane => { void lane.cancel(); }); liveBackups.current.clear(); await api.logout(); authEpoch.current++; api.setSession({user: null,csrfToken: null}); sessionCurrent.current = {user:null,csrfToken:null}; setSession({user:null,csrfToken:null}); setLibrary(null); setMessage('Signed out. Local drafts stay on this browser.'); }
  const canUpload = !!session.user && !!config?.hostingEnabled && !!config.streamConfigured && !!library?.usage.subscription.canUpload;
  const uploadReason = !session.user ? 'Sign in from Cloud account to host this recording.' : !config?.hostingEnabled || !config.streamConfigured ? 'Cloud hosting is not configured on this deployment yet.' : !library?.usage.subscription.canUpload ? 'Upload access needs an active server-confirmed subscription. Open Cloud account to check billing and usage.' : '';
  async function startUpload(target: DraftManifest | null = draft) {
    if (!store || !target || !canUpload || uploadRunning) return;
    const revision = authEpoch.current; const owner = sessionCurrent.current.user?.id;
    const id = target.id; const controller = new AbortController(); uploadController.current = controller; uploadingId.current = id;
    setUploadRunning(true); setUploadPaused(false); setMessage('');
    try {
      const lane = liveBackups.current.get(id); if (lane) { await lane.cancel(); liveBackups.current.delete(id); }
      const result = await uploadDraft({api,store,id,signal:controller.signal,onProgress:setUploadProgress});
      if (revision !== authEpoch.current || owner !== sessionCurrent.current.user?.id) return;
      setMessage(result.state === 'ready' ? 'Your video is ready in the private cloud library.' : 'Upload complete. Cloud processing is still pending; check its status in the cloud library.');
      await refresh();
    } catch (value) {
      if (controller.signal.aborted) { setUploadPaused(true); setMessage('Upload paused. Its acknowledged chunks and provider position are saved.'); }
      else { setUploadPaused(true); setMessage(`Upload needs attention: ${errorMessage(value)} Your local originals stay saved. You can download them or retry.`); }
    } finally { const saved = await store.load(id).catch(() => null); if (saved) setDraft(current => current?.id === id ? saved : current); await loadDrafts(store).catch(value => setMessage(errorMessage(value))); setUploadRunning(false); }
  }
  function cloudCheckpoint(value: DraftManifest) {
    if (!value.cloudRecordingId || !storeCurrent.current) return;
    let lane = liveBackups.current.get(value.id);
    if (!lane) {
      lane = createLiveBackup({api,store:storeCurrent.current,id:value.id,onProgress:progress => { if (progress.completed === progress.total) setMessage('Saved chunks are backed up privately.'); },onError:reason => setMessage(`Private cloud backup paused: ${reason} Saved local chunks remain available. Backup retries on reconnection or Stop.`)});
      liveBackups.current.set(value.id,lane);
    }
    lane.enqueue();
  }
  function journalCleanups(queue: ReservationCleanup[]) {
    cleanupQueue.current = queue; setPendingCleanups(queue); localStorage.setItem(cleanupKey,JSON.stringify(queue));
  }
  async function retryCleanups() {
    if (cleanupRunning.current || !sessionCurrent.current.user) return;
    cleanupRunning.current = true;
    try {
      for (const item of [...cleanupQueue.current]) {
        if (item.owner !== sessionCurrent.current.user?.id) continue;
        try { await api.remove(item.cloudId); journalCleanups(cleanupQueue.current.filter(value => value.cloudId !== item.cloudId)); }
        catch (value) { if (value instanceof RequestError && value.status === 404) journalCleanups(cleanupQueue.current.filter(entry => entry.cloudId !== item.cloudId)); else setMessage(`Cloud reservation cleanup is saved for retry: ${errorMessage(value)} Local recording remains available.`); }
      }
    } finally { cleanupRunning.current = false; }
  }
  async function discardCloud(id: string, cloudId: string) {
    const lane = liveBackups.current.get(id); if (lane) await lane.cancel(); liveBackups.current.delete(id);
    const owner = sessionCurrent.current.user?.id; if (!owner) return;
    try { if (!cleanupQueue.current.some(item => item.cloudId === cloudId)) journalCleanups([...cleanupQueue.current,{id,cloudId,owner}]); await retryCleanups(); }
    catch (value) { setMessage(`Cloud reservation cleanup could not be saved: ${errorMessage(value)} Delete the draft cloud recording from your private library before another cloud take.`); }
  }
  useEffect(() => { function reconnect() { liveBackups.current.forEach(lane => lane.retry()); void retryCleanups(); } window.addEventListener('online',reconnect); return () => window.removeEventListener('online',reconnect); }, []);
  useEffect(() => { if (session.user) void retryCleanups(); }, [session.user?.id]);
  async function removeLocal() { if (!store || !draft || !confirm('Delete this local draft and its saved chunks? Download anything you want to keep first. Cloud copies are managed separately.')) return; try { await store.remove(draft.id); setDraft(null); await loadDrafts(); } catch (value) { setMessage(errorMessage(value)); } }
  async function loadMore() {
    const revision = authEpoch.current; const cursor = library?.nextCursor; const owner = sessionCurrent.current.user?.id;
    if (!cursor || !owner) return;
    const next = await api.library(cursor);
    if (revision !== authEpoch.current || sessionCurrent.current.user?.id !== owner) return;
    setLibrary(current => current ? { ...next, recordings: Array.from(new Map([...current.recordings, ...next.recordings].map(item => [item.id,item])).values()) } : current);
  }
  function navigate(value: Page) { if (captureBusy) return; setPage(value); setDraft(null); }
  const nav = [['studio','record','Record a video'],['drafts','grid','Local drafts'],['cloud','cloud','Cloud library']] as const;
  return <div className="app"><aside className="sidebar"><a className="brand" href="/" aria-label="Rushes home" onClick={event => { event.preventDefault(); navigate('studio'); }}><span className="brand-icon">r</span>rushes<span className="brand-period">.</span></a><div className="nav-label">WORKSPACE</div><nav data-guide="library">{nav.map(([value, icon, title]) => <button key={value} className={`nav ${page === value ? 'active' : ''}`} disabled={captureBusy} onClick={() => navigate(value)}><Icon name={icon}/>{title}{value === 'drafts' && drafts.length > 0 && <span className="nav-count" aria-hidden="true">{drafts.length}</span>}</button>)}</nav><div className="sidebar-bottom"><button className={`nav ${page === 'account' ? 'active' : ''}`} disabled={captureBusy} onClick={() => navigate('account')}><Icon name="user"/>Cloud account</button><button className="nav" disabled={captureBusy} onClick={() => { navigate('studio'); guide.replay(); }}><Icon name="help"/>First recording guide</button><div className="sidebar-foot"><span className="avatar">{session.user ? (session.user.name || session.user.email).slice(0,1).toUpperCase() : 'r'}</span><div><strong>{session.user ? session.user.name || 'Your workspace' : 'Your browser'}</strong><small>{session.user ? 'Private cloud account' : 'No download needed'}</small></div></div></div></aside><div className="workspace"><header className="topbar"><span>{page === 'studio' ? 'Record a video' : page === 'drafts' ? 'Local drafts' : page === 'cloud' ? 'Cloud library' : 'Cloud account'}</span><div><span className="desktop-note">Desktop Chrome</span><button className="text-button" disabled={captureBusy} onClick={() => navigate('account')}>{session.user ? 'Account & usage' : 'Sign in'}<Icon name="arrow" size={15}/></button></div></header><main className="main-content">{networkError && <Notice>{networkError}<button className="text-button" onClick={() => { void Promise.all([api.config().then(setConfig),refresh()]).then(() => setNetworkError('')).catch(value => setNetworkError(errorMessage(value))); }}>Retry cloud connection</button></Notice>}{pendingCleanups.some(item => item.owner === session.user?.id) && <Notice>Cancelled cloud reservation cleanup is pending.<button className="text-button" onClick={() => { void retryCleanups(); }}>Retry reservation cleanup</button></Notice>}{message && <Notice>{message}<button aria-label="Dismiss message" className="text-button" onClick={() => setMessage('')}>Dismiss</button></Notice>}{page === 'studio' && <Studio cloud={{available:canUpload && !uploadRunning && !pendingCleanups.some(item => item.owner === session.user?.id),reason:pendingCleanups.some(item => item.owner === session.user?.id) ? 'A cancelled cloud reservation needs cleanup. Retry below before another cloud take; local recording remains available.' : uploadRunning ? 'Another upload is running. Local recording is still available.' : uploadReason,reserve:async input => (await api.create(input)).id,checkpoint:cloudCheckpoint,discard:(id,cloudId) => { void discardCloud(id,cloudId); }}} captureAllowed={config?.captureEnabled !== false} store={store} persistent={persistent} backupFolder={backupFolder} storageError={storageError} chooseBackup={chooseBackup} requestPersistence={requestPersistence} onComplete={value => { void completed(value); }} onBusy={onBusy}/>} {page === 'drafts' && (draft && store ? <Review draft={draft} store={store} back={() => { setDraft(null); void loadDrafts(); }} canUpload={canUpload && !uploadRunning} uploadReason={uploadRunning && uploadingId.current !== draft.id ? 'Another upload is running. Open its local draft to pause it, or wait for it to finish.' : uploadReason} onUpload={() => { void startUpload(); }} uploadProgress={uploadingId.current === draft.id ? uploadProgress : undefined} uploadRunning={uploadRunning && uploadingId.current === draft.id} uploadPaused={uploadPaused && uploadingId.current === draft.id} pauseUpload={() => uploadController.current?.abort()} onSaved={setDraft} remove={() => { void removeLocal(); }}/> : <DraftList drafts={drafts} open={openDraft} newRecording={() => navigate('studio')}/>)}{page === 'cloud' && <CloudLibrary api={api} config={config} session={session} library={library} refresh={refresh} loadMore={loadMore} account={() => navigate('account')}/>} {page === 'account' && <AccountPanel api={api} config={config} session={session} library={library} refresh={refresh} logout={logout}/>}</main><footer className="workspace-footer">Made for the moments a message cannot explain.<span>Local first. Share deliberately.</span></footer></div>{page === 'studio' && <Guide guide={guide}/>}</div>;
}
const share = location.pathname.match(/^\/s\/([^/]+)\/?$/);
const reactRoot: Root = import.meta.hot?.data.root ?? createRoot(document.getElementById('root')!);
if (import.meta.hot) import.meta.hot.dispose(data => { data.root = reactRoot; });
reactRoot.render(share ? <ShareViewer api={api} id={decodeURIComponent(share[1])}/> : <App/>);
