import React, { useEffect, useState } from 'react';
import { Camera, Grid2x2, Mic, Monitor, RefreshCw, Settings } from 'lucide-react';
import {
  countdownChoices,
  countdownFromSelection,
  type MicrophoneLevel,
  type RecordingOptions,
  type ScreenPreview,
} from '../shared/contracts';
import type { CaptureIntent } from '../shared/recording-setup';

type Target = { id: string; name?: string; title?: string; owningApplication?: string };
export type CompactRecorderProps = {
  options: RecordingOptions;
  targets: { displays: Target[]; windows: Target[]; cameras: Target[]; microphones: Target[] };
  preview: string;
  screen?: ScreenPreview;
  level?: { value: MicrophoneLevel; receivedAt: number };
  feedbackError: string;
  intent: CaptureIntent;
  readiness: { blockingReason?: string; voiceOff: boolean; tracks: string[] };
  busy: boolean;
  active: boolean;
  recordingState: string;
  countdown: number | null;
  permissions: React.ReactNode;
  selectIntent(value: CaptureIntent): Promise<unknown>;
  chooseMode(value: 'display' | 'window' | 'area'): Promise<unknown>;
  chooseCamera(value: string): Promise<unknown>;
  chooseMicrophone(value: string): void;
  update(value: Partial<RecordingOptions>): Promise<unknown>;
  start(): Promise<unknown>;
  stop(): void;
  cancel(): void;
  selectArea(): void;
  refresh(): void;
  settings(): void;
  guide(): void;
  savedSetups: React.ReactNode;
};

export function CompactHeader({
  review,
  library,
  settings,
  refresh,
}: {
  review: boolean;
  library(): void;
  settings(): void;
  refresh?(): void;
}) {
  return (
    <header className="compact-header">
      <span className="compact-brand">
        <span>r</span> rushes<span className="brand-period">.</span>
      </span>
      <nav aria-label={review ? 'Review navigation' : 'Recorder navigation'}>
        {refresh && (
          <button aria-label="Refresh devices" title="Refresh devices" onClick={refresh}>
            <RefreshCw size={16} />
          </button>
        )}
        <button aria-label="Full view" title="Open the full workspace" onClick={library}>
          <Grid2x2 size={17} /><span>Full view</span>
        </button>
        <button aria-label="Settings" title="Settings" onClick={settings}>
          <Settings size={17} />
        </button>
      </nav>
    </header>
  );
}

function MicrophoneMeter({
  level,
  enabled,
  error,
}: {
  level?: CompactRecorderProps['level'];
  enabled: boolean;
  error: boolean;
}) {
  const [now, setNow] = useState(performance.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 150);
    return () => clearInterval(timer);
  }, []);
  const fresh = !!level && now - level.receivedAt < 700 && level.value.available;
  const value = fresh && level.value.available ? level.value : undefined;
  const fraction = value
    ? Math.max(0, Math.min(1, (20 * Math.log10(Math.max(1e-3, value.rms)) + 60) / 60))
    : 0;
  const text = !enabled
    ? 'Microphone off'
    : value?.clipping
      ? 'Too loud — lower your mic level'
      : !value
        ? error
          ? 'Microphone check unavailable'
          : 'Waiting for microphone…'
        : value.rms < 1e-5
          ? 'Speak to check your microphone'
          : 'Microphone is picking up sound';
  return (
    <div
      className={'mic-meter ' + (value?.clipping ? 'clipping' : '')}
      aria-label="Microphone input level"
    >
      <div
        role="meter"
        aria-label="Microphone signal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuetext={text}
      >
        <span style={{ width: String(fraction * 100) + '%' }} />
      </div>
      <span>{text}</span>
    </div>
  );
}

export function CompactRecorder(p: CompactRecorderProps) {
  const { options: o, targets: t } = p;
  const finishing = p.recordingState === 'finishing';
  const disabled = p.busy || p.active || p.countdown !== null;
  const screenEnabled = o.mode !== 'camera-only';
  const sourceName =
    o.mode === 'area'
      ? o.area
        ? Math.round(o.area.width) + ' × ' + Math.round(o.area.height) + ' pt'
        : 'Choose an area'
      : o.mode === 'window'
        ? t.windows.find((x) => x.id === o.source)?.title || 'Choose a window'
        : t.displays.find((x) => x.id === o.source)?.name || 'Main display';
  return (
    <section className="compact-recorder" aria-label="Recording setup">
      <div
        className="compact-intents"
        role="group"
        aria-label="What to record"
        data-tour="capture-mode"
      >
        {(
          [
            ['screen-camera', 'Screen + camera', <Monitor size={18} key="both" />],
            ['screen', 'Screen only', <Monitor size={18} key="screen" />],
            ['camera', 'Camera only', <Camera size={18} key="camera" />],
          ] as const
        ).map(([value, label, icon]) => (
          <button
            key={value}
            aria-pressed={p.intent === value}
            disabled={disabled}
            className={p.intent === value ? 'selected' : ''}
            onClick={() => void p.selectIntent(value)}
          >
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </div>
      {p.permissions}
      <div className="compact-source-row" data-tour="source">
        {screenEnabled ? (
          <>
            <select
              aria-label="Screen capture area"
              value={o.mode}
              disabled={disabled}
              onChange={(event) =>
                void p.chooseMode(event.target.value as 'display' | 'window' | 'area')
              }
            >
              <option value="display">Full screen</option>
              <option value="window">Window</option>
              <option value="area">Area</option>
            </select>
            {o.mode === 'area' ? (
              <button className="secondary" disabled={disabled} onClick={p.selectArea}>
                {sourceName} <span>⌖</span>
              </button>
            ) : (
              <select
                aria-label="Recording source"
                value={o.source}
                disabled={disabled}
                onChange={(event) => void p.update({ source: event.target.value })}
              >
                {o.mode === 'display' && <option value="main">Main display</option>}
                {o.mode === 'window' && !t.windows.some((x) => x.id === o.source) && (
                  <option value={o.source}>Choose a window</option>
                )}
                {(o.mode === 'window' ? t.windows : t.displays).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.title || x.name || x.owningApplication || x.id}
                  </option>
                ))}
              </select>
            )}
          </>
        ) : (
          <span className="screen-off">
            <Camera size={15} /> Camera only · screen capture off
          </span>
        )}
      </div>
      <div
        className={'capture-stage ' + (screenEnabled ? '' : 'camera-only')}
        aria-label="Capture preview"
      >
        {screenEnabled && p.screen ? (
          <img
            className="screen-snapshot"
            src={'data:' + p.screen.mime + ';base64,' + p.screen.jpeg}
            alt={'Selected screen preview: ' + sourceName}
          />
        ) : (
          <div className="stage-placeholder">
            {screenEnabled ? <Monitor size={28} /> : <Camera size={28} />}
            <span>
              {screenEnabled
                ? p.feedbackError
                  ? 'Screen preview unavailable'
                  : o.mode === 'area' && !o.area
                    ? 'Draw an area on your desktop'
                    : 'Checking your selected screen…'
                : o.camera === 'none'
                  ? 'Choose a camera below'
                  : 'Warming your camera…'}
            </span>
          </div>
        )}
        {o.camera !== 'none' && (
          <div className="setup-camera" aria-label="Camera preview">
            {p.preview ? (
              <img src={p.preview} alt="Live camera preview" draggable={false} />
            ) : (
              <Camera size={24} />
            )}
          </div>
        )}
        {screenEnabled && <span className="stage-label">{sourceName}</span>}
        {p.countdown !== null && (
          <div className="capture-countdown" role="status" aria-live="polite">
            <strong>{p.countdown > 0 ? p.countdown : '…'}</strong>
            <span>
              {p.countdown > 0 ? `Recording starts in ${p.countdown}` : 'Preparing your recording…'}
            </span>
          </div>
        )}
      </div>
      <div className="compact-devices" data-tour="devices">
        <label>
          <Camera size={17} />
          <span>Camera</span>
          <select
            aria-label="Camera device"
            disabled={disabled}
            value={o.camera}
            onChange={(event) => void p.chooseCamera(event.target.value)}
          >
            <option value="none">Off</option>
            <option value="default">Default camera</option>
            {t.cameras.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <Mic size={17} />
          <span>Microphone</span>
          <select
            aria-label="Microphone device"
            disabled={disabled}
            value={o.mic}
            onChange={(event) => p.chooseMicrophone(event.target.value)}
          >
            <option value="none">Off</option>
            {o.mic !== 'none' && !t.microphones.some((x) => x.id === o.mic) && (
              <option value={o.mic}>Selected microphone unavailable</option>
            )}
            {t.microphones.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <MicrophoneMeter level={p.level} enabled={o.mic !== 'none'} error={!!p.feedbackError} />
      </div>
      {p.feedbackError && (
        <p className="feedback-error" role="status">
          {p.feedbackError.replace(/^Error: /, '')}
        </p>
      )}
      <div
        className={'compact-readiness ' + (p.readiness.blockingReason ? 'needs-attention' : '')}
        role="status"
      >
        {finishing
          ? 'Saving your video…'
          : p.countdown !== null
            ? 'Get ready to record'
            : p.recordingState === 'paused'
              ? 'Recording paused'
              : p.active
                ? 'Recording in progress'
                : p.readiness.blockingReason || 'Ready to record'}
      </div>
      <div className="compact-start" data-tour="start">
        {p.countdown !== null ? (
          <button
            key="cancel-countdown"
            className="secondary full-width"
            onClick={p.cancel}
            aria-keyshortcuts="Escape"
          >
            Cancel countdown
          </button>
        ) : finishing ? (
          <button key="saving-take" className="primary full-width" disabled>
            Saving recording…
          </button>
        ) : p.active ? (
          <button key="stop-take" className="primary full-width" onClick={p.stop}>
            ■ Stop recording
          </button>
        ) : (
          <button
            key="start-take"
            className="primary full-width"
            disabled={disabled || !!p.readiness.blockingReason}
            onClick={() => void p.start()}
          >
            <span className="white-record" />
            {p.busy ? 'Starting…' : 'Start recording'}
            <span className="keycap" aria-hidden="true">
              ⇧ ⌘ R
            </span>
          </button>
        )}
      </div>
      <div className="compact-bottom">
        <details className="compact-more">
          <summary>More options</summary>
          <div className="compact-more-body">
            <label className="compact-option">
              <span>Countdown</span>
              <select
                aria-label="Countdown"
                value={o.countdownSeconds}
                disabled={disabled}
                onChange={(event) => {
                  const seconds = countdownFromSelection(event.target.value);
                  if (seconds !== undefined) void p.update({ countdownSeconds: seconds });
                }}
              >
                {countdownChoices.map((x) => (
                  <option key={x.seconds} value={x.seconds}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="compact-option">
              <span>System audio</span>
              <input
                type="checkbox"
                aria-label="System audio"
                checked={o.systemAudio}
                disabled={disabled || !screenEnabled}
                onChange={(event) => void p.update({ systemAudio: event.target.checked })}
              />
            </label>
            {p.savedSetups}
            <button className="text-button" onClick={p.guide}>
              Recording guide
            </button>
            <button className="text-button" onClick={p.settings}>
              All settings
            </button>
          </div>
        </details>
        <small>{o.autoShare ? 'Auto-share on' : 'Saved on your Mac'}</small>
      </div>
    </section>
  );
}
