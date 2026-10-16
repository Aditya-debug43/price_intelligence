import type { Logger } from './context.ts';

/**
 * Process lifecycle for the API and the worker: stop cleanly on SIGINT/SIGTERM, never hang a deploy, and never carry on in an unknown state.
 *  - the first signal starts a clean stop; a second one means "now" and exits immediately;
 *  - a clean stop that takes longer than forceAfterMs is abandoned (an orchestrator would kill the process anyway, and a clear log
 *    line is better than a silent SIGKILL);
 *  - an unhandled rejection or uncaught exception is logged and treated as fatal: stop, then exit non-zero so the supervisor restarts it.
 */
export interface ShutdownHandle {
  /** Starts the shutdown as if the given signal had arrived. Resolves when the process would have exited. */
  trigger(reason: string, exitCode?: number): Promise<void>;
  /** Removes the process listeners (tests). */
  dispose(): void;
}

export function installShutdown(opts: {
  name: string;
  log: Logger;
  /** The clean stop: finish or release work, close pools. */
  stop: (reason: string) => Promise<void>;
  forceAfterMs?: number;
  /** Injectable for tests. */
  exit?: (code: number) => void;
  proc?: Pick<NodeJS.Process, 'on' | 'off'>;
}): ShutdownHandle {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const proc = opts.proc ?? process;
  const forceAfterMs = opts.forceAfterMs ?? 30_000;
  let shuttingDown: Promise<void> | null = null;
  /** The exit code the process is heading for: a fatal error (or a failed stop) keeps it non-zero whatever happens next. */
  let code = 0;

  const trigger = (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      opts.log.warn(`${opts.name}: second stop request while shutting down; exiting now`, { reason });
      exit(code !== 0 ? code : exitCode !== 0 ? exitCode : 130);
      return shuttingDown;
    }
    opts.log.info(`${opts.name}: shutting down`, { reason });
    code = exitCode;
    shuttingDown = (async () => {
      const timer = setTimeout(() => {
        opts.log.error(`${opts.name}: shutdown did not finish within ${forceAfterMs / 1000}s; exiting anyway`);
        exit(code === 0 ? 1 : code);
      }, forceAfterMs);
      timer.unref?.();
      try {
        await opts.stop(reason);
      } catch (e) {
        code = code === 0 ? 1 : code;
        opts.log.error(`${opts.name}: error while shutting down`, { error: (e as Error).message });
      } finally {
        clearTimeout(timer);
      }
      exit(code);
    })();
    return shuttingDown;
  };

  const onSigint = () => void trigger('SIGINT');
  const onSigterm = () => void trigger('SIGTERM');
  const onRejection = (reason: unknown) => {
    opts.log.error(`${opts.name}: unhandled promise rejection`, { error: reason instanceof Error ? reason.message : String(reason) });
    void trigger('unhandledRejection', 1);
  };
  const onException = (err: Error) => {
    opts.log.error(`${opts.name}: uncaught exception`, { error: err.message });
    void trigger('uncaughtException', 1);
  };
  proc.on('SIGINT', onSigint);
  proc.on('SIGTERM', onSigterm);
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);
  return {
    trigger,
    dispose() {
      proc.off('SIGINT', onSigint);
      proc.off('SIGTERM', onSigterm);
      proc.off('unhandledRejection', onRejection);
      proc.off('uncaughtException', onException);
    },
  };
}
