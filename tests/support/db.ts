import pg from 'pg';
import { inject } from 'vitest';
import { createDb, createPool, type Db } from '@ci/database';
import { organizations, users, memberships, orgSettings } from '@ci/database';
import { randomBytes } from 'node:crypto';

export interface TestDb {
  /** RLS-enforced connection (what the API uses). */
  app: Db;
  /** BYPASSRLS connection (what the worker uses). */
  worker: Db;
  /** Owner connection, for assertions that need to see everything. */
  admin: pg.Pool;
  close(): Promise<void>;
}

export function connectTestDb(): TestDb {
  const urls = inject('testDb');
  const appPool = createPool(urls.appUrl, { max: 5 });
  const workerPool = createPool(urls.workerUrl, { max: 5 });
  const admin = new pg.Pool({ connectionString: urls.adminUrl, max: 2 });
  return {
    app: createDb(appPool),
    worker: createDb(workerPool),
    admin,
    async close() {
      await Promise.all([appPool.end(), workerPool.end(), admin.end()]);
    },
  };
}

/** Creates a user + organisation + settings through the worker connection (setup is not what we are testing). */
export async function seedOrg(db: Db, name = 'Test Org') {
  const suffix = randomBytes(4).toString('hex');
  const [user] = await db
    .insert(users)
    .values({ email: `owner-${suffix}@example.test`, passwordHash: 'x', displayName: `Owner ${suffix}` })
    .returning();
  const [org] = await db.insert(organizations).values({ name: `${name} ${suffix}`, slug: `org-${suffix}`, createdBy: user!.id }).returning();
  await db.insert(memberships).values({ orgId: org!.id, userId: user!.id, role: 'owner' });
  await db.insert(orgSettings).values({ orgId: org!.id });
  return { user: user!, org: org! };
}
