import React, { useState } from 'react';
import { validateZoomCue, type KeptClip, type ZoomCue } from '../shared/review-draft';
export function ZoomEditor({
  clips,
  cues,
  change,
  run,
}: {
  clips: KeptClip[];
  cues: ZoomCue[];
  change: (cue: ZoomCue | { removeId: string }) => Promise<void>;
  run: (action: () => Promise<void>) => unknown;
}) {
  const [selected, setSelected] = useState<ZoomCue | null>(null);
  const first = clips[0];
  const draft =
    selected ??
    (first
      ? {
          id: '',
          clipId: first.id,
          sourceStartMs: first.sourceStartMs,
          sourceEndMs: Math.min(first.sourceEndMs, first.sourceStartMs + 2000),
          scale: 1.6,
          focus: [0.5, 0.5] as [number, number],
          origin: 'manual' as const,
        }
      : null);
  if (!draft) return <p className="fine-print">Keep a source clip to add a zoom.</p>;
  const patch = (value: Partial<ZoomCue>) => setSelected({ ...draft, ...value });
  const number = (
    label: string,
    value: number,
    onChange: (value: number) => void,
    min: number,
    max: number,
    step: number,
  ) => (
    <label className="field">
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
  return (
    <section className="zoom-editor">
      <h3>Zoom cues</h3>
      <p className="muted">
        Times refer to the original source inside one kept clip. Focus is a fraction of the frame.
      </p>
      <div className="edit-tools">
        {cues.map((cue) => (
          <button
            className="secondary"
            key={cue.id}
            onClick={() => setSelected({ ...cue, focus: [...cue.focus] })}
          >
            {(cue.sourceStartMs / 1000).toFixed(1)}–{(cue.sourceEndMs / 1000).toFixed(1)}s ·{' '}
            {cue.scale.toFixed(2)}×
          </button>
        ))}
      </div>
      <label className="field">
        Kept clip
        <select
          value={draft.clipId}
          onChange={(event) => {
            const clip = clips.find((value) => value.id === event.target.value)!;
            patch({
              clipId: clip.id,
              sourceStartMs: clip.sourceStartMs,
              sourceEndMs: Math.min(clip.sourceEndMs, clip.sourceStartMs + 2000),
            });
          }}
        >
          {clips.map((clip, index) => (
            <option key={clip.id} value={clip.id}>
              Clip {index + 1} · {(clip.sourceStartMs / 1000).toFixed(1)}–
              {(clip.sourceEndMs / 1000).toFixed(1)}s
            </option>
          ))}
        </select>
      </label>
      <div className="zoom-fields">
        {number(
          'Start (seconds)',
          draft.sourceStartMs / 1000,
          (value) => patch({ sourceStartMs: value * 1000 }),
          0,
          604800,
          0.1,
        )}
        {number(
          'End (seconds)',
          draft.sourceEndMs / 1000,
          (value) => patch({ sourceEndMs: value * 1000 }),
          0,
          604800,
          0.1,
        )}
        {number('Scale', draft.scale, (value) => patch({ scale: value }), 1, 4, 0.05)}
        {number(
          'Focus X',
          draft.focus[0],
          (value) => patch({ focus: [value, draft.focus[1]] }),
          0,
          1,
          0.01,
        )}
        {number(
          'Focus Y',
          draft.focus[1],
          (value) => patch({ focus: [draft.focus[0], value] }),
          0,
          1,
          0.01,
        )}
      </div>
      <div className="edit-tools">
        <button
          className="primary"
          onClick={() =>
            run(async () => {
              const cue = validateZoomCue({ ...draft, id: draft.id || crypto.randomUUID() }, clips);
              await change(cue);
              setSelected(null);
            })
          }
        >
          {draft.id ? 'Update zoom' : 'Add zoom'}
        </button>
        <button className="secondary" onClick={() => setSelected(null)}>
          New zoom
        </button>
        {draft.id && (
          <button
            className="text-button danger"
            onClick={() =>
              run(async () => {
                await change({ removeId: draft.id });
                setSelected(null);
              })
            }
          >
            Remove zoom
          </button>
        )}
      </div>
    </section>
  );
}
