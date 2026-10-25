import { useState } from 'react';
import type { DraftManifest, DraftStore, TrackKind } from '../contracts';
import { createDraftStore } from '../capture/storage';
import { errorMessage } from '../api';
import { Notice } from './common';
const names: Record<TrackKind, string> = {screen: 'Screen', camera: 'Camera', microphone: 'Microphone', 'tab-audio': 'Display audio', composed: 'Composed video'};
function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export default function LegacyDrafts() {
  const [store, setStore] = useState<DraftStore>();
  const [drafts, setDrafts] = useState<DraftManifest[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function find() {
    setBusy(true); setError('');
    try { const next = await createDraftStore(); setDrafts(await next.list()); setStore(next); }
    catch (value) { setError(errorMessage(value)); }
    finally { setBusy(false); }
  }
  async function original(draft: DraftManifest, kind: TrackKind) {
    if (!store) return;
    setBusy(true); setError('');
    try {
      let blob: Blob;
      try { blob = await store.trackBlob(draft.id, kind); }
      catch (value) {
        const track = draft.tracks.find(item => item.kind === kind);
        if (draft.state === 'complete' || !track?.chunks.length) throw value;
        const parts: Blob[] = [];
        for (const chunk of track.chunks) parts.push(await store.readChunk(draft.id, chunk));
        blob = new Blob(parts, {type: track.mimeType});
      }
      if (!blob.size) throw new Error('This track has no saved bytes. Keep the draft and any backup folder.');
      download(blob, `Rushes-${draft.id}-${kind}.webm`);
    } catch (value) { setError(errorMessage(value)); }
    finally { setBusy(false); }
  }
  return <section><div className="page-heading"><div><span className="eyebrow">EXISTING BROWSER DATA</span><h1>Recover old browser drafts</h1><p>Download originals saved in this browser before web recording was deferred.</p></div></div>
    {error && <Notice error>{error}</Notice>}<div className="card"><p>Use the same browser profile and website address that recorded the draft. This reads local storage only; it does not record or upload.</p><button className="secondary" disabled={busy} onClick={() => {void find();}}>{busy ? 'Reading saved data…' : 'Find saved drafts'}</button>{store && drafts.length === 0 && <p>No saved drafts were found in this browser on this website.</p>}</div>
    {drafts.map(draft => <article className="card" key={draft.id}><h2>{draft.title}</h2><p>{draft.state} · {new Date(draft.createdAt).toLocaleDateString()}</p>{draft.recoveryNote && <p>{draft.recoveryNote}</p>}<div className="edit-tools">{draft.tracks.map(track => <button className="secondary" key={track.kind} disabled={busy} onClick={() => {void original(draft, track.kind);}}>Download {names[track.kind]}</button>)}<button className="secondary" onClick={() => download(new Blob([JSON.stringify(draft, null, 2)], {type: 'application/json'}), `Rushes-${draft.id}-manifest.json`)}>Download diagnostic manifest</button></div></article>)}
  </section>;
}
