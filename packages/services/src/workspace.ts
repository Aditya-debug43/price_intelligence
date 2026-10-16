import { eq } from 'drizzle-orm';
import type { OrgMode, Provenance, QuantitySource } from '@ci/shared';
import { organizations, type DbLike } from '@ci/database';

/** Thrown when something that only belongs in a demo workspace is attempted in a live one (or the reverse). */
export class WorkspaceModeError extends Error {
  constructor(
    message: string,
    readonly status = 403,
  ) {
    super(message);
    this.name = 'WorkspaceModeError';
  }
}

/**
 * An action the user asked for cannot do anything useful yet (nothing to refresh, nothing to report on…). The API answers 409 with the reason
 * instead of a misleading 202 "accepted", so a control never appears to have worked when it did nothing.
 */
export class ActionNotPossibleError extends Error {
  constructor(
    message: string,
    readonly code: string = 'not_possible',
    readonly details?: unknown,
    readonly status = 409,
  ) {
    super(message);
    this.name = 'ActionNotPossibleError';
  }
}

/** A workspace is 'live' unless it was created as a demo. A missing row is treated as live — the safer reading. */
export async function getOrgMode(db: DbLike, orgId: string): Promise<OrgMode> {
  const [row] = await db.select({ mode: organizations.mode }).from(organizations).where(eq(organizations.id, orgId));
  return row?.mode ?? 'live';
}

export async function requireDemoWorkspace(db: DbLike, orgId: string, what: string): Promise<void> {
  if ((await getOrgMode(db, orgId)) !== 'demo') {
    throw new WorkspaceModeError(`${what} exists only in demo workspaces. This is a live workspace, which only ever holds real information.`);
  }
}

/**
 * Where a stored observation came from. Fixture and simulated data are always labelled as such; quantities from a store owner's
 * authorised connection are 'authorised_api'; everything read from a public page, feed or document is 'public_web'.
 */
export function provenanceFor(p: { isFixture: boolean; quantitySource?: QuantitySource | null; official?: boolean }): Provenance {
  if (p.isFixture || p.quantitySource === 'simulated') return 'fixture';
  if (p.quantitySource === 'authorised_inventory') return 'authorised_api';
  if (p.official) return 'official_api';
  return 'public_web';
}

/** Whether a site may be fetched from loopback addresses: only fictional fixture sites in demo workspaces, only when the server allows fixtures. */
export function loopbackAllowed(opts: { allowLocalFixtures: boolean; mode: OrgMode; isFixture: boolean }): boolean {
  return opts.allowLocalFixtures && opts.mode === 'demo' && opts.isFixture;
}
