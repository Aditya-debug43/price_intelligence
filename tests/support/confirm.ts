import { asc, eq } from 'drizzle-orm';
import { memberships, type DbLike } from '@ci/database';
import { bulkAcceptMatches } from '@ci/services';

/**
 * A person confirming what the matcher suggested. Since nothing is accepted by a run, a test that wants a price comparison must do what a
 * customer does: look at the waiting pairs and confirm them (here through the same bulk-confirmation a customer uses).
 */
export async function confirmSuggestions(db: DbLike, orgId: string, classes: ('identical' | 'different_pack')[] = ['identical', 'different_pack']): Promise<number> {
  const [owner] = await db.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.orgId, orgId)).orderBy(asc(memberships.createdAt)).limit(1);
  if (!owner) throw new Error(`workspace ${orgId} has no member who could confirm`);
  let n = 0;
  for (const matchClass of classes) n += (await bulkAcceptMatches(db, orgId, owner.userId, { matchClass, minConfidence: 0.5 }, new Date())).count;
  return n;
}
