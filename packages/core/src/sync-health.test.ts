import { describe, expect, it } from 'vitest';
import { connectionSyncHealth } from '@ci/shared';

const now = new Date('2026-10-15T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

describe('connectionSyncHealth', () => {
  it('ok only for a recent sync without an error', () => {
    expect(connectionSyncHealth({ lastSyncAt: hoursAgo(1), lastError: null }, now, 36)).toBe('ok');
    expect(connectionSyncHealth({ lastSyncAt: hoursAgo(36), lastError: null }, now, 36)).toBe('ok');
  });
  it('stale once older than the window', () => {
    expect(connectionSyncHealth({ lastSyncAt: hoursAgo(36.1), lastError: null }, now, 36)).toBe('stale');
  });
  it('never when it has not synced yet', () => {
    expect(connectionSyncHealth({ lastSyncAt: null, lastError: null }, now, 36)).toBe('never');
  });
  it('an error wins over a recent timestamp', () => {
    expect(connectionSyncHealth({ lastSyncAt: hoursAgo(1), lastError: 'token expired' }, now, 36)).toBe('failed');
    expect(connectionSyncHealth({ lastSyncAt: null, lastError: 'denied' }, now, 36)).toBe('failed');
  });
  it('accepts ISO strings (as the web client sees them)', () => {
    expect(connectionSyncHealth({ lastSyncAt: hoursAgo(2).toISOString(), lastError: null }, now, 36)).toBe('ok');
  });
});
