import React, { useEffect, useState } from 'react';
import {
  formatDuration,
  type SharePolicy,
  type SharePolicyPatch,
  type ShareFeedback,
} from '../shared/contracts';

const api = window.rushes;
function localDate(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function ShareAccess({
  id,
  link,
  draft,
  change,
  run,
  setNote,
}: {
  id: string;
  link: string;
  draft: SharePolicyPatch;
  change: (value: SharePolicyPatch) => void;
  run: (action: () => Promise<void>) => unknown;
  setNote: (message: string) => void;
}) {
  const [worker, setWorker] = useState(false);
  const [policy, setPolicy] = useState<SharePolicy | null>(null);
  const [feedback, setFeedback] = useState<ShareFeedback | null>(null);
  const [expiry, setExpiry] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setPolicy(null);
    setFeedback(null);
    setError('');
    const reload = async () => {
      const settings = await api.cloudSettings();
      if (!live) return;
      setWorker(settings.provider === 'worker');
      if (!link || settings.provider !== 'worker') return;
      const results = await Promise.allSettled([api.getSharePolicy(id), api.shareFeedback(id)]);
      if (!live) return;
      if (results[0].status === 'fulfilled') {
        setPolicy(results[0].value);
        setExpiry(localDate(results[0].value.expiresAt));
      } else setError('Link access could not be loaded. Refresh to retry.');
      if (results[1].status === 'fulfilled') setFeedback(results[1].value);
      else setError((previous) => `${previous} Viewer feedback could not be loaded.`.trim());
    };
    void reload().catch(() => {
      if (live) setError('Sharing settings could not be loaded.');
    });
    const off = api.onEvent((event) => {
      if (event.event === 'share-feedback' && event.id === id)
        setFeedback({
          views: event.views as number,
          comments: event.comments as ShareFeedback['comments'],
          reactions: event.reactions as ShareFeedback['reactions'],
        });
      if (event.event === 'share-configured') void reload();
    });
    return () => {
      live = false;
      off();
    };
  }, [id, link]);
  if (!worker) return null;
  const refresh = async () => {
    setBusy(true);
    try {
      const current = await api.getSharePolicy(id);
      setPolicy(current);
      setExpiry(localDate(current.expiresAt));
      setFeedback(await api.shareFeedback(id));
      setError('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="share-access" aria-label="Shared video access and feedback">
      <h3>Link access</h3>
      <p className="fine-print">
        {link
          ? policy
            ? `${policy.protected ? 'Password required' : 'Anyone with the link'} · ${policy.expiresAt ? `Expires ${new Date(policy.expiresAt).toLocaleString()}` : 'No expiry'}`
            : 'Access status unavailable'
          : 'New links are public unless you add a password here.'}
      </p>
      <label className="field">
        {policy?.protected ? 'Change password' : 'Password (optional)'}
        <input
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={1024}
          value={draft.password ?? ''}
          placeholder={policy?.protected ? 'Leave empty to keep password' : 'At least 8 characters'}
          onChange={(event) => {
            const value = event.target.value;
            const { password: _password, ...rest } = draft;
            change(value ? { ...rest, password: value } : rest);
          }}
        />
      </label>
      {link && policy?.protected && (
        <label className="check-label">
          <input
            type="checkbox"
            checked={draft.password === null}
            onChange={(event) => {
              const { password: _password, ...rest } = draft;
              change(event.target.checked ? { ...rest, password: null } : rest);
            }}
          />
          Remove password
        </label>
      )}
      <label className="field">
        Expiry (optional)
        <input
          type="datetime-local"
          value={expiry}
          onChange={(event) => {
            const value = event.target.value;
            setExpiry(value);
            change({ ...draft, expiresAt: value ? new Date(value).toISOString() : null });
          }}
        />
      </label>
      {link && (
        <div className="edit-tools">
          <button
            className="secondary"
            disabled={busy || !Object.keys(draft).length}
            onClick={() =>
              run(async () => {
                setBusy(true);
                try {
                  const updated = await api.setSharePolicy(id, draft);
                  setPolicy(updated);
                  setExpiry(localDate(updated.expiresAt));
                  change({});
                  setError('');
                  setNote('Link access updated. The shared video and captions are unchanged.');
                } finally {
                  setBusy(false);
                }
              })
            }
          >
            Apply access changes
          </button>
          <button className="text-button" disabled={busy} onClick={() => run(refresh)}>
            Refresh
          </button>
        </div>
      )}
      {error && (
        <p className="fine-print" role="status">
          {error}
        </p>
      )}
      {link && (
        <>
          <h3>Shared video feedback</h3>
          <p className="fine-print">
            {feedback
              ? `${feedback.views} ${feedback.views === 1 ? 'play' : 'plays'}`
              : 'View count unavailable'}{' '}
            · New plays checked every 5 minutes.
          </p>
          {feedback?.reactions.map((reaction) => (
            <span className="feedback-reaction" key={reaction.kind}>
              {reaction.kind}: {reaction.count}{' '}
            </span>
          ))}
          <div className="feedback-comments">
            {feedback?.comments.map((comment) => (
              <article key={comment.id}>
                <strong>{comment.name}</strong>
                <p>{comment.body}</p>
                <button
                  className="text-button"
                  onClick={() =>
                    run(async () => {
                      const url = new URL(link);
                      url.searchParams.set('t', String(comment.timestampMs / 1000));
                      await api.copyLink(url.toString());
                      setNote('Link copied at the comment timestamp.');
                    })
                  }
                >
                  Copy link at {formatDuration(comment.timestampMs)}
                </button>
              </article>
            ))}
          </div>
          {feedback && feedback.comments.length === 0 && (
            <p className="fine-print">No comments yet.</p>
          )}
        </>
      )}
    </section>
  );
}
