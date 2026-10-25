import {useEffect, useState} from 'react';
import type {AppUpdateStatus} from '../shared/contracts';
import {createNativeAPI} from './native-api';
const api = window.rushes ? createNativeAPI(window.rushes) : window.rushes;
export function AppUpdates({run}: {run: (action: () => Promise<void>) => unknown}) {
  const [update, setUpdate] = useState<AppUpdateStatus>({status: 'disabled', reason: 'unavailable'});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () => {void api.updates('status').then(value => {if (live) setUpdate(value);}).catch(() => {});};
    refresh();
    const off = api.onEvent(event => {if (event.event === 'app-update' || event.event === 'app-update-preparing') refresh();});
    return () => {live = false; off();};
  }, []);
  const action = (name: 'check' | 'restart' | 'recover') => run(async () => {
    setBusy(true);
    try {setUpdate(await api.updates(name));} finally {setBusy(false);}
  });
  const text = update.status === 'disabled'
    ? update.reason === 'development' ? 'Automatic updates are disabled in this development build.' : 'Updates are unavailable. Recording and local exports are still available.'
    : update.status === 'checking' ? 'Checking for an update…'
    : update.status === 'downloading' ? `Downloading ${update.version ?? 'update'}${update.total ? ` · ${Math.round(100 * (update.transferred ?? 0) / update.total)}%` : ''}`
    : update.status === 'downloaded' ? `Version ${update.version} is ready. Restart when you have finished recording.`
    : update.status === 'restarting' ? update.reason === 'failed' ? 'The update restart was not confirmed. Quit and reopen Rushes before recording again.' : 'Restarting to install the update…'
    : update.status === 'error' ? 'The update could not be verified. Your installed app is kept. Try checking again.'
    : update.deferred ? 'Update checking is waiting until recording and account setup finish.' : 'Rushes checks for updates while it is idle.';
  return <section className="settings-card" aria-label="App updates"><h2>App updates</h2><p role="status">{text}</p><div className="edit-tools">
    <button className="secondary" disabled={busy || ['disabled', 'checking', 'downloading', 'downloaded', 'restarting'].includes(update.status)} onClick={() => action('check')}>Check for updates</button>
    {update.nativeHoldPending && update.status !== 'restarting' && <button className="secondary" disabled={busy} onClick={() => action('recover')}>Recover update connection</button>}
    {update.status === 'downloaded' && !update.nativeHoldPending && <button className="primary" disabled={busy} onClick={() => action('restart')}>Restart to update</button>}
  </div><p className="fine-print">Updates preserve your recordings and settings. Installation waits until the native recorder confirms it is idle.</p></section>;
}
