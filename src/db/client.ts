import "server-only";

import { Kysely, MysqlDialect, sql } from "kysely";
import type { Transaction } from "kysely";
import type { RowDataPacket } from "mysql2";
import { getCorePool, getPool } from "@/db/pool";
import type { Database } from "@/db/schema";

/**
 * The typed database handle.
 *
 * Kysely only ever emits parameterised SQL, so nothing in the application
 * concatenates a value into a statement. Everything that reads or writes goes
 * through this handle or a transaction derived from it.
 *
 * Cached on the global the same way the pool is, so Next's dev-server module
 * reloads do not accumulate handles.
 */
const globalForDb = globalThis as typeof globalThis & {
  __lcciDb?: Kysely<Database>;
};

function createDb(): Kysely<Database> {
  // `getCorePool()`, not `getPool()`. The dialect calls `getConnection(cb)`,
  // which a promise pool accepts and silently never calls back — see the note
  // in `db/pool.ts`. The two share one set of connections.
  return new Kysely<Database>({
    dialect: new MysqlDialect({ pool: getCorePool() }),
  });
}

export function getDb(): Kysely<Database> {
  globalForDb.__lcciDb ??= createDb();
  return globalForDb.__lcciDb;
}

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

/** Anything that can run a statement: the handle, or a transaction. */
export type Queryable = Db | Tx;

/**
 * Run `fn` inside a transaction.
 *
 * Every state transition in this system is a state change plus its side
 * effects, and the two must land together or not at all — an approval that
 * allocates a membership number but fails to insert the membership row is
 * worse than an approval that failed.
 */
export async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return getDb().transaction().execute(fn);
}

/** 1213 ER_LOCK_DEADLOCK, 1205 ER_LOCK_WAIT_TIMEOUT. */
const TRANSIENT_LOCK_ERRNOS = new Set([1213, 1205]);

function isTransientLockError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const errno = (error as { errno?: unknown }).errno;
  return typeof errno === "number" && TRANSIENT_LOCK_ERRNOS.has(errno);
}

/**
 * Run a transaction, retrying it if InnoDB picks it as a deadlock victim.
 *
 * A deadlock is not a bug and not an error the caller can act on: InnoDB
 * detects a lock cycle, rolls one transaction back immediately, and the
 * correct response is to run it again. It is also not hypothetical here. The
 * aggregate document cap takes `SELECT ... FOR UPDATE` over an application's
 * documents and the wizard uploads one file per request as each is selected —
 * so several of an applicant's own uploads routinely contend on the same gap,
 * and without this the applicant sees "upload failed" for a file that was
 * perfectly acceptable, caused by another upload of their own.
 *
 * Bounded at three attempts with a short jittered pause. Not more: a genuine
 * deadlock resolves on the first retry, and a loop that keeps trying under
 * real contention holds a Passenger worker and one of three pool connections
 * while it does.
 *
 * Only for transactions whose work is a pure function of what they read. Every
 * caller here qualifies, because the side effects outside the transaction —
 * writing the file, sending mail — happen either side of it, never inside.
 */
export async function retryOnDeadlock<T>(
  fn: (tx: Tx) => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await transaction(fn);
    } catch (error) {
      if (!isTransientLockError(error)) throw error;
      lastError = error;
      if (attempt === attempts) break;
      // Jittered, so two victims of the same cycle do not retry in lockstep
      // and deadlock again on the same gap.
      await new Promise((resolve) =>
        setTimeout(resolve, 10 * attempt + Math.floor(Math.random() * 15)),
      );
    }
  }

  throw lastError;
}

/**
 * Apply a guarded state change and report whether this caller won.
 *
 * The shape every transition uses: `UPDATE ... WHERE id = ? AND state = ?
 * AND version = ?`. Zero affected rows means a concurrent actor moved the row
 * first, and the caller must tell the user to reload rather than overwrite a
 * decision it never saw.
 *
 * This is not defensive programming. Passenger runs several worker processes,
 * so two officers working the same queue are two processes racing on one row,
 * and the losing request must be the one that notices.
 */
export function wonRace(result: { numUpdatedRows: bigint }): boolean {
  return result.numUpdatedRows > 0n;
}

/**
 * Run `fn` while holding a named MySQL advisory lock, or skip it.
 *
 * Used by the migration runner and the cron job runner. `GET_LOCK` is the
 * right primitive on this host for one specific reason: it is released
 * automatically when the connection drops, so a worker killed by the shared
 * plan's CPU limiter cannot leave the lock held — which a lock table can, and
 * which is why `job_runs` also carries a heartbeat.
 *
 * The lock must be acquired and released on the *same* connection, so this
 * takes a connection out of the pool rather than going through the pool's
 * query method. With a three-connection pool, hold it briefly.
 *
 * Returns `{ acquired: false }` rather than throwing when the lock is held:
 * a skipped run is a normal outcome, not an error, and a cron job that exits
 * non-zero on a normal skip emails the administrator every five minutes.
 */
export async function withAdvisoryLock<T>(
  name: string,
  timeoutSeconds: number,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false; value?: undefined }> {
  const connection = await getPool().getConnection();
  try {
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT GET_LOCK(?, ?) AS locked",
      [name, timeoutSeconds],
    );

    // GET_LOCK returns 1 on success, 0 on timeout and NULL on error.
    const locked = Number(rows[0]?.locked ?? 0);
    if (locked !== 1) return { acquired: false };

    try {
      return { acquired: true, value: await fn() };
    } finally {
      await connection.query("SELECT RELEASE_LOCK(?)", [name]);
    }
  } finally {
    connection.release();
  }
}

/** Re-exported so callers reach for one `sql` tag rather than importing Kysely. */
export { sql };
