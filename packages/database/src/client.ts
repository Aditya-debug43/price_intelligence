import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;
/** Anything that can run queries: the root db or a transaction. Services accept this so they work in either. */
export type DbLike = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export function createPool(connectionString: string, opts: { max?: number; applicationName?: string } = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', () => {
    /* idle client errors must not crash the process; the next query reconnects */
  });
  return pool;
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` inside a transaction whose Postgres setting `app.org_id` is bound to the tenant.
 * Every RLS policy compares `org_id` to that setting, so queries made through `tx` can only ever see
 * or write this tenant's rows — regardless of what the SQL says. Fails closed when no tenant is set.
 */
export async function withTenant<T>(db: Db, orgId: string, fn: (tx: DbLike) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(orgId)) throw new Error('withTenant: orgId must be a UUID');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

export { schema };
