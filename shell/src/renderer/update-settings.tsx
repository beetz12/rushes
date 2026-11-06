import React, { useEffect, useState } from 'react';
import { createNativeAPI } from './native-api';
import { describeUpdateResult, type UpdateStatus } from '../shared/updates';

const api = window.rushes ? createNativeAPI(window.rushes) : window.rushes;

export function UpdateSettings() {
  const [status, setStatus] = useState<UpdateStatus | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let disposed = false;
    void api
      .updates({ action: 'get' })
      .then((value) => !disposed && setStatus(value))
      .catch(() => !disposed && setMessage("Couldn't load update settings."));
    return () => {
      disposed = true;
    };
  }, []);
  const call = async (request: Parameters<typeof api.updates>[0]) => {
    setBusy(true);
    try {
      const next = await api.updates(request);
      setStatus(next);
      setMessage(request.action === 'check' ? describeUpdateResult(next.last) : '');
    } catch {
      setMessage(request.action === 'check' ? "Couldn't check for updates. Try again later." : '');
    } finally {
      setBusy(false);
    }
  };
  const available = status?.last?.state === 'available';
  return (
    <section className="settings-card">
      <h2>Updates</h2>
      <p className="muted">
        Rushes {status?.current ?? ''} tells you when a new version is out. Install it by hand from
        the release page; nothing downloads on its own.
      </p>
      <label className="check-label">
        <input
          type="checkbox"
          checked={status?.automatic ?? true}
          disabled={!status || busy}
          onChange={(event) =>
            void call({ action: 'set-automatic', enabled: event.target.checked })
          }
        />
        Check for updates automatically
      </label>
      <p className="fine-print">
        Once a day Rushes asks GitHub for the latest release. The request carries only
        &ldquo;Rushes/version&rdquo;: no account, no identifiers, no telemetry.
      </p>
      <div className="edit-tools">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void call({ action: 'check' })}
        >
          {busy ? 'Checking…' : 'Check now'}
        </button>
        {available && (
          <button className="secondary" onClick={() => void call({ action: 'open-release' })}>
            Open release page
          </button>
        )}
      </div>
      {message && (
        <p className="fine-print" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
