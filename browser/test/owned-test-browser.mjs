// Owns one generated-media test process, including a launch that finishes after abort.
const within = async (operation, milliseconds, label) => {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
  })]); } finally { clearTimeout(timer); }
};

export async function ownedTestBrowser(signal, launch, connect) {
  let server, retiring, cleanupError;
  const retire = () => {
    if (!server) return Promise.resolve();
    if (retiring) return retiring;
    retiring = (async () => {
      const child = server.process();
      try { await within(server.kill(), 3000, 'Owned test browser exit'); }
      catch (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (child.exitCode === null && child.signalCode === null)
          await within(new Promise(resolve => child.once('exit', resolve)), 2000, 'Owned test process exit confirmation');
        throw error;
      }
      if (child.exitCode === null && child.signalCode === null) throw new Error('Owned test process did not confirm exit');
    })();
    return retiring;
  };
  const abort = () => { void retire().catch(error => { cleanupError = error; }); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    server = await launch();
    signal.throwIfAborted();
    const browser = await connect(server.wsEndpoint());
    signal.throwIfAborted();
    return { browser, process: server.process(),
      async close() {
        signal.removeEventListener('abort', abort);
        await retire(); if (cleanupError) throw cleanupError;
      } };
  } catch (error) {
    signal.removeEventListener('abort', abort);
    try { await retire(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Generated browser setup and retirement failed'); }
    throw error;
  }
}
