/**
 * One heavy catalogue job at a time per process. Matching, report generation and AI analysis each build the whole catalogue's analysis in memory; on a small server two of them
 * at once is how a worker runs out of memory. The queue already limits each job type to one at a time; this keeps different types from overlapping while they build.
 * Only the memory-heavy part holds the lock: waiting for a rate limit or for Google never does, so matching is never held up by a slow answer.
 */
let tail: Promise<unknown> = Promise.resolve();

export function withHeavyWork<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
