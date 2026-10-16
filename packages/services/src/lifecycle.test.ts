import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installShutdown } from './lifecycle.ts';

function setup(stop: (reason: string) => Promise<void>, forceAfterMs = 1000) {
  const proc = new EventEmitter() as unknown as Pick<NodeJS.Process, 'on' | 'off'> & EventEmitter;
  const exits: number[] = [];
  const logs: { level: string; msg: string }[] = [];
  const log = { debug() {}, info: (msg: string) => logs.push({ level: 'info', msg }), warn: (msg: string) => logs.push({ level: 'warn', msg }), error: (msg: string) => logs.push({ level: 'error', msg }) };
  const handle = installShutdown({ name: 'test', log: log as never, stop, forceAfterMs, exit: (c) => void exits.push(c), proc });
  return { proc, exits, logs, handle };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('installShutdown', () => {
  it('SIGTERM runs the clean stop once and exits 0', async () => {
    const stop = vi.fn(async () => {});
    const { proc, exits } = setup(stop);
    proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith('SIGTERM');
    expect(exits).toEqual([0]);
  });

  it('SIGINT does the same', async () => {
    const stop = vi.fn(async () => {});
    const { proc, exits } = setup(stop);
    proc.emit('SIGINT');
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledWith('SIGINT');
    expect(exits).toEqual([0]);
  });

  it('a second signal while stopping means "now": exit immediately without starting a second stop', async () => {
    let release!: () => void;
    const stop = vi.fn(() => new Promise<void>((r) => (release = r)));
    const { proc, exits, logs } = setup(stop);
    proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(10);
    expect(exits).toEqual([]); // still stopping
    proc.emit('SIGINT'); // the operator presses Ctrl-C again
    expect(exits).toEqual([130]);
    expect(stop).toHaveBeenCalledOnce();
    expect(logs.some((l) => /second stop request/.test(l.msg))).toBe(true);
    release();
  });

  it('a stop that hangs is abandoned after the grace period, with a clear log line and a non-zero exit', async () => {
    const stop = vi.fn(() => new Promise<void>(() => {}));
    const { proc, exits, logs } = setup(stop, 5000);
    proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(4999);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(exits).toEqual([1]);
    expect(logs.find((l) => l.level === 'error')!.msg).toMatch(/did not finish within 5s/);
  });

  it('a stop that fails is logged and the process exits non-zero (not silently as a success)', async () => {
    const { proc, exits, logs } = setup(async () => {
      throw new Error('pool.end failed');
    });
    proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(exits).toEqual([1]);
    expect(logs.some((l) => l.level === 'error' && /error while shutting down/.test(l.msg))).toBe(true);
  });

  it('an unhandled rejection is fatal: log, stop cleanly, exit 1 so the supervisor restarts the process', async () => {
    const stop = vi.fn(async () => {});
    const { proc, exits, logs } = setup(stop);
    proc.emit('unhandledRejection', new Error('boom'));
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledWith('unhandledRejection');
    expect(exits).toEqual([1]);
    expect(logs.some((l) => /unhandled promise rejection/.test(l.msg))).toBe(true);
  });

  it('an uncaught exception is fatal too', async () => {
    const stop = vi.fn(async () => {});
    const { proc, exits } = setup(stop);
    proc.emit('uncaughtException', new Error('kaboom'));
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledWith('uncaughtException');
    expect(exits).toEqual([1]);
  });

  it('a signal that arrives after a fatal error is the "now" signal, and does not stop twice', async () => {
    let release!: () => void;
    const stop = vi.fn(() => new Promise<void>((r) => (release = r)));
    const { proc, exits } = setup(stop);
    proc.emit('uncaughtException', new Error('x'));
    await vi.advanceTimersByTimeAsync(10);
    proc.emit('SIGTERM');
    expect(exits).toEqual([1]); // keeps the failing exit code
    expect(stop).toHaveBeenCalledOnce();
    release();
  });

  it('dispose removes the listeners', async () => {
    const stop = vi.fn(async () => {});
    const { proc, exits, handle } = setup(stop);
    handle.dispose();
    proc.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).not.toHaveBeenCalled();
    expect(exits).toEqual([]);
  });
});
