// Test-owned browsers only. Register immediately so setup failures are owned too.
export function fixtureContexts() {
  const contexts = new Set();
  return {
    own(context) { contexts.add(context); context.on('close', () => contexts.delete(context)); return context; },
    get size() { return contexts.size; },
    async drain(diagnose) {
      const retained = [...contexts];
      let diagnostics;
      try { diagnostics = await Promise.allSettled(retained.map(context => Promise.resolve().then(() => diagnose(context)))); }
      finally {
        const closed = await Promise.allSettled(retained.map(context => Promise.resolve().then(() => context.close())));
        const failures = closed.filter(result => result.status === 'rejected').map(result => result.reason);
        if (failures.length) throw new AggregateError(failures, 'Test-owned browser contexts did not close.');
      }
      return diagnostics;
    },
  };
}

export async function diagnosticWithin(operation, milliseconds) {
  let deadline;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error('Test diagnostic deadline exceeded.')), milliseconds);
  })]); }
  finally { clearTimeout(deadline); }
}
