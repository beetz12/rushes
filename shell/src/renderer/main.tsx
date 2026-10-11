import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  formatDuration,
  defaultOptions,
  countdownChoices,
  countdownFromSelection,
  type RecordingOptions,
} from '../shared/contracts';
import {
  CircleDot,
  Monitor,
  Camera,
  Mic,
  Grid2x2,
  Settings as SettingsGlyph,
  Pause,
  Play,
  Square,
  RotateCw,
  Trash2,
  Link2,
  Download,
  ChevronRight,
  Check,
  FolderOpen,
  SquarePen,
  type LucideIcon,
} from 'lucide-react';
import { normalizedPointer } from '../shared/geometry';
import {
  ProductionSettings,
  TeleprompterOverlay,
  DrawingOverlay,
  DrawingTools,
  RecordingJobs,
} from './extras';
import './style.css';
document.documentElement.dataset.view = location.hash.slice(1) || 'recorder';
const api = window.rushes;
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const icons: Record<string, LucideIcon> = {
    record: CircleDot,
    screen: Monitor,
    camera: Camera,
    mic: Mic,
    library: Grid2x2,
    settings: SettingsGlyph,
    pause: Pause,
    play: Play,
    stop: Square,
    refresh: RotateCw,
    trash: Trash2,
    link: Link2,
    download: Download,
    arrow: ChevronRight,
    check: Check,
    folder: FolderOpen,
    edit: SquarePen,
  };
  const Glyph = icons[name] ?? CircleDot;
  return <Glyph size={size} strokeWidth={1.7} aria-hidden="true" />;
}
function App() {
  const view = location.hash.slice(1) || 'recorder';
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<RecordingOptions>(defaultOptions);
  const [status, setStatus] = useState<any>({ state: 'idle' });
  const [targets, setTargets] = useState<any>({
    displays: [],
    windows: [],
    cameras: [],
    microphones: [],
  });
  const [permissions, setPermissions] = useState<any>({});
  const [preview, setPreview] = useState('');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [presets, setPresets] = useState<Record<string, RecordingOptions>>({}),
    [presetName, setPresetName] = useState('');
  const [micMuted, setMicMuted] = useState(false),
    [systemMuted, setSystemMuted] = useState(false);
  const run = useCallback(async (fn: () => Promise<any>) => {
    setError('');
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      setError(String(e).replace(/^Error: /, ''));
    } finally {
      setBusy(false);
    }
  }, []);
  const refresh = useCallback(async () => {
    try {
      const p = await api.request('permissions.check');
      setPermissions(p);
      if (p.screen === 'granted') setTargets(await api.request('targets'));
    } catch (e) {
      setError(String(e));
    }
    try {
      setStatus(await api.request('status'));
    } catch {
      setStatus({ state: 'offline' });
    }
  }, []);
  useEffect(() => {
    if (!api) {
      setError('Open Rushes in the desktop app to connect to the native recording engine.');
      return;
    }
    api.bootstrap().then((v) => setOptions(v.options));
    void api.presets('list').then(setPresets);
    void refresh();
    const off = api.onEvent((e) => {
      if (e.event === 'error') setError(String(e.message ?? 'Native engine error'));
      if (e.event === 'warning') setNote(String(e.message ?? e.code));
      if (e.event === 'engine-ready') void refresh();
      if (e.event === 'camera-preview-cleared') setPreview('');
      if (e.event === 'camera-preview') {
        const data = (e.result ?? e) as any;
        if (data.jpeg) setPreview(`data:image/jpeg;base64,${data.jpeg}`);
      }
      if (e.event === 'state-changed' && e.state)
        setStatus((previous: any) => ({ ...previous, state: e.state }));
      if (e.event === 'recording-started') {
        setStatus({
          state: 'recording',
          recording: { recordingID: e.recordingId, elapsedMediaNs: 0 },
        });
        setCountdown(null);
      }
      if (e.event === 'recording-stopped') {
        setStatus({ state: 'idle' });
        setCountdown(null);
      }
      if (e.event === 'countdown')
        setCountdown(Number((e.result as any)?.remaining ?? e.remaining));
      if (e.event === 'window-anchor')
        setOptions((previous) => ({
          ...previous,
          [e.view === 'bubble' ? 'bubbleAnchor' : 'barAnchor']: e.anchor,
        }));
      if (e.event === 'area-selected') {
        setOptions((o) => ({ ...o, mode: 'area', area: e.area as any }));
        setNote('Area selected. Ready to record.');
      }
    });
    const timer = setInterval(
      () =>
        api
          .request('status')
          .then(setStatus)
          .catch(() => {}),
      1000,
    );
    return () => {
      off();
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (options.camera === 'none' || !api || view !== 'recorder') return;
    void api
      .request('camera.preview.start', { camera: options.camera })
      .catch((e) => setError(String(e)));
    return () => {
      void api.request('camera.preview.stop').catch(() => {});
    };
  }, [options.camera, view]);
  const updateOptions = (change: Partial<RecordingOptions>) => {
    const next = { ...options, ...change };
    setOptions(next);
    void api.saveOptions(next).catch((e) => setError(String(e)));
  };
  const start = () =>
    run(async () => {
      await api.saveOptions(options);
      const args: any = {
        camera: options.camera,
        mic: options.mic,
        systemAudio: options.systemAudio,
        countdownSeconds: options.countdownSeconds,
        cursor: options.cursor ?? 'baked',
      };
      if (options.mode === 'window') args.window = options.source;
      else args.display = options.source;
      if (options.mode === 'area') {
        if (!options.area) throw new Error('Select a recording area first.');
        args.area = options.area;
      }
      setCountdown(options.countdownSeconds ? 0 : null);
      try {
        const r = await api.request('record.start', args);
        setStatus({ state: r.state, recording: { recordingID: r.id, elapsedMediaNs: 0 } });
        setCountdown(null);
        return r;
      } finally {
        setCountdown(null);
      }
    });
  const control = (cmd: string, args: any = {}) =>
    run(async () => {
      const r = await api.request(cmd, args);
      await refresh();
      return r;
    });
  useEffect(() => {
    if (!api || view !== 'recorder') return;
    const off = api.onEvent((e) => {
      if (e.event === 'hotkey-start') void start();
    });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && countdown !== null) void control('record.cancel');
    };
    window.addEventListener('keydown', key);
    return () => {
      off();
      window.removeEventListener('keydown', key);
    };
  }, [view, options, countdown]);
  const active = ['recording', 'paused', 'preparing'].includes(status.state);
  if (view === 'bubble')
    return (
      <div className="live-bubble" style={{ WebkitAppRegion: 'drag' } as any}>
        {preview ? (
          <img src={preview} alt="Live camera preview" />
        ) : (
          <div className="bubble-wait">Warming camera…</div>
        )}
      </div>
    );
  if (view === 'area') return <AreaSelector />;
  if (view === 'teleprompter') return <TeleprompterOverlay />;
  if (view === 'drawing') return <DrawingOverlay />;
  if (view === 'drawing-tools') return <DrawingTools run={run} error={error} />;
  if (view === 'bar')
    return (
      <div className="floating-bar">
        <span className="record-dot" />
        <strong>{formatDuration((status.recording?.elapsedMediaNs ?? 0) / 1e6)}</strong>
        <span className="bar-state">{status.state === 'paused' ? 'Paused' : 'Recording'}</span>
        <button
          title={status.state === 'paused' ? 'Resume' : 'Pause'}
          onClick={() => control(status.state === 'paused' ? 'record.resume' : 'record.pause')}
        >
          <Icon name={status.state === 'paused' ? 'play' : 'pause'} />
        </button>
        <button
          title="Restart recording"
          onClick={() =>
            run(async () => {
              if (await api.confirm('Start this take over? The current take will be discarded.'))
                await api.request('record.restart');
            })
          }
        >
          <Icon name="refresh" />
        </button>
        <button
          title="Discard recording"
          onClick={() =>
            run(async () => {
              if (await api.confirm('Discard this recording?')) await api.request('record.discard');
            })
          }
        >
          <Icon name="trash" />
        </button>
        <button
          title={micMuted ? 'Unmute microphone' : 'Mute microphone'}
          onClick={() => {
            setMicMuted(!micMuted);
            void control('record.mute', { track: 'microphone', muted: !micMuted });
          }}
        >
          <Icon name="mic" />
          {micMuted && <small>×</small>}
        </button>
        <button
          title={systemMuted ? 'Unmute system audio' : 'Mute system audio'}
          onClick={() => {
            setSystemMuted(!systemMuted);
            void control('record.mute', { track: 'systemAudio', muted: !systemMuted });
          }}
        >
          <Icon name="screen" />
          {systemMuted && <small>×</small>}
        </button>
        <button title="Voice teleprompter" onClick={() => run(() => api.window('teleprompter'))}>
          Aa
        </button>
        <button title="Draw on this recording" onClick={() => run(() => api.window('drawing'))}>
          <Icon name="edit" />
        </button>
        <button className="stop-btn" onClick={() => control('record.stop')}>
          <Icon name="stop" />
          Stop
        </button>
        {(error || note) && (
          <span className="bar-error" title={error || note}>
            !
          </span>
        )}
      </div>
    );
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">r</div>
          <span>
            rushes<span className="brand-period">.</span>
          </span>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <button
          className={view === 'recorder' ? 'nav active' : 'nav'}
          onClick={() => api.window('recorder')}
        >
          <Icon name="record" />
          Record a video
        </button>
        <button
          className={view === 'library' ? 'nav active' : 'nav'}
          onClick={() => api.window('library')}
        >
          <Icon name="library" />
          My recordings
        </button>
        <button
          className={view === 'settings' ? 'nav active' : 'nav'}
          onClick={() => api.window('settings')}
        >
          <Icon name="settings" />
          Settings
        </button>
        <div className="sidebar-bottom">
          <span className="local-dot" />
          Stored on your Mac<small>Your recordings. Your files.</small>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <span>
            {view === 'library'
              ? 'My recordings'
              : view === 'settings'
                ? 'Settings'
                : 'Recording studio'}
          </span>
          <span className={`status-pill ${status.state === 'offline' ? 'offline' : ''}`}>
            <i />
            {status.state === 'offline'
              ? 'Engine unavailable'
              : active
                ? 'Recording in progress'
                : 'Native recording engine'}
          </span>
        </header>
        <div className="page">
          {error && (
            <div className="alert error" role="alert">
              {error}
              <button onClick={() => setError('')}>×</button>
            </div>
          )}
          {note && (
            <div className="alert" role="status">
              {note}
              <button onClick={() => setNote('')}>×</button>
            </div>
          )}
          {view === 'recorder' ? (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">MAKE SOMETHING CLEAR</p>
                  <h1>A little video goes a long way.</h1>
                  <p className="subtitle">
                    Record your screen with an optional camera. Keep every track.
                  </p>
                </div>
                <button
                  className="icon-button"
                  title="Refresh devices"
                  onClick={() => run(refresh)}
                >
                  <Icon name="refresh" />
                </button>
              </div>
              {permissions.screen !== 'granted' && (
                <PermissionPanel permissions={permissions} refresh={refresh} run={run} />
              )}
              <div className="presets-row">
                <select
                  aria-label="Saved recording preset"
                  defaultValue=""
                  onChange={(e) => {
                    if (presets[e.target.value]) {
                      setOptions(presets[e.target.value]);
                      void api.saveOptions(presets[e.target.value]);
                    }
                  }}
                >
                  <option value="">Choose a saved preset</option>
                  {Object.keys(presets).map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Preset name"
                  placeholder="Name this setup…"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                />
                <button
                  className="secondary"
                  disabled={!presetName.trim()}
                  onClick={() =>
                    run(async () => {
                      setPresets(await api.presets('save', presetName, options));
                      setPresetName('');
                      setNote('Recording preset saved.');
                    })
                  }
                >
                  Save preset
                </button>
              </div>
              <div className="studio-card">
                <div className="source-tabs">
                  {[
                    ['display', 'Entire screen'],
                    ['window', 'A window'],
                    ['area', 'Select area'],
                  ].map(([mode, label]) => (
                    <button
                      key={mode}
                      className={options.mode === mode ? 'selected' : ''}
                      onClick={() =>
                        updateOptions({
                          mode: mode as any,
                          source:
                            mode === 'window'
                              ? (targets.windows[0]?.id ?? '')
                              : (targets.displays.find((d: any) => d.isMain)?.id ?? 'main'),
                        })
                      }
                    >
                      <Icon name="screen" size={18} />
                      {label}
                    </button>
                  ))}
                </div>
                <div className="studio-preview">
                  <div className="screen-symbol">
                    <Icon name="screen" size={50} />
                  </div>
                  <h2>
                    {options.mode === 'window'
                      ? 'Choose a window'
                      : options.mode === 'area'
                        ? 'A focused frame'
                        : 'Your screen, clearly'}
                  </h2>
                  <p>
                    {options.mode === 'area'
                      ? options.area
                        ? `${Math.round(options.area.width)} × ${Math.round(options.area.height)} pt selected`
                        : 'Drag a rectangle around what matters.'
                      : 'Screen and camera are captured as separate tracks.'}
                  </p>
                  {options.mode === 'area' ? (
                    <button className="secondary" onClick={() => api.window('area')}>
                      Select recording area
                    </button>
                  ) : (
                    <select
                      aria-label="Recording source"
                      value={options.source}
                      onChange={(e) => updateOptions({ source: e.target.value })}
                    >
                      {options.mode === 'display' ? (
                        <>
                          <option value="main">Main display</option>
                          {targets.displays.map((d: any) => (
                            <option key={d.id} value={d.id}>
                              {d.name} · {d.widthPoints} × {d.heightPoints}
                            </option>
                          ))}
                        </>
                      ) : (
                        targets.windows.map((w: any) => (
                          <option key={w.id} value={w.id}>
                            {w.title || w.owningApplication || w.id}
                          </option>
                        ))
                      )}
                    </select>
                  )}
                  {options.camera !== 'none' && (
                    <div className="preview-camera">
                      {preview ? (
                        <img src={preview} alt="Live camera" />
                      ) : (
                        <Icon name="camera" size={36} />
                      )}
                    </div>
                  )}
                </div>
                <div className="capture-options">
                  <label>
                    <span>
                      <Icon name="camera" />
                      Camera
                    </span>
                    <select
                      value={options.camera}
                      onChange={(e) => {
                        const camera = e.target.value;
                        if (camera !== 'none' && permissions.camera !== 'granted')
                          void run(async () => {
                            await api.request('permissions.request', { permission: 'camera' });
                            await refresh();
                            updateOptions({ camera });
                          });
                        else updateOptions({ camera });
                      }}
                    >
                      <option value="none">Camera off</option>
                      {targets.cameras.map((c: any) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>
                      <Icon name="mic" />
                      Microphone
                    </span>
                    <select
                      value={options.mic}
                      onChange={(e) => {
                        const mic = e.target.value;
                        if (mic !== 'none' && permissions.microphone !== 'granted')
                          void run(async () => {
                            await api.request('permissions.request', { permission: 'microphone' });
                            await refresh();
                            updateOptions({ mic });
                          });
                        else updateOptions({ mic });
                      }}
                    >
                      <option value="none">Microphone off</option>
                      {targets.microphones.map((c: any) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>
                      <Icon name="screen" />
                      System audio
                    </span>
                    <select
                      value={String(options.systemAudio)}
                      onChange={(e) => updateOptions({ systemAudio: e.target.value === 'true' })}
                    >
                      <option value="false">Off</option>
                      <option value="true">On</option>
                    </select>
                  </label>
                </div>
                <div className="record-footer">
                  <label className="countdown-label">
                    Countdown{' '}
                    <select
                      value={options.countdownSeconds}
                      onChange={(e) => {
                        const countdownSeconds = countdownFromSelection(e.target.value);
                        if (countdownSeconds !== undefined) updateOptions({ countdownSeconds });
                      }}
                    >
                      {countdownChoices.map((choice) => (
                        <option key={choice.seconds} value={choice.seconds}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {active ? (
                    <button className="primary" onClick={() => control('record.stop')}>
                      <Icon name="stop" />
                      Stop recording
                    </button>
                  ) : (
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        permissions.screen !== 'granted' ||
                        (options.mode === 'window' && !options.source)
                      }
                      onClick={start}
                    >
                      <span className="white-record" />
                      {busy ? 'Starting…' : 'Start recording'}
                      <span className="keycap">⇧ ⌘ R</span>
                    </button>
                  )}
                </div>
              </div>
              <div className="studio-note">
                <Icon name="check" size={16} />
                Original tracks stay on your Mac. Share only when you choose.
              </div>
              {countdown !== null && (
                <div className="countdown-overlay">
                  <span>{countdown || 'Getting ready'}</span>
                  <button onClick={() => control('record.cancel')}>Cancel · Esc</button>
                </div>
              )}
            </>
          ) : view === 'library' ? (
            <Library run={run} setNote={setNote} />
          ) : (
            <Settings
              permissions={permissions}
              refresh={refresh}
              run={run}
              options={options}
              updateOptions={updateOptions}
            />
          )}
        </div>
      </main>
    </div>
  );
}
function PermissionPanel({ permissions, refresh, run }: any) {
  return (
    <div className="permission-card">
      <div>
        <h3>Let's give Rushes access.</h3>
        <p>macOS asks before your screen or devices can be recorded.</p>
      </div>
      <div className="permission-list">
        {[
          ['microphone', 'Microphone'],
          ['camera', 'Camera'],
          ['screen', 'Screen recording'],
        ].map(([key, label]) => (
          <div key={key}>
            <span>{label}</span>
            <span className="muted">{permissions[key] ?? 'Checking…'}</span>
            {permissions[key] === 'granted' ? (
              <span className="granted">
                <Icon name="check" />
              </span>
            ) : (
              <button
                className="secondary small"
                onClick={() =>
                  run(async () => {
                    await api.request(
                      permissions[key] === 'denied'
                        ? 'permissions.settings'
                        : 'permissions.request',
                      { permission: key },
                    );
                    await refresh();
                  })
                }
              >
                {permissions[key] === 'denied' ? 'Open Settings' : 'Grant access'}
              </button>
            )}
          </div>
        ))}
      </div>
      <button className="text-button" onClick={() => api.window('relaunch')}>
        Relaunch to apply a Screen Recording grant
      </button>
    </div>
  );
}
function AreaSelector() {
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void api.window('cancel-area');
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null),
    [end, setEnd] = useState<{ x: number; y: number } | null>(null),
    [ratio, setRatio] = useState(0);
  const rect =
    start && end
      ? {
          x: Math.min(start.x, end.x),
          y: Math.min(start.y, end.y),
          width: Math.abs(end.x - start.x),
          height: Math.abs(end.y - start.y),
        }
      : null;
  return (
    <div
      className="area-selector"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button,select')) return;
        const point = { x: e.clientX, y: e.clientY };
        setStart(point);
        setEnd(point);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!start || !e.buttons) return;
        const x = e.clientX;
        const y = ratio
          ? start.y + (Math.sign(e.clientY - start.y || 1) * Math.abs(x - start.x)) / ratio
          : e.clientY;
        setEnd({ x, y: Math.min(window.innerHeight, Math.max(0, y)) });
      }}
      onPointerUp={() => {}}
    >
      <div className="area-help">
        <button onClick={() => api.window('cancel-area')}>Cancel · Esc</button>
        Drag to select an area.{' '}
        <select
          aria-label="Area aspect ratio"
          value={ratio}
          onChange={(e) => setRatio(Number(e.target.value))}
        >
          <option value="0">Freeform</option>
          <option value={16 / 9}>16:9</option>
          <option value={4 / 3}>4:3</option>
          <option value="1">Square</option>
        </select>
        {rect && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (rect.width > 1 && rect.height > 1) void api.selectArea(rect);
            }}
          >
            Use this area · {Math.round(rect.width)} × {Math.round(rect.height)}
          </button>
        )}
      </div>
      {rect && (
        <div
          className="area-rect"
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        />
      )}
    </div>
  );
}
function Library({ run, setNote }: any) {
  const [rows, setRows] = useState<any[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [filter, setFilter] = useState(''),
    [undo, setUndo] = useState<{ token: string; expires: number } | null>(null);
  const querySequence = useRef(0);
  const reload = useCallback(async () => {
    const sequence = ++querySequence.current;
    const result = await api.request('list', { limit: 500, query: filter });
    if (sequence === querySequence.current) setRows(result.recordings);
  }, [filter]);
  useEffect(() => {
    const timer = setTimeout(() => void run(reload), 200);
    return () => {
      clearTimeout(timer);
      ++querySequence.current;
    };
  }, [reload]);
  useEffect(
    () =>
      api.onEvent((e) => {
        if (e.event === 'recording-stopped') void reload();
        if (e.event === 'open-recording') setSelected(String(e.id));
      }),
    [reload],
  );
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), Math.max(0, undo.expires - Date.now()));
    return () => clearTimeout(timer);
  }, [undo]);
  const trashed = (result: any) => {
    setUndo({ token: result.undoToken, expires: Date.now() + result.undoWindowMs });
    setSelected(null);
    void reload();
  };
  const trash = (id: string) =>
    run(async () => {
      if (await api.confirm('Move this recording and all its original tracks to macOS Trash?'))
        trashed(await api.request('library.trash', { id }));
    });
  if (selected)
    return (
      <Review
        id={selected}
        back={() => {
          setSelected(null);
          void reload();
        }}
        run={run}
        setNote={setNote}
        trashed={trashed}
      />
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR VIDEO WORKSPACE</p>
          <h1>Every take, ready when you are.</h1>
          <p className="subtitle">Review, refine, and share. Originals are always kept.</p>
        </div>
        <button className="primary" onClick={() => api.window('recorder')}>
          <Icon name="record" />
          New recording
        </button>
      </div>
      {undo && (
        <div className="alert undo-toast" role="status">
          Moved to macOS Trash.{' '}
          <button
            className="text-button"
            onClick={() =>
              run(async () => {
                await api.request('library.undoTrash', { token: undo.token });
                setUndo(null);
                await reload();
              })
            }
          >
            Undo
          </button>
        </div>
      )}
      <div className="library-toolbar">
        <span>
          {rows.length} recording{rows.length === 1 ? '' : 's'}
        </span>
        <input
          aria-label="Search recordings"
          placeholder="Search titles and spoken words…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className="icon-button"
          title="Refresh recordings"
          onClick={() =>
            run(async () => {
              await api.request('library.refresh');
              await reload();
            })
          }
        >
          <Icon name="refresh" />
        </button>
      </div>
      {!rows.length ? (
        <div className="empty-state">
          <div className="empty-icon">
            <Icon name="library" size={36} />
          </div>
          <h2>{filter ? 'No matching recordings.' : 'Your first take starts here.'}</h2>
          <p>
            {filter
              ? 'Try another title or spoken phrase.'
              : 'Record something and it will appear here, ready to play and edit.'}
          </p>
          <button className="primary" onClick={() => api.window('recorder')}>
            Record your first video
          </button>
        </div>
      ) : (
        <div className="recording-grid">
          {rows.map((r) => (
            <article className="recording-card" key={r.id}>
              <button className="recording-open" onClick={() => setSelected(r.id)}>
                <div className="recording-poster">
                  <Icon name="play" size={38} />
                  <span className="duration-badge">{formatDuration(r.durationMs ?? 0)}</span>
                </div>
                <div className="recording-info">
                  <strong>{r.title || 'Untitled recording'}</strong>
                  <span>
                    {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : r.id}
                    <i>·</i>
                    {r.status}
                  </span>
                </div>
              </button>
              <button
                className="recording-trash"
                aria-label={`Move ${r.title || 'recording'} to Trash`}
                onClick={() => trash(r.id)}
              >
                <Icon name="trash" size={17} />
              </button>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
function Review({ id, back, run, setNote, trashed }: any) {
  const [recording, setRecording] = useState<any>(null),
    [edit, setEdit] = useState<any>(null),
    [urls, setUrls] = useState<Record<string, string>>({}),
    [title, setTitle] = useState(''),
    [start, setStart] = useState(0),
    [end, setEnd] = useState(0),
    [layout, setLayout] = useState('bubble'),
    [bubbleSize, setBubbleSize] = useState(0.22),
    [bubbleCenter, setBubbleCenter] = useState([0.88, 0.82]),
    [bubbleVisible, setBubbleVisible] = useState(true),
    [bubbleShape, setBubbleShape] = useState('circle'),
    [frames, setFrames] = useState<any>(null),
    [burnIn, setBurnIn] = useState(false),
    [metadata, setMetadata] = useState<any>(null),
    [mirror, setMirror] = useState(true),
    [micGain, setMicGain] = useState(1),
    [systemGain, setSystemGain] = useState(0.5),
    [preset, setPreset] = useState('share'),
    [transcript, setTranscript] = useState<any>(null),
    [tab, setTab] = useState('edit'),
    [selectedWords, setSelectedWords] = useState<string[]>([]),
    [downloadModel, setDownloadModel] = useState(false),
    [currentTime, setCurrentTime] = useState(0),
    [speed, setSpeed] = useState(1),
    [playing, setPlaying] = useState(false),
    [link, setLink] = useState(''),
    [shareStage, setShareStage] = useState(''),
    [sharePercent, setSharePercent] = useState(0),
    [exportBusy, setExportBusy] = useState(false),
    [renderedPreview, setRenderedPreview] = useState<{ url: string; durationMs: number } | null>(
      null,
    ),
    [previewLoading, setPreviewLoading] = useState(false);
  const screenRef = useRef<HTMLVideoElement>(null),
    cameraRef = useRef<HTMLVideoElement>(null),
    micRef = useRef<HTMLAudioElement>(null),
    systemRef = useRef<HTMLAudioElement>(null);
  const duration = (recording?.manifest?.clock?.durationNs ?? 0) / 1e6;
  const videoTrack =
    recording?.manifest?.tracks?.find((t: any) => t.role === 'screen') ??
    recording?.manifest?.tracks?.find((t: any) => t.role === 'camera');
  const canvasAspect =
    videoTrack?.width && videoTrack?.height ? videoTrack.width / videoTrack.height : 16 / 9;
  useEffect(
    () =>
      api.onEvent((event) => {
        if (event.event !== 'share-progress' || event.id !== id) return;
        setShareStage(String(event.state ?? 'uploading'));
        if (typeof event.url === 'string') setLink(event.url);
        if (typeof event.bytes === 'number' && typeof event.total === 'number' && event.total > 0)
          setSharePercent(Math.round((event.bytes / event.total) * 100));
        if (event.state === 'failed')
          setNote(String(event.message ?? 'Sharing failed. Your local recording is kept.'));
      }),
    [id],
  );
  const reload = useCallback(async () => {
    const show = await api.request('show', { id });
    setRecording(show);
    setTitle(show.manifest.title ?? 'Untitled recording');
    const next: Record<string, string> = {};
    for (const track of show.tracks.filter((t: any) => t.present))
      try {
        next[track.role] = await api.media(track.path);
      } catch {}
    setUrls(next);
    setEnd((show.manifest.clock?.durationNs ?? 0) / 1e9);
    try {
      const document = await api.request('edit.get', { id });
      setEdit(document);
      setLayout(document.layout?.preset ?? 'bubble');
      setBubbleSize(document.layout?.bubble?.size ?? 0.22);
      setMirror(document.layout?.bubble?.mirror ?? true);
      setBubbleCenter(document.layout?.bubble?.center ?? [0.88, 0.82]);
      setBubbleVisible(document.layout?.bubble?.visible ?? true);
      setBubbleShape(document.layout?.bubble?.shape ?? 'circle');
      setBurnIn(document.captions?.burnIn ?? false);
      setMicGain(document.audio?.micGain ?? 1);
      setSystemGain(document.audio?.systemGain ?? 0.5);
      if (document.clips?.length) {
        setStart(document.clips[0].sourceStartMs / 1000);
        setEnd(document.clips.at(-1).sourceEndMs / 1000);
      }
    } catch {}
    try {
      setTranscript(await api.request('transcript.get', { id }));
    } catch {}
    try {
      setMetadata(await api.request('meta.get', { id }));
    } catch {}
  }, [id]);
  useEffect(() => {
    void run(reload);
  }, [reload]);
  useEffect(() => {
    if (!edit) return;
    const timer = setTimeout(() => {
      const previewLayout = {
        ...edit.layout,
        preset: layout,
        bubble: {
          ...edit.layout.bubble,
          center: bubbleCenter,
          size: bubbleSize,
          visible: bubbleVisible,
          shape: bubbleShape,
          mirror,
        },
      };
      void api
        .request('layout.frames', { id, layout: previewLayout, canvasAspect })
        .then(setFrames)
        .catch(() => {});
    }, 80);
    return () => clearTimeout(timer);
  }, [
    edit,
    layout,
    bubbleSize,
    bubbleCenter,
    bubbleVisible,
    bubbleShape,
    mirror,
    id,
    canvasAspect,
  ]);
  useEffect(() => {
    if (micRef.current) micRef.current.volume = Math.min(1, micGain);
    if (systemRef.current) systemRef.current.volume = Math.min(1, systemGain);
  }, [micGain, systemGain, urls]);
  const seek = (t: number) => {
    const refs = [screenRef.current, cameraRef.current, micRef.current, systemRef.current];
    refs.forEach((el) => {
      if (el) el.currentTime = t;
    });
    setCurrentTime(t);
  };
  const togglePlay = () => {
    const primary = screenRef.current ?? cameraRef.current;
    const refs = [screenRef.current, cameraRef.current, micRef.current, systemRef.current].filter(
      Boolean,
    ) as HTMLMediaElement[];
    if (!primary) return;
    if (!primary.paused) {
      refs.forEach((el) => el.pause());
      setPlaying(false);
    } else {
      refs.forEach((el) => {
        el.currentTime = primary.currentTime;
        el.playbackRate = speed;
        void el.play().catch(() => {});
      });
      setPlaying(true);
    }
  };
  const save = () =>
    run(async () => {
      await api.request('edit.set', {
        id,
        layout,
        bubbleSize,
        bubbleX: bubbleCenter[0],
        bubbleY: bubbleCenter[1],
        bubbleVisible,
        shape: bubbleShape,
        mirror,
        micGain,
        systemGain,
        title,
        burnIn,
      });
      await api.request('meta.set', { id, title });
      await api.request('edit.save', { id });
      setEdit(await api.request('edit.get', { id }));
      setNote('Edits saved. Original tracks are kept.');
    });
  const applyTrim = () =>
    run(async () => {
      if (!edit) throw new Error('Open an edit document first.');
      const cuts = [
        { sourceStartMs: 0, sourceEndMs: Math.round(start * 1000), reason: 'trim', wordIds: [] },
        {
          sourceStartMs: Math.round(end * 1000),
          sourceEndMs: duration,
          reason: 'trim',
          wordIds: [],
        },
      ].filter((c) => c.sourceEndMs > c.sourceStartMs);
      if (!cuts.length) return;
      setEdit(await api.request('edit.cut', { id, cuts }));
    });
  const fullEdit = async (next: any) => {
    const valid = next.clips.map((clip: any) => clip.id);
    const document = {
      ...next,
      zoomCues: (next.zoomCues ?? []).filter((cue: any) => valid.includes(cue.clipId)),
    };
    setEdit(await api.request('edit.set', { id, edit: document }));
  };
  const split = () =>
    run(async () => {
      if (renderedPreview)
        throw new Error('Switch to original tracks before splitting a source clip.');
      if (!edit) throw new Error('Open an edit document first.');
      const atMs = currentTime * 1000,
        clip = edit.clips.find((c: any) => c.sourceStartMs < atMs && c.sourceEndMs > atMs);
      if (!clip) throw new Error('Place the playhead inside a clip to split it.');
      setEdit(await api.request('edit.split', { id, clipId: clip.id, atMs }));
    });
  const wordCut = () =>
    run(async () => {
      if (!selectedWords.length) throw new Error('Select transcript words to remove.');
      const cuts = await api.request('transcript.edit-plan', { id, wordIds: selectedWords });
      setEdit(await api.request('edit.cut', { id, cuts }));
      setSelectedWords([]);
      setNote('Selected words removed from the edit. Your transcript and originals are kept.');
    });
  const automatedCut = (type: string) =>
    run(async () => {
      const cuts = await api.request('transcript.edit-plan', {
        id,
        removeFillers: type === 'fillers',
        removeSilence: type === 'silence',
        wordIds: [],
      });
      setEdit(await api.request('edit.cut', { id, cuts }));
      setNote(`${cuts.length} suggested cuts applied.`);
    });
  const doExport = () =>
    run(async () => {
      setExportBusy(true);
      try {
        await api.request('edit.set', {
          id,
          layout,
          bubbleSize,
          bubbleX: bubbleCenter[0],
          bubbleY: bubbleCenter[1],
          bubbleVisible,
          shape: bubbleShape,
          mirror,
          micGain,
          systemGain,
          title,
          burnIn,
        });
        await api.request('edit.save', { id });
        const r = await api.exportFile(id, preset, Math.round(currentTime * 1000));
        if (!r.canceled) {
          setNote(`Export saved: ${r.path}`);
          await api.reveal(r.path);
        }
      } finally {
        setExportBusy(false);
      }
    });
  if (!recording) return <div className="empty-state">Loading recording…</div>;
  return (
    <>
      <div className="review-heading">
        <button className="back-button" onClick={back}>
          ← All recordings
        </button>
        <div className="review-actions">
          <button
            className="secondary"
            title="Move recording to macOS Trash"
            onClick={() =>
              run(async () => {
                if (
                  await api.confirm('Move this recording and its original tracks to macOS Trash?')
                )
                  trashed(await api.request('library.trash', { id }));
              })
            }
          >
            <Icon name="trash" />
            Trash
          </button>
          <button
            className="secondary"
            onClick={() =>
              run(async () => {
                const report = await api.request('verify', { id });
                setNote(
                  report.ok
                    ? `Verified ${report.trackChecks.filter((t: any) => !t.skipped).length} tracks. Media decodes and timing checks pass.`
                    : `Verification found issues: ${report.issues.join('; ')}`,
                );
              })
            }
          >
            <Icon name="check" size={16} />
            Verify tracks
          </button>
          <button
            className="secondary"
            onClick={() =>
              run(async () => {
                const first = recording.tracks.find((t: any) => t.present);
                if (first) await api.reveal(first.path);
              })
            }
          >
            <Icon name="folder" size={16} />
            Show in Finder
          </button>
        </div>
      </div>
      <input
        className="title-input"
        aria-label="Recording title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => void save()}
      />
      <p className="recording-meta">
        {formatDuration(duration)} · {recording.tracks.filter((t: any) => t.present).length}{' '}
        separate tracks · {recording.manifest.status}
      </p>
      {(recording.manifest.warnings ?? []).map((warning: any, index: number) => (
        <div className="alert" key={index}>
          {warning.message ?? warning.code}
        </div>
      ))}
      <div className="review-grid">
        <div className="review-main">
          <div className="player" style={{ aspectRatio: canvasAspect }}>
            {(renderedPreview || (urls.screen && (layout !== 'camera-only' || !urls.camera))) && (
              <video
                ref={screenRef}
                src={renderedPreview?.url ?? urls.screen}
                style={
                  !renderedPreview && frames?.screen
                    ? {
                        position: 'absolute',
                        left: `${frames.screen.x * 100}%`,
                        top: `${frames.screen.y * 100}%`,
                        width: `${frames.screen.width * 100}%`,
                        height: `${frames.screen.height * 100}%`,
                      }
                    : undefined
                }
                preload="metadata"
                onTimeUpdate={(e) => {
                  const t = e.currentTarget.currentTime;
                  setCurrentTime(t);
                  if (playing && !renderedPreview && edit?.clips?.length) {
                    const current = edit.clips.find(
                      (c: any) => t * 1000 >= c.sourceStartMs && t * 1000 < c.sourceEndMs,
                    );
                    if (!current) {
                      const next = edit.clips.find((c: any) => c.sourceStartMs > t * 1000);
                      if (next) {
                        seek(next.sourceStartMs / 1000);
                      } else {
                        [
                          screenRef.current,
                          cameraRef.current,
                          micRef.current,
                          systemRef.current,
                        ].forEach((el) => el?.pause());
                        setPlaying(false);
                      }
                    } else {
                      [
                        screenRef.current,
                        cameraRef.current,
                        micRef.current,
                        systemRef.current,
                      ].forEach((el) => {
                        if (el) el.playbackRate = current.speed * speed;
                      });
                    }
                  }
                  [cameraRef.current, micRef.current, systemRef.current].forEach((el) => {
                    if (el && Math.abs(el.currentTime - t) > 0.12) el.currentTime = t;
                  });
                }}
                onEnded={() => setPlaying(false)}
                onError={() =>
                  setNote(
                    'This master codec may need an MP4 export for playback. Your original recording is preserved.',
                  )
                }
              />
            )}
            {!renderedPreview && urls.camera && layout !== 'screen-only' && bubbleVisible && (
              <video
                ref={cameraRef}
                src={urls.camera}
                muted
                preload="metadata"
                className="review-camera"
                style={{
                  left: `${(frames?.camera?.x ?? bubbleCenter[0] - bubbleSize / 2) * 100}%`,
                  top: `${(frames?.camera?.y ?? bubbleCenter[1] - (bubbleSize * 16) / 9 / 2) * 100}%`,
                  right: 'auto',
                  bottom: 'auto',
                  width: `${(frames?.camera?.width ?? bubbleSize) * 100}%`,
                  height: `${(frames?.camera?.height ?? (bubbleSize * 16) / 9) * 100}%`,
                  borderRadius:
                    frames?.roundCamera === false ? '0' : bubbleShape === 'circle' ? '50%' : '25%',
                  transform: mirror ? 'scaleX(-1)' : undefined,
                }}
                onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
                onPointerMove={(e) => {
                  if (!e.buttons || layout !== 'bubble') return;
                  const center = normalizedPointer(
                    { x: e.clientX, y: e.clientY },
                    e.currentTarget.parentElement?.getBoundingClientRect(),
                  );
                  if (center) setBubbleCenter(center);
                }}
                onTimeUpdate={(e) => {
                  if (!screenRef.current) setCurrentTime(e.currentTarget.currentTime);
                }}
              />
            )}
            {!renderedPreview && urls.mic && <audio ref={micRef} src={urls.mic} />}{' '}
            {!renderedPreview && urls.system && <audio ref={systemRef} src={urls.system} />}
            {!urls.screen && !urls.camera && (
              <div className="audio-preview">
                <Icon name="mic" size={56} />
                <p>Audio recording</p>
                <audio controls src={urls.mic ?? urls.system} />
              </div>
            )}
            {!renderedPreview && burnIn && transcript?.cues && (
              <div className="preview-caption">
                {
                  transcript.cues.find(
                    (cue: any) =>
                      cue.startMs <= currentTime * 1000 && cue.endMs > currentTime * 1000,
                  )?.text
                }
              </div>
            )}
            <button
              className="player-play"
              onClick={togglePlay}
              aria-label={playing ? 'Pause preview' : 'Play preview'}
            >
              <Icon name={playing ? 'pause' : 'play'} size={24} />
            </button>
          </div>
          <div className="preview-mode-controls">
            <span>
              {renderedPreview
                ? 'Final video · native rendered edits'
                : 'Original tracks · edit your composition'}
            </span>
            {renderedPreview ? (
              <button
                className="secondary"
                onClick={() => {
                  [screenRef.current, cameraRef.current, micRef.current, systemRef.current].forEach(
                    (el) => el?.pause(),
                  );
                  setPlaying(false);
                  setRenderedPreview(null);
                  setCurrentTime(0);
                }}
              >
                Original tracks
              </button>
            ) : (
              <button
                className="secondary"
                disabled={previewLoading}
                onClick={() =>
                  run(async () => {
                    setPreviewLoading(true);
                    try {
                      [
                        screenRef.current,
                        cameraRef.current,
                        micRef.current,
                        systemRef.current,
                      ].forEach((el) => el?.pause());
                      setPlaying(false);
                      await api.request('edit.set', {
                        id,
                        layout,
                        bubbleSize,
                        bubbleX: bubbleCenter[0],
                        bubbleY: bubbleCenter[1],
                        bubbleVisible,
                        shape: bubbleShape,
                        mirror,
                        micGain,
                        systemGain,
                        title,
                        burnIn,
                      });
                      await api.request('edit.save', { id });
                      const preview = await api.previewFile(id);
                      setRenderedPreview(preview);
                      setCurrentTime(0);
                    } finally {
                      setPreviewLoading(false);
                    }
                  })
                }
              >
                {previewLoading ? 'Rendering preview…' : 'Preview final video'}
              </button>
            )}
          </div>
          <div className="player-controls">
            <button className="icon-button" onClick={togglePlay} aria-label="Play or pause">
              <Icon name={playing ? 'pause' : 'play'} />
            </button>
            <span>{formatDuration(currentTime * 1000)}</span>
            <input
              aria-label="Playhead"
              type="range"
              min="0"
              max={(renderedPreview?.durationMs ?? duration) / 1000 || 1}
              step=".01"
              value={currentTime}
              onChange={(e) => seek(Number(e.target.value))}
            />
            <span>{formatDuration(renderedPreview?.durationMs ?? duration)}</span>
            <select
              aria-label="Preview speed"
              value={speed}
              onChange={(e) => {
                const rate = Number(e.target.value);
                setSpeed(rate);
                [screenRef.current, cameraRef.current, micRef.current, systemRef.current].forEach(
                  (el) => {
                    if (el) el.playbackRate = rate;
                  },
                );
              }}
            >
              {[0.5, 1, 1.5, 2, 4, 8].map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </div>
          <div className="editor-tabs">
            {['edit', 'transcript', 'clips', 'details'].map((t) => (
              <button className={tab === t ? 'active' : ''} key={t} onClick={() => setTab(t)}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          {tab === 'edit' ? (
            <div className="edit-panel">
              <h3>Keep the good part.</h3>
              <p className="muted">Trim without changing your originals.</p>
              <div className="trim-controls">
                <label>
                  Start{' '}
                  <input
                    type="number"
                    min="0"
                    max={end}
                    step=".1"
                    value={start}
                    onChange={(e) => setStart(Number(e.target.value))}
                  />
                  s
                </label>
                <span>→</span>
                <label>
                  End{' '}
                  <input
                    type="number"
                    min={start}
                    max={duration / 1000}
                    step=".1"
                    value={end}
                    onChange={(e) => setEnd(Number(e.target.value))}
                  />
                  s
                </label>
                <button className="secondary" onClick={applyTrim}>
                  Apply trim
                </button>
              </div>
              <div className="edit-tools">
                <button className="secondary" onClick={split}>
                  <Icon name="edit" size={16} />
                  Split at playhead
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    run(async () => {
                      await api.request('edit.undo', { id });
                      await reload();
                    })
                  }
                >
                  Undo
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    run(async () => {
                      await api.request('edit.redo', { id });
                      await reload();
                    })
                  }
                >
                  Redo
                </button>
                <button
                  className="text-button"
                  onClick={() =>
                    run(async () => {
                      if (
                        await api.confirm(
                          'Discard draft edits and return to your last saved version?',
                        )
                      ) {
                        await api.request('edit.discard', { id });
                        await reload();
                      }
                    })
                  }
                >
                  Discard draft
                </button>
              </div>
            </div>
          ) : tab === 'clips' ? (
            <div className="edit-panel">
              <h3>Your timeline</h3>
              {(edit?.clips ?? []).map((clip: any, index: number) => (
                <div className="clip-row" key={clip.id}>
                  <button onClick={() => seek(clip.sourceStartMs / 1000)}>
                    {index + 1}. {formatDuration(clip.sourceStartMs)} →{' '}
                    {formatDuration(clip.sourceEndMs)}
                  </button>
                  <select
                    aria-label={`Clip ${index + 1} speed`}
                    value={clip.speed}
                    onChange={(e) =>
                      run(() =>
                        fullEdit({
                          ...edit,
                          clips: edit.clips.map((c: any) =>
                            c.id === clip.id ? { ...c, speed: Number(e.target.value) } : c,
                          ),
                        }),
                      )
                    }
                  >
                    {[1, 1.5, 2, 4, 8].map((s) => (
                      <option key={s} value={s}>
                        {s}×
                      </option>
                    ))}
                  </select>
                  <button
                    title="Remove clip from edit"
                    onClick={() =>
                      run(() =>
                        fullEdit({
                          ...edit,
                          clips: edit.clips.filter((c: any) => c.id !== clip.id),
                        }),
                      )
                    }
                  >
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              ))}
            </div>
          ) : tab === 'details' ? (
            <div className="edit-panel">
              <div className="transcript-heading">
                <h3>Video details</h3>
                <button
                  className="secondary"
                  onClick={() =>
                    run(async () => {
                      const generated = await api.request('meta.generate', { id });
                      setMetadata(generated);
                      if (generated.title) setTitle(generated.title);
                    })
                  }
                >
                  Generate on this Mac
                </button>
              </div>
              <p className="muted">
                Create a title, summary, and chapters with Apple's on-device model.
              </p>
              <label className="field">
                Summary
                <textarea
                  value={metadata?.summary ?? ''}
                  onChange={(e) => setMetadata({ ...metadata, summary: e.target.value })}
                />
              </label>
              {(metadata?.chapters ?? []).map((chapter: any, index: number) => (
                <button
                  className="chapter-row"
                  key={index}
                  onClick={() => seek(chapter.startMs / 1000)}
                >
                  {formatDuration(chapter.startMs)} · {chapter.title}
                </button>
              ))}
              <button
                className="secondary"
                onClick={() =>
                  run(async () => {
                    await api.request('meta.set', {
                      id,
                      title,
                      summary: metadata?.summary ?? '',
                      chapters: metadata?.chapters ?? [],
                    });
                    setNote('Video details saved.');
                  })
                }
              >
                Save video details
              </button>
            </div>
          ) : (
            <div className="edit-panel">
              <div className="transcript-heading">
                <h3>Transcript</h3>
                <button
                  className="secondary"
                  onClick={() =>
                    run(async () => {
                      setTranscript(
                        await api.request('transcript.run', {
                          id,
                          allowAssetDownload: downloadModel,
                        }),
                      );
                    })
                  }
                >
                  Transcribe on this Mac
                </button>
              </div>
              {!transcript ? (
                <>
                  <p className="muted">
                    Create a timed transcript from the microphone track. Audio stays on your Mac.
                  </p>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={downloadModel}
                      onChange={(e) => setDownloadModel(e.target.checked)}
                    />
                    Allow Apple to download the local language model if needed
                  </label>
                </>
              ) : (
                <>
                  <div className="transcript-text">
                    {(transcript.words ?? []).map((word: any) => (
                      <button
                        className={selectedWords.includes(word.id) ? 'word selected' : 'word'}
                        key={word.id}
                        title={`${(word.startMs / 1000).toFixed(2)}s · click to select, double-click to seek`}
                        onClick={() =>
                          setSelectedWords((list) =>
                            list.includes(word.id)
                              ? list.filter((w) => w !== word.id)
                              : [...list, word.id],
                          )
                        }
                        onDoubleClick={() => seek(word.startMs / 1000)}
                      >
                        {word.text}
                      </button>
                    ))}
                  </div>
                  <div className="edit-tools">
                    <button className="secondary" onClick={wordCut}>
                      Cut selected words
                    </button>
                    <button className="secondary" onClick={() => automatedCut('fillers')}>
                      Remove fillers
                    </button>
                    <button className="secondary" onClick={() => automatedCut('silence')}>
                      Remove long pauses
                    </button>
                    <button
                      className="secondary"
                      onClick={() => run(() => api.exportFile(id, 'srt'))}
                    >
                      Export SRT
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        <aside className="review-sidebar">
          <RecordingJobs id={id} run={run} />
          <h3>Make it yours.</h3>
          <label className="field">
            Layout
            <select value={layout} onChange={(e) => setLayout(e.target.value)}>
              {[
                ['bubble', 'Camera bubble'],
                ['overlap', 'Overlap'],
                ['side-by-side', 'Side by side'],
                ['presenter', 'Presenter'],
                ['camera-only', 'Camera only'],
                ['screen-only', 'Screen only'],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Camera size
            <input
              aria-label="Camera bubble size"
              type="range"
              min=".12"
              max=".45"
              step=".01"
              value={bubbleSize}
              onChange={(e) => setBubbleSize(Number(e.target.value))}
            />
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={bubbleVisible}
              onChange={(e) => setBubbleVisible(e.target.checked)}
            />
            Show camera
          </label>
          <label className="field">
            Bubble shape
            <select value={bubbleShape} onChange={(e) => setBubbleShape(e.target.value)}>
              <option value="circle">Circle</option>
              <option value="squircle">Rounded square</option>
            </select>
          </label>
          <div className="bubble-corners">
            {[
              [0.15, 0.2],
              [0.85, 0.2],
              [0.15, 0.8],
              [0.85, 0.8],
            ].map((center, index) => (
              <button
                key={index}
                aria-label={`Camera corner ${index + 1}`}
                onClick={() => setBubbleCenter(center)}
              >
                {['↖', '↗', '↙', '↘'][index]}
              </button>
            ))}
          </div>
          <label className="check-label">
            <input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} />
            Mirror camera
          </label>
          <hr />
          <label className="field">
            Microphone volume
            <input
              type="range"
              min="0"
              max="1"
              step=".05"
              value={micGain}
              onChange={(e) => setMicGain(Number(e.target.value))}
            />
          </label>
          <label className="field">
            System audio volume
            <input
              type="range"
              min="0"
              max="1"
              step=".05"
              value={systemGain}
              onChange={(e) => setSystemGain(Number(e.target.value))}
            />
          </label>
          <label className="check-label">
            <input type="checkbox" checked={burnIn} onChange={(e) => setBurnIn(e.target.checked)} />
            Burn captions into export
          </label>
          <button className="secondary full-width" onClick={save}>
            Save edits
          </button>
          <hr />
          <label className="field">
            Export format
            <select value={preset} onChange={(e) => setPreset(e.target.value)}>
              {[
                ['share', 'Share MP4 · 1080p'],
                ['youtube', 'YouTube · 1080p60'],
                ['full', 'Full quality MOV'],
                ['editor-tracks', 'Separate editor tracks'],
                ['audio', 'Audio only · M4A'],
                ['audio-wav', 'Audio only · WAV'],
                ['diagnostics', 'Diagnostics bundle'],
                ['thumbnail', 'YouTube thumbnail'],
                ['vtt', 'WebVTT captions'],
                ['srt', 'SRT captions'],
                ['chapters', 'Chapters text'],
                ['txt', 'Transcript text'],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button className="secondary full-width" disabled={exportBusy} onClick={doExport}>
            <Icon name="download" />
            {exportBusy ? 'Exporting…' : 'Export recording'}
          </button>
          <button
            className="primary full-width"
            onClick={() =>
              run(async () => {
                await api.request('edit.set', {
                  id,
                  layout,
                  bubbleSize,
                  bubbleX: bubbleCenter[0],
                  bubbleY: bubbleCenter[1],
                  bubbleVisible,
                  shape: bubbleShape,
                  mirror,
                  micGain,
                  systemGain,
                  title,
                  burnIn,
                });
                await api.request('edit.save', { id });
                const r = await api.share(id);
                setLink(r.url);
                setShareStage((previous) =>
                  previous === 'ready' ? 'ready' : (r.state ?? 'processing'),
                );
                setNote(
                  r.state === 'ready'
                    ? 'Share link copied. Video is ready.'
                    : 'Share link copied. The video is being prepared.',
                );
              })
            }
          >
            <Icon name="link" />
            Copy share link
          </button>
          {shareStage && (
            <p className="fine-print">
              {shareStage === 'ready'
                ? 'Video is ready.'
                : shareStage === 'failed'
                  ? 'Sharing needs a retry.'
                  : `Preparing video: ${shareStage}${shareStage === 'uploading' ? ` · ${sharePercent}%` : ''}`}
            </p>
          )}
          {link && <input aria-label="Share link" readOnly value={link} />}
          <p className="fine-print">
            Sharing uses your configured bucket or Worker. Setup in Settings.
          </p>
        </aside>
      </div>
    </>
  );
}
function Settings({ permissions, refresh, run, options, updateOptions }: any) {
  const [cloud, setCloud] = useState<any>({ provider: 'none', configured: false }),
    [provider, setProvider] = useState('none'),
    [fields, setFields] = useState<Record<string, string>>({ region: 'auto' }),
    [test, setTest] = useState('');
  useEffect(() => {
    const reload = () =>
      api.cloudSettings().then((v) => {
        setCloud(v);
        setProvider(v.provider);
        setFields((previous) => ({
          ...previous,
          ...(v.workerURL ? { workerURL: v.workerURL } : {}),
          ...(v.publicBaseURL ? { publicBaseURL: v.publicBaseURL } : {}),
        }));
      });
    void reload();
    return api.onEvent((e) => {
      if (e.event === 'share-configured') void reload();
    });
  }, []);
  const field = (key: string, label: string, secret = false) => (
    <label className="field" key={key}>
      {label}
      <input
        type={secret ? 'password' : 'text'}
        autoComplete="off"
        value={fields[key] ?? ''}
        onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR WORKFLOW, YOUR WAY</p>
          <h1>Keep it personal.</h1>
          <p className="subtitle">Native recording. Local files. Sharing you control.</p>
        </div>
      </div>
      <div className="settings-grid">
        <ProductionSettings run={run} />
        <section className="settings-card">
          <h2>Permissions</h2>
          <PermissionPanel permissions={permissions} refresh={refresh} run={run} />
          <h3>Keyboard shortcuts</h3>
          <div className="shortcut-row">
            <span>Open recorder / stop recording</span>
            <kbd>⇧ ⌘ R</kbd>
          </div>
          <div className="shortcut-row">
            <span>Pause / resume</span>
            <kbd>⇧ ⌘ P</kbd>
          </div>
          <div className="shortcut-row">
            <span>Discard with confirmation</span>
            <kbd>⇧ ⌘ Esc</kbd>
          </div>
          <hr />
          <label className="field">
            Live camera bubble size
            <select
              value={options.bubbleSize}
              onChange={(e) => updateOptions({ bubbleSize: Number(e.target.value) })}
            >
              {[160, 200, 280].map((size) => (
                <option value={size} key={size}>
                  {size} pt
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Mouse pointer
            <select
              value={options.cursor ?? 'baked'}
              onChange={(e) => updateOptions({ cursor: e.target.value })}
            >
              <option value="baked">Include in screen track</option>
              <option value="data">Keep screen cursor-free</option>
            </select>
          </label>
          <button className="text-button" onClick={() => api.window('acknowledgements')}>
            About Rushes · Acknowledgements
          </button>
        </section>
        <section className="settings-card">
          <div className="settings-card-header">
            <h2>Share to your cloud</h2>
            <span className={`configured ${cloud.configured ? 'yes' : ''}`}>
              {cloud.configured ? 'Configured' : 'Not configured'}
            </span>
          </div>
          <p className="muted">
            Publish a video when you choose Copy share link. Credentials are encrypted with macOS
            secure storage.
          </p>
          <label className="field">
            Share provider
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="none">Local recording only</option>
              <option value="bucket">S3 / Cloudflare R2 bucket</option>
              <option value="worker">Rushes share Worker</option>
            </select>
          </label>
          {provider === 'bucket' ? (
            <>
              {field('endpoint', 'S3 endpoint')}
              {field('region', 'Region')}
              {field('bucket', 'Bucket name')}
              {field('publicBaseURL', 'Public bucket URL')}
              {field('accessKeyId', 'Access key ID', true)}
              {field('secretAccessKey', 'Secret access key', true)}
            </>
          ) : provider === 'worker' ? (
            <>
              {field('workerURL', 'Worker URL')}
              {field('token', 'Worker authorization token', true)}
            </>
          ) : (
            <div className="local-only">
              <Icon name="folder" />
              <p>Videos are saved on this Mac. Configure a provider when you want share links.</p>
            </div>
          )}
          <div className="edit-tools">
            <button
              className="primary"
              onClick={() =>
                run(async () => {
                  await api.saveCloudSettings({
                    provider,
                    ...(provider === 'none' ? {} : fields),
                  } as any);
                  setCloud(await api.cloudSettings());
                  setFields({ region: 'auto' });
                  setTest('Settings saved securely. Test the connection before sharing.');
                })
              }
            >
              Save settings
            </button>
            <button
              className="secondary"
              disabled={!cloud.configured}
              onClick={() =>
                run(async () => {
                  const result = await api.testCloud();
                  setTest(
                    result.ok ? 'Connection verified. Ready to share.' : 'Connection did not pass.',
                  );
                })
              }
            >
              Test connection
            </button>
          </div>
          {test && <div className="alert">{test}</div>}
        </section>
      </div>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
