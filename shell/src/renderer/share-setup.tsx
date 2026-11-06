import React, { useEffect, useState } from 'react';
import {
  REQUIRED_TOKEN_PERMISSIONS,
  SHARE_SETUP_NAMES,
  shareSetupStepLabels,
  shareSetupSteps,
  type CloudflareAccount,
  type ShareSetupResult,
  type ShareSetupRunInput,
  type ShareSetupStep,
} from '../shared/share-setup';
import type { EngineEvent } from '../shared/contracts';

/** The slice of the preload API the wizard uses. */
export interface ShareSetupBridge {
  shareSetupAccounts(token: string): Promise<CloudflareAccount[]>;
  shareSetupRun(input: ShareSetupRunInput): Promise<ShareSetupResult>;
  shareSetupOpen(page: 'token' | 'r2'): Promise<void>;
  copyLink(url: string): Promise<void>;
  onEvent(listener: (event: EngineEvent) => void): () => void;
}

type Stage = 'token' | 'account' | 'run' | 'done';
type Failure = { code: string; message: string };
const failure = (error: unknown): Failure => ({
  code: String((error as { code?: unknown })?.code ?? 'ipc-error'),
  message: (error as Error)?.message || 'Something went wrong. Try again.',
});
const list: React.CSSProperties = { margin: '6px 0 12px', paddingLeft: 18, lineHeight: 1.7 };

/** Three steps: token, account, set up. The token stays in this component's memory only. */
export function ShareSetupWizard({
  api,
  onClose,
  onDone,
}: {
  api: ShareSetupBridge;
  onClose: () => void;
  onDone: () => void;
}) {
  const [stage, setStage] = useState<Stage>('token');
  const [token, setToken] = useState('');
  const [accounts, setAccounts] = useState<CloudflareAccount[]>([]);
  const [accountId, setAccountId] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [steps, setSteps] = useState<Partial<Record<ShareSetupStep, 'active' | 'done'>>>({});
  const [result, setResult] = useState<ShareSetupResult | null>(null);
  const [copied, setCopied] = useState(false);
  const account = accounts.find((a) => a.id === accountId);
  const name = account?.subdomain ?? subdomain.trim().toLowerCase();

  useEffect(
    () =>
      api.onEvent((event) => {
        if (event.event !== 'share-setup-progress') return;
        const step = event.step as ShareSetupStep;
        const status = event.status === 'done' ? 'done' : 'active';
        setSteps((previous) => ({ ...previous, [step]: status }));
      }),
    [api],
  );

  async function loadAccounts() {
    setBusy(true);
    setError(null);
    try {
      const found = await api.shareSetupAccounts(token.trim());
      setAccounts(found);
      setAccountId(found[0]?.id ?? '');
      setStage('account');
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  async function runSetup() {
    setStage('run');
    setBusy(true);
    setError(null);
    setSteps({});
    try {
      const done = await api.shareSetupRun({
        token: token.trim(),
        accountId,
        ...(account?.subdomain ? {} : { subdomain: subdomain.trim().toLowerCase() }),
      });
      setResult(done);
      setToken('');
      setStage('done');
      onDone();
    } catch (e) {
      const f = failure(e);
      setError(f);
      if (['SETUP_SUBDOMAIN_REQUIRED', 'SETUP_SUBDOMAIN_TAKEN'].includes(f.code)) {
        setAccounts((previous) =>
          previous.map((a) => (a.id === accountId ? { ...a, subdomain: null } : a)),
        );
        setStage('account');
      }
      if (['SETUP_INVALID_TOKEN', 'SETUP_PERMISSION_MISSING'].includes(f.code)) setStage('token');
    } finally {
      setBusy(false);
    }
  }

  const alert = error && (
    <div className="alert error" role="alert">
      {error.message}
      {error.code === 'SETUP_R2_NOT_ENABLED' && (
        <>
          {' '}
          <button className="secondary" onClick={() => void api.shareSetupOpen('r2')}>
            Open R2 in Cloudflare
          </button>
        </>
      )}
    </div>
  );

  return (
    <div className="share-setup" aria-live="polite" style={{ marginTop: 16 }}>
      {stage === 'token' && (
        <>
          <h3>1. Create a Cloudflare API token</h3>
          <p className="muted">
            Rushes puts a small share service in your own Cloudflare account. It needs a token to do
            that once.
          </p>
          <ol style={list}>
            <li>
              Open the token page and choose <strong>Create Token</strong>, then{' '}
              <strong>Create Custom Token</strong>.
            </li>
            <li>
              Add these permissions:
              <ul style={{ paddingLeft: 18 }}>
                {REQUIRED_TOKEN_PERMISSIONS.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </li>
            <li>Under Account Resources, include your account. Create the token and copy it.</li>
          </ol>
          <button className="secondary" onClick={() => void api.shareSetupOpen('token')}>
            Open Cloudflare API Tokens
          </button>
          <label className="field" style={{ marginTop: 14 }}>
            Paste the token
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <p className="fine-print">
            Rushes uses the token for this setup only and does not save it.
          </p>
          {alert}
          <div className="edit-tools">
            <button
              className="primary"
              disabled={busy || token.trim().length < 20}
              onClick={() => void loadAccounts()}
            >
              {busy ? 'Checking…' : 'Continue'}
            </button>
            <button className="secondary" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
      {stage === 'account' && (
        <>
          <h3>2. Choose account</h3>
          {accounts.map((a) => (
            <label key={a.id} className="check-label">
              <input
                type="radio"
                name="share-setup-account"
                checked={a.id === accountId}
                onChange={() => setAccountId(a.id)}
              />
              {a.name}
            </label>
          ))}
          {account && !account.subdomain && (
            <label className="field" style={{ marginTop: 14 }}>
              This account has no workers.dev address yet. Pick a name:
              <input
                value={subdomain}
                autoComplete="off"
                spellCheck={false}
                placeholder="your-name"
                onChange={(e) => setSubdomain(e.target.value)}
              />
            </label>
          )}
          {name && (
            <p className="fine-print">
              Your links will start with https://{SHARE_SETUP_NAMES.workerName}.{name}
              .workers.dev
            </p>
          )}
          {alert}
          <div className="edit-tools">
            <button
              className="primary"
              disabled={busy || !accountId || !name}
              onClick={() => void runSetup()}
            >
              Set up sharing
            </button>
            <button className="secondary" onClick={() => setStage('token')}>
              Back
            </button>
          </div>
        </>
      )}
      {stage === 'run' && (
        <>
          <h3>3. Set up</h3>
          <ul style={{ ...list, listStyle: 'none', paddingLeft: 0 }}>
            {shareSetupSteps.map((step) => {
              const status = steps[step];
              const failed = !busy && error && status === 'active';
              return (
                <li key={step} className={status ? '' : 'muted'}>
                  {failed ? '✕' : status === 'done' ? '✓' : status === 'active' ? '…' : '○'}{' '}
                  {shareSetupStepLabels[step]}
                </li>
              );
            })}
          </ul>
          {alert}
          {!busy && error && (
            <div className="edit-tools">
              <button className="primary" onClick={() => void runSetup()}>
                Try again
              </button>
              <button className="secondary" onClick={onClose}>
                Close
              </button>
            </div>
          )}
        </>
      )}
      {stage === 'done' && result && (
        <>
          <h3>Done</h3>
          <p>
            Sharing is ready.{' '}
            {result.verified
              ? 'The connection test passed.'
              : 'The connection test did not pass yet. Choose Test connection in a minute.'}
          </p>
          <p className="fine-print">Your share service: {result.workerURL}</p>
          <p className="muted">Record a take and choose Share. The link is copied for you.</p>
          <div className="edit-tools">
            <button
              className="secondary"
              onClick={async () => {
                await api.copyLink(`${result.workerURL}/health`);
                setCopied(true);
              }}
            >
              {copied ? 'Test link copied' : 'Copy test link'}
            </button>
            <button className="primary" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}
