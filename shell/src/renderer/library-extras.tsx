// Library poster frames, the sort menu and the launch-at-login setting.
import React, { useEffect, useRef, useState } from 'react';
import type { LoginItemState } from '../shared/login-item';
import { librarySortKeys, librarySortLabels, type LibrarySort } from '../shared/library-sort';
import { createNativeAPI } from './native-api';
import './library-extras.css';

const api = window.rushes ? createNativeAPI(window.rushes) : undefined;
// Engine states whose tracks are still being written.
const liveStates = new Set(['recording', 'preparing', 'finishing', 'paused']);

/// The poster frame of a recording, loaded when the card scrolls into view.
/// Anything missing or unreadable keeps the placeholder (the children).
export function LibraryThumbnail({
  folder,
  status,
  children,
}: {
  folder?: string;
  status?: string;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const node = box.current;
    if (!node || visible) return;
    // Without a viewport watcher (old runtimes, tests), load at once.
    if (!('IntersectionObserver' in window)) return setVisible(true);
    const onScreen = (seen: IntersectionObserverEntry[]) => {
      for (const record of seen) if (record.isIntersecting) return setVisible(true);
    };
    const watcher = new window.IntersectionObserver(onScreen, { rootMargin: '0px 0px 240px 0px' });
    watcher.observe(node);
    return () => watcher.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible || !folder || !api || liveStates.has(status ?? '')) return;
    let current = true;
    setBroken(false);
    api.libraryThumbnail(folder).then(
      (value) => current && setUrl(value),
      () => current && setUrl(null),
    );
    return () => {
      current = false;
    };
  }, [visible, folder, status]);
  const shown = url && !broken;
  return (
    <div ref={box} className={`recording-poster${shown ? ' has-thumbnail' : ''}`}>
      {shown ? (
        <img
          className="recording-thumbnail"
          src={url}
          alt=""
          draggable={false}
          onError={() => setBroken(true)}
        />
      ) : null}
      {children}
    </div>
  );
}

export function LibrarySortControl({
  value,
  onChange,
}: {
  value: LibrarySort;
  onChange: (sort: LibrarySort) => void;
}) {
  return (
    <select
      className="library-sort"
      aria-label="Sort recordings"
      value={value}
      onChange={(event) => onChange(event.target.value as LibrarySort)}
    >
      {librarySortKeys.map((key) => (
        <option key={key} value={key}>
          {librarySortLabels[key]}
        </option>
      ))}
    </select>
  );
}

/// Shows what macOS reports, re-read whenever the window regains focus so a
/// change made in System Settings shows up here too.
export function LaunchAtLoginSetting({
  run,
}: {
  run: (action: () => Promise<unknown>) => Promise<unknown>;
}) {
  const [state, setState] = useState<LoginItemState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!api) return;
    const read = () => api.loginItem().then(setState, () => setState(null));
    void read();
    window.addEventListener('focus', read);
    return () => window.removeEventListener('focus', read);
  }, []);
  const toggle = (enabled: boolean) => {
    if (!api) return;
    setBusy(true);
    void run(async () => {
      try {
        setState(await api.loginItem(enabled));
      } finally {
        setState(await api.loginItem().catch(() => null));
        setBusy(false);
      }
    });
  };
  return (
    <div className="launch-at-login">
      <label className="check-label">
        <input
          type="checkbox"
          checked={state?.enabled ?? false}
          disabled={busy || !state?.supported}
          onChange={(event) => toggle(event.target.checked)}
        />
        Open Rushes when you log in
      </label>
      {state && !state.supported && <p className="muted">Available in the installed app.</p>}
      {state?.requiresApproval && (
        <p className="muted">
          Allow Rushes in System Settings › General › Login Items to finish turning this on.
        </p>
      )}
    </div>
  );
}
