import React, { useEffect, useRef, useState } from 'react';
import { normalizedPointer } from '../shared/geometry';
const api = window.rushes;
type Run = (fn: () => Promise<unknown>) => Promise<unknown>;
export function ProductionSettings({ run }: { run: Run }) {
  const [prompt, setPrompt] = useState({ enabled: false, script: '', locale: 'en-US' });
  const [blur, setBlur] = useState({ enabled: false, radius: 20 });
  const [mcp, setMCP] = useState<any>({ enabled: false, allowMutations: false });
  const [allowMutations, setAllowMutations] = useState(false);
  const [token, setToken] = useState('');
  const [available, setAvailable] = useState<Record<string, boolean>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  useEffect(() => {
    let disposed = false;
    for (const [name, command, apply] of [
      ['prompt', 'teleprompter.get', setPrompt],
      ['blur', 'camera.blur.get', setBlur],
      ['mcp', 'mcp.status', setMCP],
    ] as const)
      void api
        .request(command)
        .then((value) => {
          if (disposed) return;
          apply(value);
          if (name === 'mcp') setAllowMutations(value.allowMutations === true);
          setAvailable((old) => ({ ...old, [name]: true }));
        })
        .catch((error) => {
          if (!disposed) setMessages((old) => ({ ...old, [name]: String(error) }));
        });
    return () => {
      disposed = true;
    };
  }, []);
  return (
    <>
      <section className="settings-card">
        <h2>Voice teleprompter</h2>
        <p className="muted">
          A private overlay follows your voice using the microphone you record with.
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={prompt.enabled}
            onChange={(event) => setPrompt({ ...prompt, enabled: event.target.checked })}
          />
          Show while recording
        </label>
        <label className="field">
          Script
          <textarea
            rows={7}
            maxLength={100000}
            value={prompt.script ?? ''}
            onChange={(event) => setPrompt({ ...prompt, script: event.target.value })}
            placeholder="Paste the words you want to say…"
          />
        </label>
        <label className="field">
          Speech language
          <input
            value={prompt.locale ?? 'en-US'}
            onChange={(event) => setPrompt({ ...prompt, locale: event.target.value })}
          />
        </label>
        <button
          className="primary"
          disabled={!available.prompt}
          onClick={() =>
            run(async () => {
              const saved = await api.request('teleprompter.set', {
                enabled: prompt.enabled,
                script: prompt.script,
                locale: prompt.locale,
              });
              setPrompt(saved);
              setMessages((old) => ({
                ...old,
                prompt: 'Script saved. Voice following begins with a microphone recording.',
              }));
            })
          }
        >
          Save script
        </button>
        {messages.prompt && <p className="muted">{messages.prompt}</p>}
      </section>
      <section className="settings-card">
        <h2>Camera background blur</h2>
        <p className="muted">
          Blur appears in camera previews and exported videos. Original camera tracks stay intact.
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            disabled={!available.blur}
            checked={blur.enabled}
            onChange={(event) => {
              const enabled = event.target.checked;
              void run(async () =>
                setBlur(await api.request('camera.blur.set', { enabled, radius: blur.radius })),
              );
            }}
          />
          Enable for new recordings
        </label>
        <label className="field">
          Blur strength · {blur.radius}
          <input
            type="range"
            min={1}
            max={80}
            value={blur.radius}
            onChange={(event) => setBlur({ ...blur, radius: Number(event.target.value) })}
            onPointerUp={() =>
              run(async () =>
                setBlur(
                  await api.request('camera.blur.set', {
                    enabled: blur.enabled,
                    radius: blur.radius,
                  }),
                ),
              )
            }
            onKeyUp={() =>
              run(async () =>
                setBlur(
                  await api.request('camera.blur.set', {
                    enabled: blur.enabled,
                    radius: blur.radius,
                  }),
                ),
              )
            }
          />
        </label>
        <p className="muted">
          Each recording keeps its own blur setting. Changing this setting does not open a camera.
        </p>
        {messages.blur && <p className="muted">{messages.blur}</p>}
      </section>
      <section className="settings-card">
        <h2>Connect an agent</h2>
        <p className="muted">
          Enable a local MCP connection, then copy its private pairing configuration to your agent.
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={allowMutations}
            onChange={(event) => setAllowMutations(event.target.checked)}
          />
          Allow recording and editing commands
        </label>
        <div className="edit-tools">
          <button
            className="primary"
            disabled={!available.mcp}
            onClick={() =>
              run(async () => {
                const result = await api.request('mcp.enable', { allowMutations });
                setMCP(result);
                setToken(result.token ?? '');
              })
            }
          >
            {mcp.enabled ? 'Refresh pairing' : 'Enable connection'}
          </button>
          <button
            className="secondary"
            disabled={!mcp.enabled}
            onClick={() =>
              run(async () => {
                setMCP(await api.request('mcp.disable'));
                setToken('');
              })
            }
          >
            Disable
          </button>
        </div>
        {mcp.enabled && (
          <>
            <p className="muted">
              {mcp.allowMutations
                ? 'Recording and editing access enabled.'
                : 'Read-only access enabled.'}
            </p>
            <label className="field">
              Local endpoint
              <input readOnly value={mcp.url ?? ''} />
            </label>
          </>
        )}
        {token && (
          <>
            <label className="field">
              Pairing token
              <input type="password" readOnly value={token} />
            </label>
            <button
              className="secondary"
              onClick={() =>
                run(() =>
                  api.copyText(
                    JSON.stringify(
                      {
                        mcpServers: {
                          rushes: { url: mcp.url, headers: { Authorization: `Bearer ${token}` } },
                        },
                      },
                      null,
                      2,
                    ),
                  ),
                )
              }
            >
              Copy pairing configuration
            </button>
          </>
        )}
        {messages.mcp && <p className="muted">{messages.mcp}</p>}
      </section>
    </>
  );
}
export function TeleprompterOverlay() {
  const [script, setScript] = useState('');
  const [progress, setProgress] = useState<any>({ charOffset: 0, state: 'armed' });
  const current = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    void api.request('teleprompter.get').then((config) => {
      setScript(config.script ?? '');
      setProgress(
        config.progress ?? {
          charOffset: 0,
          state: config.state,
          errorCode: config.errorCode,
          message: config.message,
        },
      );
    });
    return api.onEvent((event) => {
      if (event.event === 'teleprompter-config') setScript(String(event.script ?? ''));
      if (event.event === 'teleprompter-progress')
        setProgress(event.progress ?? (event.result as any)?.progress ?? {});
    });
  }, []);
  const offset =
    typeof progress.charOffset === 'number' && Number.isFinite(progress.charOffset)
      ? Math.min(script.length, Math.max(0, progress.charOffset))
      : 0;
  useEffect(
    () => current.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    [offset],
  );
  return (
    <div className="teleprompter-pill" style={{ WebkitAppRegion: 'drag' } as any}>
      <div className="teleprompter-status">
        Voice prompt ·{' '}
        {progress.errorCode
          ? (progress.message ?? progress.errorCode)
          : (progress.state ?? 'Waiting for speech')}
      </div>
      <div className="teleprompter-script">
        <span className="spoken">{script.slice(0, offset)}</span>
        <span ref={current} className="current-word">
          {script.slice(offset, offset + 1)}
        </span>
        <span>{script.slice(offset + 1)}</span>
      </div>
    </div>
  );
}
type Point = { x: number; y: number };
type Mark = { tool: string; color: string; points: Point[] };
export function DrawingOverlay() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const marks = useRef<Mark[]>([]);
  const active = useRef<Mark | null>(null);
  const tools = useRef({ tool: 'pen', color: '#f05b46' });
  const paint = () => {
    const element = canvas.current,
      context = element?.getContext('2d');
    if (!element || !context) return;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(innerWidth * ratio),
      pixelHeight = Math.round(innerHeight * ratio);
    if (element.width !== pixelWidth || element.height !== pixelHeight) {
      element.width = pixelWidth;
      element.height = pixelHeight;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, innerWidth, innerHeight);
    for (const mark of [...marks.current, ...(active.current ? [active.current] : [])]) {
      if (!mark.points.length) continue;
      context.strokeStyle = mark.color;
      context.lineWidth = mark.tool === 'highlighter' ? 20 : 4;
      context.globalAlpha = mark.tool === 'highlighter' ? 0.35 : 1;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      const first = mark.points[0],
        last = mark.points[mark.points.length - 1];
      const x = first.x * innerWidth,
        y = first.y * innerHeight,
        endX = last.x * innerWidth,
        endY = last.y * innerHeight;
      context.beginPath();
      context.moveTo(x, y);
      if (mark.tool === 'rectangle') context.rect(x, y, endX - x, endY - y);
      else if (mark.tool === 'arrow') {
        context.lineTo(endX, endY);
        const angle = Math.atan2(endY - y, endX - x),
          length = 16;
        context.moveTo(
          endX - Math.cos(angle - 0.5) * length,
          endY - Math.sin(angle - 0.5) * length,
        );
        context.lineTo(endX, endY);
        context.lineTo(
          endX - Math.cos(angle + 0.5) * length,
          endY - Math.sin(angle + 0.5) * length,
        );
      } else
        for (const point of mark.points)
          context.lineTo(point.x * innerWidth, point.y * innerHeight);
      context.stroke();
    }
  };
  useEffect(() => {
    paint();
    window.addEventListener('resize', paint);
    const off = api.onEvent((event) => {
      if (event.event !== 'drawing-action') return;
      if (event.action === 'tool')
        tools.current = {
          tool: String(event.tool ?? tools.current.tool),
          color: String(event.color ?? tools.current.color),
        };
      if (event.action === 'undo') marks.current.pop();
      if (event.action === 'clear') {
        marks.current = [];
        active.current = null;
      }
      if (event.action === 'pause' && event.paused) active.current = null;
      paint();
    });
    return () => {
      off();
      window.removeEventListener('resize', paint);
    };
  }, []);
  const point = (event: React.PointerEvent): Point | undefined => {
    const result = normalizedPointer(
      { x: event.clientX, y: event.clientY },
      canvas.current?.getBoundingClientRect(),
    );
    return result ? { x: result[0], y: result[1] } : undefined;
  };
  return (
    <canvas
      className="drawing-canvas"
      ref={canvas}
      onPointerDown={(event) => {
        const p = point(event);
        if (!p) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        active.current = { ...tools.current, points: [p] };
        paint();
      }}
      onPointerMove={(event) => {
        const p = point(event);
        if (p && active.current) {
          active.current.points.push(p);
          paint();
        }
      }}
      onPointerUp={() => {
        if (active.current) marks.current.push(active.current);
        active.current = null;
        paint();
      }}
      onPointerCancel={() => {
        active.current = null;
        paint();
      }}
    />
  );
}
export function DrawingTools({ run, error }: { run: Run; error: string }) {
  const [tool, setTool] = useState('pen'),
    [color, setColor] = useState('#f05b46'),
    [paused, setPaused] = useState(false);
  return (
    <div className="drawing-tools">
      <select
        aria-label="Drawing tool"
        value={tool}
        onChange={(event) => {
          const tool = event.target.value;
          setTool(tool);
          void run(() => api.drawing('tool', { tool, color }));
        }}
      >
        {['pen', 'highlighter', 'arrow', 'rectangle'].map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
      <input
        type="color"
        aria-label="Drawing color"
        value={color}
        onChange={(event) => {
          const color = event.target.value;
          setColor(color);
          void run(() => api.drawing('tool', { tool, color }));
        }}
      />
      <button onClick={() => run(() => api.drawing('undo'))}>Undo</button>
      <button onClick={() => run(() => api.drawing('clear'))}>Clear</button>
      <button
        onClick={() => {
          setPaused(!paused);
          void run(() => api.drawing('pause', { paused: !paused }));
        }}
      >
        {paused ? 'Resume drawing' : 'Use desktop'}
      </button>
      <button onClick={() => run(() => api.window('drawing-hide'))}>Done</button>
      {error && <span title={error}>!</span>}
    </div>
  );
}
export function RecordingJobs({ id, run }: { id: string; run: Run }) {
  const [jobs, setJobs] = useState<any[]>([]),
    [error, setError] = useState(''),
    [download, setDownload] = useState(false);
  useEffect(() => {
    let disposed = false;
    const reload = () =>
      api
        .request('jobs.list', { id })
        .then((result) => {
          if (!disposed) {
            setJobs(result.jobs ?? []);
            setError('');
          }
        })
        .catch((error) => {
          if (!disposed) setError(String(error));
        });
    void reload();
    const timer = setInterval(() => void reload(), 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [id]);
  if (!jobs.length && !error) return null;
  return (
    <section className="job-status">
      <h3>Background processing</h3>
      {error && <p className="muted">{error}</p>}
      {jobs.map((job) => (
        <div className="job-row" key={job.id}>
          <span>
            <strong>{job.kind}</strong> · {job.status}
            {job.error && (
              <small>
                {typeof job.error === 'string' ? job.error : (job.error.message ?? job.error.code)}
              </small>
            )}
          </span>
          {job.status === 'failed' && (
            <button
              className="text-button"
              onClick={() =>
                run(async () => {
                  await api.request('jobs.retry', { jobId: job.id, allowAssetDownload: download });
                  const result = await api.request('jobs.list', { id });
                  setJobs(result.jobs ?? []);
                })
              }
            >
              Retry
            </button>
          )}
          {['queued', 'running'].includes(job.status) && (
            <button
              className="text-button"
              onClick={() =>
                run(async () => {
                  await api.request('jobs.cancel', { jobId: job.id });
                  const result = await api.request('jobs.list', { id });
                  setJobs(result.jobs ?? []);
                })
              }
            >
              Cancel
            </button>
          )}
        </div>
      ))}
      {jobs.some((job) => job.status === 'failed' && job.requiresAction) && (
        <label className="check-row">
          <input
            type="checkbox"
            checked={download}
            onChange={(event) => setDownload(event.target.checked)}
          />
          Allow Apple speech model download on retry
        </label>
      )}
    </section>
  );
}
