// Wait for the action to persist ownership before importing any media code.
let timer;
try {
  const begin = new Promise(resolve => process.once('message', message => {
    if (message?.kind === 'begin-owned-matrix') resolve();
  }));
  process.send({ kind: 'awaiting-owned-matrix' });
  await Promise.race([begin, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Matrix ownership handshake expired')), 10_000); })]);
  clearTimeout(timer);
  await import('./matrix.mjs');
} catch { console.error('Owned matrix child failed before its normal result'); process.exitCode = 1; }
finally { clearTimeout(timer); if (process.connected) process.disconnect(); }
