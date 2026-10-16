export type SyncHealth = 'ok' | 'failed' | 'stale' | 'never';

/**
 * Whether an inventory/integration connection's data can be trusted as current. "Connected" only says the authorisation exists —
 * it must never colour the screen green when the last sync failed, never happened, or is older than the freshness window.
 * A recorded error wins over age: a failed sync is shown as failed, not merely old.
 */
export function connectionSyncHealth(c: { lastSyncAt: Date | string | null; lastError: string | null }, now: Date, staleAfterHours: number): SyncHealth {
  if (c.lastError) return 'failed';
  if (!c.lastSyncAt) return 'never';
  const ageMs = now.getTime() - new Date(c.lastSyncAt).getTime();
  return ageMs > staleAfterHours * 3_600_000 ? 'stale' : 'ok';
}
