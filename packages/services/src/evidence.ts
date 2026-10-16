import { eq } from 'drizzle-orm';
import type { EvidenceDoc } from '@ci/connectors';
import { evidence, type DbLike } from '@ci/database';
import type { Provenance } from '@ci/shared';
import type { Services } from './context.ts';
import { provenanceFor } from './workspace.ts';

/**
 * Records a fetched document as evidence: URL, time, status, content hash and a supporting snippet always;
 * the raw body goes to object storage (subject to the snapshot retention window) when provided.
 * The evidence ROW outlives the stored snapshot, so observations and reports never dangle after retention.
 */
export async function recordEvidence(
  svc: Pick<Services, 'storage'>,
  db: DbLike,
  p: { orgId: string; siteId: string; doc: EvidenceDoc; method: string | null; version: string | null; isFixture: boolean; provenance?: Provenance },
): Promise<string> {
  const [row] = await db
    .insert(evidence)
    .values({
      orgId: p.orgId,
      siteId: p.siteId,
      url: p.doc.url,
      fetchedAt: p.doc.fetchedAt,
      httpStatus: p.doc.httpStatus,
      contentType: p.doc.contentType,
      contentHash: p.doc.contentHash,
      bytes: p.doc.bytes,
      snippet: p.doc.snippet.slice(0, 2000),
      extractionMethod: p.method,
      extractionVersion: p.version,
      isFixture: p.isFixture,
      provenance: p.provenance ?? provenanceFor({ isFixture: p.isFixture }),
    })
    .returning({ id: evidence.id });
  const id = row!.id;
  if (p.doc.body && p.doc.body.length > 0) {
    const key = `evidence/${p.orgId}/${p.siteId}/${id}`;
    await svc.storage.put(key, p.doc.body, p.doc.contentType || 'application/octet-stream');
    await db.update(evidence).set({ snapshotRef: key }).where(eq(evidence.id, id));
  }
  return id;
}
