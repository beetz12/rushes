// Run every independent source cleanup before reporting failure.
export async function finishPreviewCleanup(actions: ReadonlyArray<() => Promise<unknown>>) {
  const results = await Promise.allSettled(actions.map((action) => Promise.resolve().then(action)));
  const failures = results.filter(
    (value): value is PromiseRejectedResult => value.status === 'rejected',
  );
  if (failures.length === 1) throw failures[0].reason;
  if (failures.length > 1)
    throw Object.assign(
      new AggregateError(
        failures.map((value) => value.reason),
        'Some input previews are still closing.',
      ),
      { code: failures[0].reason?.code },
    );
}
