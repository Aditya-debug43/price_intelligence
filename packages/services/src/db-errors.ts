/**
 * What the database said, in plain words.
 *
 * The query layer wraps a database error in an error whose message is the whole SQL statement and every value ("Failed query: insert into … params: …"),
 * and the reason the database gave ("numeric field overflow", "value too long", …) sits in `cause`. Shown as it is, that message hides the reason, is
 * unreadable, and repeats the shop's data on screen and in logs. This reads the real reason and describes it; it never returns the statement or its values.
 */
export interface DatabaseFailure {
  /** Postgres SQLSTATE, when the database reported one (e.g. "22003"). */
  code: string | null;
  /** One plain sentence: what the database refused, and which column when it said so. */
  message: string;
  table?: string;
  column?: string;
  /**
   * True when the database refused THIS DATA (SQLSTATE class 22 "data exception" or 23 "integrity constraint violation"): another product may well be
   * fine, so the product can be skipped and reported. False for everything else (connection lost, out of disk, …), which must still stop the run.
   */
  rowData: boolean;
}

interface PgLike {
  code?: unknown;
  message?: unknown;
  column?: unknown;
  table?: unknown;
  constraint?: unknown;
  cause?: unknown;
}

const isSqlState = (c: unknown): c is string => typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c);

function sqlStateError(e: unknown): PgLike | null {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur && typeof cur === 'object'; i++) {
    const p = cur as PgLike;
    if (isSqlState(p.code)) return p;
    cur = p.cause;
  }
  return null;
}

export function describeDatabaseError(e: unknown): DatabaseFailure | null {
  const pg = sqlStateError(e);
  if (!pg) {
    const msg = e instanceof Error ? e.message : '';
    // A wrapped query error without its cause: still never show the statement and its values.
    return /^Failed query:/.test(msg) ? { code: null, message: 'The database could not save the collected data.', rowData: false } : null;
  }
  const code = pg.code as string;
  const column = typeof pg.column === 'string' ? pg.column : undefined;
  const table = typeof pg.table === 'string' ? pg.table : undefined;
  const where = column ? ` (column “${column}”${table ? ` of ${table}` : ''})` : '';
  const reason = typeof pg.message === 'string' ? pg.message : 'refused';
  const rowData = code.startsWith('22') || code.startsWith('23');
  let message: string;
  switch (code) {
    case '22003':
      message = `A number in the collected data is too large for the database to store${where}.`;
      break;
    case '22001':
      message = `A text in the collected data is too long for the database to store${where}.`;
      break;
    case '22021':
    case '22P05':
      message = `The collected text contains a character the database cannot store${where}.`;
      break;
    case '22P02':
    case '22007':
    case '22008':
      message = `A value in the collected data has a format the database does not accept${where}.`;
      break;
    case '23502':
      message = `A required value is missing from the collected data${where}.`;
      break;
    case '23505':
      message = `The collected data duplicates a record that must be unique${pg.constraint ? ` (${String(pg.constraint)})` : ''}.`;
      break;
    default:
      message = `The database refused to save the collected data: ${reason}${where}.`;
  }
  return { code, message, ...(table ? { table } : {}), ...(column ? { column } : {}), rowData };
}
