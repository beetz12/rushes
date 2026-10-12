import { useEffect, useRef, useState } from 'react';
import { BROWSER_LIMITS } from '../contracts';
import type { BubblePlacement, CaptureMode, CaptureSession, CaptureState, DraftManifest, DraftStore, CreateRecordingInput } from '../contracts';
import { createCaptureSession, captureCapabilities } from '../capture';
import { errorMessage } from '../api';
import { Icon, LiveVideo, Notice, time } from './common';

export function Studio({ store, persistent, backupFolder, storageError, chooseBackup, requestPersistence, onComplete, onBusy, captureAllowed, cloud }: {
  cloud: { available: boolean; reason: string; reserve: (input: CreateRecordingInput) => Promise<string>; checkpoint: (draft: DraftManifest) => void; discard: (id: string, cloudId: string) => void };
  captureAllowed: boolean; store: DraftStore | null; persistent: boolean; backupFolder: boolean; storageError: string;
  chooseBackup: () => Promise<void>; requestPersistence: () => Promise<void>;
  onComplete: (draft: DraftManifest) => void; onBusy: (busy: boolean) => void;
}) {
  const [mode, setMode] = useState<CaptureMode>('screen-camera');
  const [cloudBackup, setCloudBackup] = useState(false);
  const cloudId = useRef<string | null>(null);
  const [title, setTitle] = useState('');
  const [camera, setCamera] = useState<MediaStream>();
  const [microphone, setMicrophone] = useState<MediaStream>();
  const [screen, setScreen] = useState<MediaStream>();
  const [preview, setPreview] = useState<MediaStream>();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [micId, setMicId] = useState('');
  const [level, setLevel] = useState(0);
  const [status, setStatus] = useState<CaptureState | 'setup' | 'countdown'>('setup');
  const [countdown, setCountdown] = useState(3);
  const [remaining, setRemaining] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [working, setWorking] = useState(false);
  const [checkpoint, setCheckpoint] = useState(0);
  const [bubble, setBubble] = useState<BubblePlacement>({x: 1080, y: 510, size: 150});
  const session = useRef<CaptureSession | null>(null);
  const sources = useRef<MediaStream[]>([]);
  const generation = useRef(0);
  const takeId = useRef('');
  const finished = useRef(false);
  const complete = useRef(onComplete); complete.current = onComplete;
  const state = useRef(status); state.current = status;
  const previewBox = useRef<HTMLDivElement>(null);
  const cancelled = useRef<AbortController | null>(null);
  const live = ['countdown', 'recording', 'paused', 'stopping', 'ready'].includes(status);
  const active = ['recording','paused','stopping'].includes(status);
  const capability = captureCapabilities();
  const supported = capability.supported && !!navigator.mediaDevices?.getDisplayMedia;
  function stopSources() { for (const stream of sources.current) for (const track of stream.getTracks()) track.stop(); sources.current = []; setCamera(undefined); setMicrophone(undefined); setScreen(undefined); setPreview(undefined); }
  useEffect(() => { onBusy(live || working); }, [live, working, onBusy]);
  useEffect(() => () => { generation.current++; cancelled.current?.abort(); for (const stream of sources.current) stream.getTracks().forEach(track => track.stop()); if (session.current && ['ready','recording','paused','countdown'].includes(state.current)) void session.current.cancel().catch(() => {}); }, []);
  useEffect(() => {
    if (!microphone) { setLevel(0); return; }
    const context = new AudioContext();
    const source = context.createMediaStreamSource(microphone);
    const analyser = context.createAnalyser(); analyser.fftSize = 256; source.connect(analyser);
    const values = new Float32Array(analyser.fftSize);
    let frame = 0;
    function sample() { analyser.getFloatTimeDomainData(values); const rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length); setLevel(Math.min(1, rms * 8)); frame = requestAnimationFrame(sample); }
    void context.resume().then(sample).catch(() => setWarning('Microphone meter is unavailable. Check your microphone before recording.'));
    return () => { cancelAnimationFrame(frame); source.disconnect(); void context.close(); };
  }, [microphone]);
  useEffect(() => {
    if (status !== 'recording') return;
    const timer = setInterval(() => setDuration(ms => ms + 250), 250);
    return () => clearInterval(timer);
  }, [status]);
  async function enable(kind: 'camera' | 'microphone', id = '') {
    if (live || working) return;
    setError(''); setWorking(true);
    const revision = generation.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(kind === 'camera' ? {video: {deviceId: id ? {exact: id} : undefined, width: {ideal: 1280, max: 1280}, height: {ideal: 720, max: 720}, frameRate: {ideal: 30, max: 30}}, audio: false} : {audio: {deviceId: id ? {exact: id} : undefined}, video: false});
      if (revision !== generation.current) { stream.getTracks().forEach(track => track.stop()); return; }
      const previous = kind === 'camera' ? camera : microphone;
      previous?.getTracks().forEach(track => track.stop());
      sources.current = sources.current.filter(source => source !== previous).concat(stream);
      const selected = stream.getTracks()[0].getSettings().deviceId ?? id;
      if (kind === 'camera') { setCamera(stream); setCameraId(selected); } else { setMicrophone(stream); setMicId(selected); }
      setDevices(await navigator.mediaDevices.enumerateDevices());
      stream.getTracks().forEach(track => track.addEventListener('ended', () => { if (!['recording','paused','stopping'].includes(state.current)) { if (kind === 'camera') setCamera(undefined); else setMicrophone(undefined); setWarning(`${kind === 'camera' ? 'Camera' : 'Microphone'} disconnected. Enable it again or choose another device.`); } }, { once: true }));
    } catch (value) { setError(`${kind === 'camera' ? 'Camera' : 'Microphone'} access: ${errorMessage(value)}. Check the browser site permissions and the operating system privacy settings.`); }
    finally { setWorking(false); }
  }
  function disable(kind: 'camera' | 'microphone') { const stream = kind === 'camera' ? camera : microphone; stream?.getTracks().forEach(track => track.stop()); sources.current = sources.current.filter(item => item !== stream); if (kind === 'camera') setCamera(undefined); else setMicrophone(undefined); }
  async function finishOnce() {
    if (finished.current || !store || !takeId.current) return;
    try { const manifest = await store.load(takeId.current); if (['complete','interrupted','failed'].includes(manifest.state)) { finished.current = true; stopSources(); complete.current(manifest); } }
    catch (value) { setError(errorMessage(value)); }
  }
  function clearReservation(id: string, reserved: string | null) { if (reserved) { cloudId.current = null; cloud.discard(id,reserved); } }
  async function prepare(chosenScreen?: MediaStream, id = crypto.randomUUID(), reserved?: string) {
    const revision = generation.current;
    const abort = new AbortController(); cancelled.current = abort;
    setWorking(true); setError(''); setWarning(''); setDuration(0); setCheckpoint(0); finished.current = false;
    takeId.current = id; cloudId.current = reserved ?? null;
    let encodingAttempted = false;
    try {
      if (!store) throw new Error(storageError || 'Local recording storage is unavailable. Retry this page or choose a backup folder.');
      const next = await createCaptureSession({ id, cloudRecordingId: reserved, title: title.trim() || 'Untitled recording', mode, screen: chosenScreen, camera: mode !== 'screen' ? camera : undefined, microphone, store, persistent, backupFolder, bubble,
        onState: value => { if (abort.signal.aborted || generation.current !== revision) return; setStatus(value); if (['complete','interrupted','failed'].includes(value)) { stopSources(); void finishOnce(); } },
        onWarning: message => { if (!abort.signal.aborted && generation.current === revision) setWarning(message); },
        onCheckpoint: manifest => { if (abort.signal.aborted || generation.current !== revision) return; setCheckpoint(manifest.lastCheckpointMs); setDuration(manifest.durationMs); cloud.checkpoint(manifest); if (['complete','interrupted','failed'].includes(manifest.state) && !finished.current) { finished.current = true; stopSources(); complete.current(manifest); } },
      });
      if (revision !== generation.current || abort.signal.aborted) { await next.cancel(); clearReservation(id,reserved ?? null); return; }
      session.current = next; setPreview(next.preview); setStatus('countdown'); setWorking(false);
      for (let step = countdown; step > 0; step--) {
        setRemaining(step);
        await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { abort.signal.removeEventListener('abort', onAbort); resolve(); }, 1000); function onAbort() { clearTimeout(timer); reject(abort.signal.reason); } abort.signal.addEventListener('abort', onAbort, {once: true}); });
        abort.signal.throwIfAborted();
      }
      setRemaining(0); encodingAttempted = true; await next.start(); setStatus('recording');
    } catch (value) {
      if (finished.current) return;
      if (!abort.signal.aborted) setError(errorMessage(value));
      if (encodingAttempted && !abort.signal.aborted && store) {
        try {
          const retained = await store.load(id);
          if (retained.tracks.some(track => track.bytes > 0)) { finished.current = true; stopSources(); complete.current(retained); return; }
        } catch { setError('Recording startup failed and its local data needs recovery. Saved bytes and the cloud reservation have been retained.'); stopSources(); setStatus('setup'); return; }
      }
      if (session.current) await session.current.cancel().catch(() => {});
      clearReservation(id,cloudId.current); session.current = null; stopSources(); setStatus('setup');
    } finally { setWorking(false); }
  }
  function reserve(id: string) { return cloudBackup ? cloud.reserve({clientId:id,title:title.trim() || 'Untitled recording',mode}) : Promise.resolve(undefined); }
  function chooseScreen() {
    const id = crypto.randomUUID(); takeId.current = id;
    // Reservation begins first, but this same click reaches the picker without an await.
    const reservation = reserve(id); void reservation.catch(() => {});
    const permission = navigator.mediaDevices.getDisplayMedia({ video: {width: {ideal: BROWSER_LIMITS.width, max: BROWSER_LIMITS.width}, height: {ideal: BROWSER_LIMITS.height, max: BROWSER_LIMITS.height}, frameRate: {ideal: BROWSER_LIMITS.fps, max: BROWSER_LIMITS.fps}}, audio: true });
    setError(''); setWorking(true);
    const revision = generation.current;
    let failed = false;
    void permission.then(stream => {
      if (failed || revision !== generation.current) { stream.getTracks().forEach(track => track.stop()); throw new DOMException('Screen selection cancelled','AbortError'); }
      sources.current.push(stream); setScreen(stream); return stream;
    }).then(async stream => { const reserved = await reservation; if (revision !== generation.current) { stream.getTracks().forEach(track => track.stop()); clearReservation(id,reserved ?? null); return; } return prepare(stream,id,reserved); }).catch(value => {
      failed = true; stopSources(); setWorking(false); setStatus('setup');
      void reservation.then(reserved => clearReservation(id,reserved ?? null)).catch(() => {});
      setError(value instanceof DOMException && ['NotAllowedError','AbortError'].includes(value.name) ? 'Screen selection cancelled or denied. Choose screen again when you are ready; nothing was recorded.' : `Recording setup: ${errorMessage(value)}. No encoding started. Check browser permissions and cloud access before retrying.`);
    });
  }
  async function startCamera() {
    const id = crypto.randomUUID(); takeId.current = id; setWorking(true); setError('');
    try { await prepare(undefined,id,await reserve(id)); }
    catch (value) { stopSources(); setWorking(false); setStatus('setup'); setError(`Cloud reservation: ${errorMessage(value)}. Recording did not start.`); }
  }
  async function cancel() { finished.current = true; generation.current++; cancelled.current?.abort(); setWorking(true); try { await session.current?.cancel(); } catch (value) { setError(errorMessage(value)); } finally { clearReservation(takeId.current,cloudId.current); session.current = null; stopSources(); setStatus('setup'); setWorking(false); } }
  async function control(action: 'pause' | 'resume' | 'stop') { setWorking(true); setError(''); try { if (!session.current) return; if (action === 'stop') { setStatus('stopping'); const result = await session.current.stop(); if (!finished.current) { finished.current = true; stopSources(); complete.current(result); } } else { await session.current[action](); setStatus(action === 'pause' ? 'paused' : 'recording'); } } catch (value) { setError(errorMessage(value)); stopSources(); await finishOnce(); setStatus('failed'); } finally { setWorking(false); } }
  function moveBubble(event: React.PointerEvent<HTMLButtonElement>) {
    const box = previewBox.current?.getBoundingClientRect(); if (!box) return;
    const target = event.currentTarget; target.setPointerCapture(event.pointerId);
    const start = {x: event.clientX, y: event.clientY, bubble};
    const move = (pointer: PointerEvent) => { const placement = { ...bubble, x: Math.max(0, Math.min(1280 - bubble.size, start.bubble.x + (pointer.clientX - start.x) * 1280 / box.width)), y: Math.max(0, Math.min(720 - bubble.size, start.bubble.y + (pointer.clientY - start.y) * 720 / box.height)) }; setBubble(placement); session.current?.setBubble(placement); };
    const end = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end); };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
  }
  function adjustBubble(event: React.KeyboardEvent) { const delta = event.shiftKey ? 50 : 10; const movement: Record<string, [number,number]> = {ArrowLeft: [-delta,0], ArrowRight: [delta,0], ArrowUp: [0,-delta], ArrowDown: [0,delta]}; if (!movement[event.key]) return; event.preventDefault(); const [dx,dy] = movement[event.key]; const value = {...bubble, x: Math.max(0, Math.min(1280-bubble.size,bubble.x+dx)), y: Math.max(0,Math.min(720-bubble.size,bubble.y+dy))}; setBubble(value); session.current?.setBubble(value); }
  return <section className="studio">
    <div className="page-heading"><div><span className="eyebrow">YOUR BROWSER STUDIO</span><h1>Show it. Say it. Send it.</h1><p>Record a clear walkthrough, right here in your browser.</p></div><span className="pill"><i/> Local recording</span></div>
    {!supported && <Notice error>{capability.reason ?? 'Recording needs desktop Chrome with screen capture and WebM support.'} You can still review and download saved drafts.</Notice>}
    {!captureAllowed && <Notice>New recordings are paused on this deployment. Your saved drafts can still be reviewed and downloaded.</Notice>}
    {error && <Notice error>{error}</Notice>}{warning && <Notice>{warning}</Notice>}
    <div className="studio-grid">
      <div className="setup-panel">
        <div className="section-label">01 <span>What are we recording?</span></div>
        <div className="mode-options" data-guide="mode">{([['screen-camera','screen','Screen + camera'],['screen','screen','Screen'],['camera','camera','Camera']] as const).map(([value, icon, label]) => <button key={value} disabled={live || working} className={mode === value ? 'selected' : ''} aria-pressed={mode === value} onClick={() => { setMode(value); if (value === 'screen') disable('camera'); }}><Icon name={icon}/><span>{label}</span>{mode === value && <Icon name="check" size={14}/>}</button>)}</div>
        <label className="field">Recording title <input maxLength={160} placeholder="e.g. A quick product walkthrough" value={title} disabled={live} onChange={event => setTitle(event.target.value)}/></label>
        <div className="section-label">02 <span>Your picture and sound</span></div>
        <div className="device-options" data-guide="devices">
          {mode !== 'screen' && <div className="device"><div><Icon name="camera"/><strong>Camera</strong><span className={camera ? 'good' : 'muted'}>{camera ? 'On' : 'Off'}</span></div>{camera ? <><select aria-label="Camera device" value={cameraId} disabled={live || working} onChange={event => { void enable('camera', event.target.value); }}>{devices.filter(item => item.kind === 'videoinput').map(item => <option key={item.deviceId} value={item.deviceId}>{item.label || 'Camera'}</option>)}</select><button className="text-button" disabled={live} onClick={() => disable('camera')}>Turn camera off</button></> : <button className="secondary" disabled={live || working} onClick={() => { void enable('camera'); }}>Enable camera</button>}</div>}
          <div className="device"><div><Icon name="mic"/><strong>Microphone</strong><span className={microphone ? 'good' : 'muted'}>{microphone ? 'On' : 'Off'}</span></div>{microphone ? <><select aria-label="Microphone device" value={micId} disabled={live || working} onChange={event => { void enable('microphone', event.target.value); }}>{devices.filter(item => item.kind === 'audioinput').map(item => <option key={item.deviceId} value={item.deviceId}>{item.label || 'Microphone'}</option>)}</select><div className="meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}><i style={{width: `${level * 100}%`}}/></div><button className="text-button" disabled={live} onClick={() => disable('microphone')}>Turn microphone off</button></> : <button className="secondary" disabled={live || working} onClick={() => { void enable('microphone'); }}>Enable microphone</button>}</div>
        </div>
        <p className="fineprint">Microphone is optional. Tab audio depends on what you select in the browser picker; other app audio may be unavailable.</p>
        <div className="storage-panel" data-guide="protection"><Icon name="lock"/><div><strong>{backupFolder ? 'Backup folder connected' : persistent ? 'Persistent browser storage granted' : 'Saved in this browser'}</strong><p>{storageError || 'Browser storage can be cleared. A backup folder adds another copy of each saved chunk.'}</p><div className="inline-actions"><button disabled={live || working} onClick={() => { void requestPersistence(); }}>Protect browser storage</button><button disabled={live || working || !('showDirectoryPicker' in window)} onClick={() => { void chooseBackup(); }}>Choose backup folder</button></div></div></div>
      </div>
      <div className="preview-panel">
        <div className="preview-heading"><span><i className={active ? 'live-dot' : ''}/>{active ? status === 'paused' ? 'Recording paused' : 'Recording' : 'Preview'}</span><span>{active ? `${time(duration)} / 10:00` : '720p · up to 10 minutes'}</span></div>
        <div className="preview-stage" ref={previewBox} data-guide="preview">
          {preview || screen || (mode === 'camera' && camera) ? <LiveVideo stream={preview ?? screen ?? camera} label="Recording preview"/> : <div className="preview-placeholder"><div className="screen-art"><Icon name="screen" size={50}/><span><Icon name="camera" size={22}/></span></div><h2>Your next great explanation.</h2><p>{mode === 'camera' ? 'Enable your camera to see your preview.' : 'Your chosen screen will appear here.'}</p></div>}
          {mode === 'screen-camera' && camera && <button className="camera-bubble" aria-label="Move camera bubble; use arrow keys or drag" onPointerDown={moveBubble} onKeyDown={adjustBubble} style={{left: `${bubble.x / 1280 * 100}%`, top: `${bubble.y / 720 * 100}%`, width: `${bubble.size / 1280 * 100}%`, aspectRatio: '1'}}>{!preview && <LiveVideo stream={camera} label="Camera preview"/>}<span>Drag to move</span></button>}
          {status === 'countdown' && <div className="countdown-cover"><strong>{remaining || 'Ready'}</strong><span>Recording starts in a moment</span><button onClick={() => { void cancel(); }}>Cancel countdown</button></div>}
        </div>
        <p className="preview-note"><Icon name="camera" size={15}/> The camera bubble appears in your final video. This preview stays on the Rushes page.</p>
        <div className="cloud-backup-choice"><label><input type="checkbox" checked={cloudBackup} disabled={live || working || (!cloud.available && !cloudBackup)} onChange={event => setCloudBackup(event.currentTarget.checked)}/> Back up to private cloud while recording</label><p className="fineprint">{cloud.available ? 'Optional: each saved chunk uploads privately during your take; Stop prepares the composed cloud video. Local recording stays available without this choice.' : cloud.reason}</p></div>
        <div className="record-toolbar" data-guide="start">
          {active ? <><div className="record-time"><i className="live-dot"/>{time(duration)}<small>{checkpoint ? `Saved through ${time(checkpoint)}` : 'Saving first checkpoint…'}</small></div><div className="transport">{status !== 'stopping' && <button className="secondary" disabled={working} onClick={() => { void control(status === 'paused' ? 'resume' : 'pause'); }}><Icon name={status === 'paused' ? 'record' : 'pause'}/>{status === 'paused' ? 'Resume' : 'Pause'}</button>}<button className="primary" disabled={working || status === 'stopping'} onClick={() => { void control('stop'); }}><Icon name="stop"/>{status === 'stopping' ? 'Saving…' : 'Stop & review'}</button></div></> : <><label className="countdown-select">Countdown <select aria-label="Countdown" value={countdown} disabled={live || working} onChange={selection => { const seconds = Number(selection.currentTarget.value); setCountdown(seconds); }}>{[0,3,5].map(seconds => <option key={seconds} value={seconds}>{seconds ? `${seconds} seconds` : 'None'}</option>)}</select></label><button className="primary record-start" disabled={(cloudBackup && !cloud.available) || !captureAllowed || !supported || !store || live || working || (mode !== 'screen' && !camera)} onClick={() => { if (mode === 'camera') void startCamera(); else chooseScreen(); }}><Icon name="record"/>{working ? 'Preparing…' : mode === 'camera' ? 'Start recording' : 'Choose screen & start'}<Icon name="arrow" size={16}/></button></>}
        </div>
        {(active || status === 'countdown') && <button className="discard text-button" disabled={working} onClick={() => { if (status === 'countdown' || confirm('Discard this take? Previously saved recordings will stay.')) void cancel(); }}>Discard this take</button>}
        <div className="capture-facts"><span><Icon name="check" size={16}/> Separate originals</span><span><Icon name="lock" size={16}/> Private until you share</span><span><Icon name="down" size={16}/> Download without an account</span></div>
        {screen && <p className="fineprint">Source: {screen.getVideoTracks()[0]?.label || 'Selected screen'} · {screen.getAudioTracks().length ? 'Display audio is available and included.' : microphone ? 'No display audio. Your microphone is included.' : 'No audio track available. This take is silent.'}</p>}
      </div>
    </div>
  </section>;
}
