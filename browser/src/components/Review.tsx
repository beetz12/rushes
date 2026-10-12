import { useEffect, useState } from 'react';
import type { DraftManifest, DraftStore, TrackKind } from '../contracts';
import type { UploadProgress } from '../upload';
import { errorMessage } from '../api';
import { verifyPlayback } from '../capture';
import { Icon, Notice, bytes, time } from './common';
const trackNames: Record<TrackKind,string> = {composed: 'Composed video', screen: 'Screen original', camera: 'Camera original', microphone: 'Microphone original', 'tab-audio': 'Display audio original'};
function downloadBlob(blob: Blob, filename: string) { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
const fileTitle = (title: string) => title.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0,100) || 'Rushes recording';
export function Review({ draft, store, back, canUpload, uploadReason, onUpload, uploadProgress, uploadRunning, uploadPaused, pauseUpload, onSaved, remove }: {
  draft: DraftManifest; store: DraftStore; back: () => void; canUpload: boolean; uploadReason: string;
  onUpload: () => void; uploadProgress?: UploadProgress; uploadRunning: boolean; uploadPaused: boolean;
  pauseUpload: () => void; onSaved: (value: DraftManifest) => void; remove: () => void;
}) {
  const [preview, setPreview] = useState('');
  const [track, setTrack] = useState<TrackKind>('composed');
  const [error, setError] = useState('');
  const [title, setTitle] = useState(draft.title);
  const [working, setWorking] = useState(false);
  async function savedTrack(kind: TrackKind) {
    try { return await store.trackBlob(draft.id,kind); }
    catch (failure) {
      if (draft.state === 'complete') throw failure;
      const indexed = draft.tracks.find(item => item.kind === kind);
      if (!indexed?.chunks.length) throw failure;
      const parts: Blob[] = [];
      for (const chunk of indexed.chunks) parts.push(await store.readChunk(draft.id,chunk));
      return new Blob(parts,{type:indexed.mimeType});
    }
  }
  useEffect(() => {
    let url = '', stale = false; setPreview(''); setError('');
    if (!draft.tracks.length) { setError('No playable track could be indexed. Keep the retained draft and any backup folder; download its diagnostic manifest to preserve the known information.'); return; }
    if (!draft.tracks.some(item => item.kind === track)) { setTrack(draft.tracks.find(item => item.kind !== 'microphone' && item.kind !== 'tab-audio')?.kind ?? draft.tracks[0]?.kind ?? 'composed'); return; }
    void savedTrack(track).then(async blob => { if (draft.state !== 'complete') { try { await verifyPlayback(blob,track !== 'microphone' && track !== 'tab-audio'); } catch (value) { if (!stale) setError(errorMessage(value)); } } if (!blob.size) throw new Error('No saved samples for this track.'); if (!stale) { url = URL.createObjectURL(blob); setPreview(url); } }).catch(value => { if (!stale) setError(errorMessage(value)); });
    return () => { stale = true; if (url) URL.revokeObjectURL(url); };
  }, [draft.id, store, track]);
  async function download(kind: TrackKind) { setWorking(true); try { const blob = await savedTrack(kind); if (!blob.size) throw new Error('No saved bytes for this track.'); downloadBlob(blob, `${fileTitle(draft.title)} - ${kind}${draft.state === 'complete' ? '' : ' - recovered'}.webm`); } catch (value) { setError(errorMessage(value)); } finally { setWorking(false); } }
  async function rename() { const value = title.trim(); if (!value) return false; try { const current = await store.load(draft.id); const next = {...current, title: value}; await store.save(next); onSaved(next); return true; } catch (value) { setError(errorMessage(value)); return false; } }
  const percent = uploadProgress ? Math.round(uploadProgress.completed / Math.max(1,uploadProgress.total) * 100) : 0;
  const phaseLabel = {backup: 'Backing up separate originals', hashing: 'Verifying composed video', video: 'Uploading composed video', processing: 'Waiting for cloud processing'};
  return <section><button className="back-button" onClick={back}>← Local drafts</button><div className="page-heading"><div><span className="eyebrow">LOCAL REVIEW</span><h1>{draft.title}</h1><p>{time(draft.durationMs)} · {draft.tracks.length} separate tracks · {draft.state}</p></div><span className="pill"><Icon name="lock" size={14}/> Saved on this browser</span></div>
    {draft.state !== 'complete' && <Notice>This take was interrupted. Saved through {time(draft.lastCheckpointMs)}. Encoder data after the last checkpoint may be lost, and recovered WebM may not play. Your saved original bytes are available to download.{draft.recoveryNote ? ` ${draft.recoveryNote}` : ''}</Notice>}
    {error && <Notice error>{error}</Notice>}
    <div className="review-grid"><div><div className="review-player">{preview ? track === 'microphone' || track === 'tab-audio' ? <audio src={preview} controls aria-label={trackNames[track]}/> : <video src={preview} controls playsInline aria-label={trackNames[track]} onError={() => setError('This track could not be decoded. Keep the download and backup folder; interrupted WebM is not guaranteed playable.')}/> : <p>{draft.tracks.length ? 'Loading saved track…' : 'No playable track is available.'}</p>}</div><div className="track-tabs">{draft.tracks.map(item => <button key={item.kind} className={track === item.kind ? 'selected' : ''} onClick={() => setTrack(item.kind)}>{trackNames[item.kind]}</button>)}</div><p className="fineprint">Originals keep their own media tracks. Download the timing manifest to keep start offsets and pauses with your editor handoff.</p><div className="track-list">{draft.tracks.map(item => <div key={item.kind}><div><Icon name={item.kind === 'camera' ? 'camera' : item.kind === 'microphone' || item.kind === 'tab-audio' ? 'mic' : 'screen'}/><strong>{trackNames[item.kind]}</strong><span>{bytes(item.bytes)}</span></div><button className="secondary" disabled={working} onClick={() => { void download(item.kind); }}><Icon name="down" size={16}/> Download WebM</button></div>)}</div><button className="text-button" onClick={() => downloadBlob(new Blob([JSON.stringify(draft,null,2)], {type: 'application/json'}), `${fileTitle(draft.title)} - manifest.json`)}>Download timing manifest</button></div>
    <aside className="review-sidebar"><div className="card"><h2>Make it yours.</h2><label className="field">Title <input value={title} disabled={uploadRunning} maxLength={160} onChange={event => setTitle(event.target.value)} onBlur={() => { void rename(); }} onKeyDown={event => { if (event.key === 'Enter') void rename(); }}/></label><p className="fineprint">Downloads are saved as WebM. Hosting prepares a browser-friendly video separately.</p></div><div className="card hosting-card"><Icon name="cloud" size={26}/><h2>Send a video, not a file.</h2><p>Upload to your private cloud library. Create a share link when you are ready.</p>{uploadProgress && <><div className="upload-label">{phaseLabel[uploadProgress.phase]}<span>{percent}%</span></div><progress value={percent} max={100}/></>}{uploadRunning ? <button className="secondary" onClick={pauseUpload}>Pause upload</button> : <button className="primary" disabled={!canUpload || draft.state !== 'complete'} onClick={() => { void rename().then(saved => { if (saved) onUpload(); }); }}>{uploadPaused ? 'Resume upload' : draft.cloudRecordingId ? 'Retry / check cloud upload' : 'Upload to private library'}<Icon name="arrow" size={16}/></button>}{!canUpload && <p className="fineprint">{uploadReason}</p>}<p className="fineprint">A network failure keeps this local copy. Cloud raw originals are retained for 7 days; keep your downloads for longer.</p></div><button className="text-button danger" disabled={uploadRunning} onClick={remove}>Delete local draft</button></aside></div>
  </section>;
}
export function DraftList({ drafts, open, newRecording }: {drafts: DraftManifest[]; open: (draft: DraftManifest) => void; newRecording: () => void}) {
  return <section><div className="page-heading"><div><span className="eyebrow">ON THIS BROWSER</span><h1>Local drafts</h1><p>Your recordings, ready to review and download.</p></div><button className="primary" onClick={newRecording}><Icon name="record" size={17}/> New recording</button></div><Notice>These files belong to this browser profile. Clearing site data can remove them. Download originals or choose a backup folder before recording important work.</Notice>{drafts.length ? <div className="recording-grid">{drafts.map(draft => <button className="recording-card" key={draft.id} onClick={() => open(draft)}><div className="recording-poster"><Icon name={draft.mode === 'camera' ? 'camera' : 'screen'} size={40}/><span>{time(draft.durationMs)}</span></div><div className="recording-info"><span className={`state-tag ${draft.state}`}>{draft.state}</span><h2>{draft.title}</h2><p>{new Date(draft.createdAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})} · {draft.tracks.length} tracks</p></div></button>)}</div> : <div className="empty-state"><Icon name="grid" size={42}/><h2>Your first recording starts here.</h2><p>Record a walkthrough, then find the composed video<br/> and separate originals in this space.</p><button className="primary" onClick={newRecording}>Record a video<Icon name="arrow" size={16}/></button></div>}</section>;
}
