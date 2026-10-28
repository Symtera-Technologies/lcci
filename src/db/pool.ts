import "server-only";

import mysql from "mysql2";
import type { Pool as PromisePool } from "mysql2/promise";
import { env, requireEnv } from "@/server/env";

/**
 * The MySQL connection pool.
 *
 * One pool per Node process. Passenger spawns several worker processes, so the
 * cluster-wide connection count is `connectionLimit` times the worker count —
 * see the note on `env.db.connectionLimit` for why that number is small.
 *
 * Four of these options are load-bearing rather than tuning:
 *
 * - `timezone: "Z"` makes every DATETIME round-trip as UTC. Rendering in
 *   Asia/Karachi (UTC+5, no DST) happens at the edge, once.
 * - `dateStrings: ["DATE"]` is the single option that prevents the worst bug
 *   available in this schema. `valid_until` is a civil date, 31 March, and it
 *   is printed on membership certificates. Deserialised into a JS Date and
 *   rendered in the wrong zone it becomes 30 March. Returning DATE columns as
 *   "YYYY-MM-DD" strings removes the possibility.
 * - `supportBigNumbers` with `bigNumberStrings: false` keeps BIGINT ids as
 *   numbers while they are small enough to be exact, and throws rather than
 *   silently rounding when they are not.
 * - `decimalNumbers: false` keeps DECIMAL as strings. Fees and receipts are
 *   money; a float is not a number of rupees.
 *
 * Built from `mysql2` rather than `mysql2/promise`, and that is load-bearing
 * too. mysql2 ships two APIs over one pool: a callback pool, and a promise
 * wrapper obtained from it with `.promise()`. Kysely's `MysqlDialect` drives
 * the callback one — it calls `pool.getConnection(callback)`. A promise pool
 * accepts that call, ignores the callback, and returns a promise nobody is
 * holding, so the callback never fires and the query never settles: no error,
 * no timeout, just a connection sitting idle forever. Handing Kysely a promise
 * pool hangs every query the application makes.
 *
 * So the callback pool is the one real object, and the promise wrapper is
 * derived from it. Both are cached, because `.promise()` returns a new wrapper
 * each call, and they share the same connections either way.
 */
function createCorePool(): mysql.Pool {
  requireEnv();

  const pool = mysql.createPool({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    connectionLimit: env.db.connectionLimit,

    // A connection handed out after sitting idle behind a shared-host firewall
    // is a connection that fails on first use; keepalive keeps it honest.
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,

    timezone: "Z",
    dateStrings: ["DATE"],
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: false,

    connectTimeout: 10_000,

    // Queueing is correct here: with three connections and several workers, a
    // brief wait is better than an error. The limit stops an unbounded queue
    // from turning a slow query into a memory problem.
    waitForConnections: true,
    queueLimit: 50,

    // Every statement goes out as a prepared statement; the cache keeps the
    // parse cost off the hot path. Kysely only ever emits parameterised SQL,
    // so nothing in the app concatenates a value into a query.
    namedPlaceholders: false,
  });

  /**
   * Put every connection's *session* in UTC.
   *
   * `timezone: "Z"` above is only half the job, and the half it does is the
   * less important one. It tells the driver how to read and write the DATETIME
   * values that cross the wire, so a JS `Date` sent from the application
   * arrives correctly. It does nothing whatsoever to the server's own clock:
   * `NOW()`, `CURRENT_TIMESTAMP` column defaults and `CURDATE()` are evaluated
   * in the session's time zone, which defaults to the server's — Asia/Karachi
   * on the development machine, and whatever the shared host happens to be set
   * to in production.
   *
   * Left alone, the two disagree by the UTC offset: every timestamp the
   * database generates reads five hours away from every timestamp the
   * application generates. That is not a cosmetic difference. The outbox
   * claims rows `WHERE next_attempt_at <= now`, the rate limiter compares
   * window boundaries, and the job runner ages out stale heartbeats — all of
   * them comparing one clock against the other. A five-hour skew means mail
   * that is never sent, limits that never apply, and an audit log whose
   * ordering is a fiction.
   *
   * mysql2 has no "run this on connect" option, so this hangs off the pool's
   * `connection` event, which fires once per physical connection before it is
   * handed to a waiter. Commands on a connection run in the order they are
   * queued, so this lands before anything the application sends.
   */
  pool.on("connection", (connection) => {
    connection.query("SET time_zone = '+00:00'", (error) => {
      if (!error) return;
      // Not throwable from here — this fires on a pool-internal event with no
      // caller to reject. Loud is the best available: a connection in the
      // wrong zone silently corrupts every comparison made on it.
      console.error(
        "[lcci] could not set session time zone to UTC; timestamps on this " +
          "connection will be skewed:",
        error.message,
      );
    });
  });

  return pool;
}

/**
 * Lazily created, and cached across the module reloads that Next's dev server
 * performs on every edit — without this, a few minutes of editing exhausts
 * `max_user_connections` and the symptom looks like a database outage.
 */
const globalForPool = globalThis as typeof globalThis & {
  __lcciCorePool?: mysql.Pool;
  __lcciPromisePool?: PromisePool;
};

/**
 * The callback-API pool, for Kysely's `MysqlDialect` and nothing else.
 *
 * Application code wants `getPool()`. This exists because the dialect is
 * written against the callback API — see the note on `createCorePool`.
 */
export function getCorePool(): mysql.Pool {
  globalForPool.__lcciCorePool ??= createCorePool();
  return globalForPool.__lcciCorePool;
}

/**
 * The promise-API pool: the one everything that is not Kysely should use.
 *
 * The same connections as `getCorePool()`, through mysql2's promise wrapper.
 */
export function getPool(): PromisePool {
  globalForPool.__lcciPromisePool ??= getCorePool().promise();
  return globalForPool.__lcciPromisePool;
}

/** Closes the pool. For scripts and tests; the server never calls this. */
export async function closePool(): Promise<void> {
  const promisePool = globalForPool.__lcciPromisePool;
  const corePool = globalForPool.__lcciCorePool;
  globalForPool.__lcciPromisePool = undefined;
  globalForPool.__lcciCorePool = undefined;

  // One underlying pool, so it is ended once. Ending the wrapper ends the core
  // pool with it; ending both would throw "Pool is closed" on the second call.
  if (promisePool) {
    await promisePool.end();
    return;
  }
  if (corePool) {
    await new Promise<void>((resolve, reject) => {
      corePool.end((error) => (error ? reject(error) : resolve()));
    });
  }
}
