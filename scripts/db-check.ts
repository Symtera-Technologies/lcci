/**
 * Can this machine reach the database, and does it hold anything to render?
 *
 *   npm run db:check
 *
 * Written for the one failure that costs the most time on this host. The
 * public pages are statically prerendered and read their content from MySQL,
 * so `next build` connects to the database — and when it cannot, Next reports
 * the driver's own error:
 *
 *   Error occurred prerendering page "/"
 *   Error: connect ECONNREFUSED 127.0.0.1:3306
 *
 * which says nothing about why building a homepage needs MySQL, nothing about
 * which setting is wrong, and takes a full build to produce. This answers the
 * same question in a second, before the build, and names the fix.
 *
 * Read-only, and safe in production: it connects, asks the server's version,
 * and counts rows. Nothing here writes.
 */

import process from "node:process";
import net from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import path from "node:path";
import { getDb, sql } from "@/db/client";
import { closePool } from "@/db/pool";
import { env, envProblems } from "@/server/env";

interface Diagnosis {
  readonly summary: string;
  readonly fix: readonly string[];
}

/**
 * Turn a driver error into something that names the next action.
 *
 * Each of these corresponds to a different mistake with the same symptom, and
 * the distinction is what decides whether the answer is a socket path, a
 * grant, or a database that was never created.
 */
function diagnose(error: unknown): Diagnosis {
  const code = String((error as { code?: unknown })?.code ?? "");
  const message = error instanceof Error ? error.message : String(error);

  if (code === "ECONNREFUSED") {
    return {
      summary: `Nothing is listening at ${target()}.`,
      fix: [
        "On shared cPanel this usually means MySQL listens on a unix socket",
        "and refuses TCP. mysql2 does NOT read `localhost` as \"use the",
        "socket\" the way PHP does — it resolves it to 127.0.0.1 and dials",
        "TCP — so copying `localhost` out of the cPanel panel produces exactly",
        "this error. Find the socket and set DB_SOCKET:",
        "",
        "    mysqladmin variables | grep '  socket' ",
        "    # or: grep -r '^socket' /etc/my.cnf",
        "    # then in .env:  DB_SOCKET=/var/lib/mysql/mysql.sock",
        "",
        "If MySQL is on another host, set DB_HOST and DB_PORT instead.",
      ],
    };
  }

  if (code === "ER_ACCESS_DENIED_ERROR") {
    return {
      summary: "The server answered and refused these credentials.",
      fix: [
        "Check DB_USER and DB_PASSWORD. On cPanel the user is prefixed with",
        "the account name (`acct_lcci`, not `lcci`), and the user must be",
        "added to the database under MySQL Databases with all privileges —",
        "creating both and never associating them is the usual cause.",
      ],
    };
  }

  if (code === "ER_BAD_DB_ERROR") {
    return {
      summary: `The server answered but has no database named ${env.db.database}.`,
      fix: [
        "Check DB_NAME. On cPanel it is prefixed too (`acct_lcci`).",
      ],
    };
  }

  if (code === "ENOENT") {
    return {
      summary: `No socket at ${env.db.socket}.`,
      fix: [
        "DB_SOCKET points at a path that does not exist. Confirm it with",
        "`mysqladmin variables | grep '  socket'`, or clear DB_SOCKET to use",
        "TCP instead.",
      ],
    };
  }

  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH") {
    return {
      summary: `No route to ${target()} within the connect timeout.`,
      fix: [
        "A firewall or a wrong DB_HOST. If this is a build machine reaching a",
        "remote database, remote MySQL access has to be allowed for this",
        "machine's IP — on cPanel that is Remote MySQL, per address.",
      ],
    };
  }

  return { summary: message, fix: [`Driver code: ${code || "none"}`] };
}

/**
 * Where MySQL actually is, when the configured answer turned out to be wrong.
 *
 * Both halves matter and they answer different questions. If TCP is open, the
 * socket was never needed and DB_HOST is the fix. If a socket exists at a path
 * nobody guessed, that path is the fix. If neither, the server is not on this
 * machine at all and the credentials being valid says nothing about where to
 * reach it.
 *
 * The paths are the ones shared hosts actually use. Guessing
 * /var/lib/mysql/mysql.sock because it is the common one is how the previous
 * attempt failed; this looks instead of guessing.
 *
 * This probe exists because of one deployment where every guess cost a full
 * container build to disprove: `127.0.0.1` refused, the socket path the server
 * itself reported did not exist, and the host's public address refused too —
 * each answer arriving twenty seconds and one deploy later. Enumerating every
 * candidate in a single run, inside the network namespace that actually
 * matters, replaces that loop with one command.
 */
const SOCKET_CANDIDATES: readonly string[] = [
  "/var/lib/mysql/mysql.sock",
  "/var/run/mysqld/mysqld.sock",
  "/run/mysqld/mysqld.sock",
  "/tmp/mysql.sock",
  "/opt/cpanel/mysql/var/lib/mysql/mysql.sock",
  "/var/lib/mysql/mysql.sock.lock",
];

function tcpOpen(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Whether this process is inside a container, which changes what the answers
 * mean rather than merely being trivia.
 *
 * In a container `127.0.0.1` is the container, so it can never be the host's
 * database however the panel describes the deployment — and a unix socket on
 * the host is not in this filesystem at all, so no `DB_SOCKET` value can work.
 * Those two facts together produce `ECONNREFUSED` on every loopback address
 * AND `ENOENT` on the socket path the server itself reports, which reads like
 * a misconfiguration and is not one.
 */
function containerMarkers(): readonly string[] {
  const markers: string[] = [];
  if (existsSync("/.dockerenv")) markers.push("/.dockerenv exists");
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    for (const needle of ["docker", "containerd", "kubepods", "lxc"]) {
      if (cgroup.includes(needle)) markers.push(`/proc/1/cgroup names ${needle}`);
    }
  } catch {
    // Not Linux, or not readable. Absence is not evidence either way.
  }
  return markers;
}

/**
 * This container's default gateway — which is the host, seen from inside a
 * bridge network, and therefore the first address worth trying.
 *
 * Read from `/proc/net/route` rather than by shelling out to `ip`, because a
 * slim base image such as `node:24` does not ship iproute2 and the whole point
 * of this probe is to work where nothing else is installed. The gateway field
 * is little-endian hex, hence the byte order below.
 */
function defaultGateway(): string | null {
  try {
    const lines = readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      const destination = fields[1];
      const gateway = fields[2];
      if (destination !== "00000000" || !gateway) continue;
      const packed = Number.parseInt(gateway, 16);
      if (!Number.isFinite(packed) || packed === 0) continue;
      return [
        packed & 0xff,
        (packed >> 8) & 0xff,
        (packed >> 16) & 0xff,
        (packed >> 24) & 0xff,
      ].join(".");
    }
  } catch {
    // Not Linux.
  }
  return null;
}

async function probe(): Promise<void> {
  console.error("");
  console.error("Looking for the server, from THIS process's point of view:");

  const markers = containerMarkers();
  if (markers.length > 0) {
    console.error("");
    console.error("  This process is inside a CONTAINER:");
    for (const marker of markers) console.error(`    ${marker}`);
    console.error("");
    console.error("    So 127.0.0.1 is this container, not the host, and a unix");
    console.error("    socket on the host is not in this filesystem. Neither can");
    console.error("    work here however the database is configured.");
  }

  const found = SOCKET_CANDIDATES.filter((candidate) => existsSync(candidate));
  console.error("");
  if (found.length > 0) {
    console.error("  Socket file(s) that DO exist here:");
    for (const candidate of found) console.error(`    ${candidate}`);
    console.error("");
    console.error(`  Set DB_SOCKET to one of those. Most likely: ${found[0] ?? ""}`);
  } else {
    console.error("  No socket file at any of the usual paths.");
  }

  // Every address worth trying, in the order a human should try them, with the
  // reason attached — an open port is only useful alongside what to set.
  const candidates = new Map<string, string>();
  if (env.db.host) candidates.set(env.db.host, "DB_HOST, as currently configured");
  const gateway = defaultGateway();
  if (gateway) candidates.set(gateway, "this container's default gateway (the host)");
  candidates.set("172.17.0.1", "Docker's default bridge gateway");
  try {
    const resolved = await lookup("host.docker.internal");
    candidates.set(resolved.address, "host.docker.internal");
  } catch {
    // Only present when the runtime adds it; its absence is informative, not
    // an error.
  }
  candidates.set("127.0.0.1", "loopback (this machine, or this container)");

  console.error("");
  console.error(`  TCP port ${String(env.db.port)}, by address:`);
  const reachable: string[] = [];
  for (const [host, why] of candidates) {
    const open = await tcpOpen(host, env.db.port);
    if (open) reachable.push(host);
    console.error(`    ${open ? "OPEN  " : "closed"}  ${host.padEnd(16)} ${why}`);
  }

  console.error("");
  if (reachable.length > 0) {
    console.error(`  Set DB_HOST=${reachable[0] ?? ""} and leave DB_SOCKET empty.`);
    console.error("");
    console.error("  If that then reports access denied, the address was right and");
    console.error("  the grant is not: a connection from here is a REMOTE one, so");
    console.error("  the user needs access from this address. On cPanel that is");
    console.error("  Remote MySQL, per address.");
  } else {
    console.error("  Nothing answered on any address, so the database is not");
    console.error("  reachable from this network namespace at all. Credentials");
    console.error("  being valid says nothing about where the server is.");
    console.error("");
    console.error("  If this is a container, the deployment has to connect the two:");
    console.error("    - run the database as a service on the same container network");
    console.error("      and use its service name as DB_HOST, or");
    console.error("    - allow the container's subnet through the host firewall AND");
    console.error("      grant the user access from it, or");
    console.error("    - mount the host's socket directory into the container.");
    console.error("");
    console.error("  A port open to the public internet but refused from here is a");
    console.error("  firewall rule or an egress block, not a wrong address.");
  }
}

function target(): string {
  return env.db.socket
    ? `socket ${env.db.socket}`
    : `${env.db.host}:${String(env.db.port)}`;
}

async function main(): Promise<number> {
  // Printed before connecting, because half the time the answer is visible
  // here: a default that was never overridden.
  console.log(`database : ${env.db.database}`);
  console.log(`user     : ${env.db.user || "(not set)"}`);
  console.log(`target   : ${target()}`);
  console.log(`pool     : ${String(env.db.connectionLimit)} per process`);

  // Which files these values could have come from, because "the credentials
  // are correct" and "this process can see them" are different claims and the
  // gap between them is most of the confusion on this deployment.
  //
  // All three are listed whether or not this run loaded them, because the
  // precedence is the trap: `next build` reads `.env.production.local` (only
  // when NODE_ENV=production, so never `next dev`), then `.env.local`, then
  // `.env`. The npm scripts read `.env` and `.env.local` only, and the
  // `:remote` variants read `.env.production.local` alone. A deploy panel's
  // own environment screen is a fourth source that no file records.
  const roots = [".env", ".env.local", ".env.production.local"].map((name) => ({
    name,
    present: existsSync(path.join(process.cwd(), name)),
  }));
  console.log(
    `env files: ${roots.map((f) => `${f.name} ${f.present ? "found" : "absent"}`).join(", ")}`,
  );
  console.log("");

  const missing = envProblems;
  if (missing.length > 0) {
    console.error("Environment is incomplete:");
    for (const problem of missing) console.error(`  - ${problem}`);
    console.error("");
    console.error(
      "`next build` reads these from the application root. Variables set in a " +
        "hosting panel — cPanel's Node.js app screen, or a container " +
        "platform's environment tab — belong to the process that panel " +
        "starts, and are NOT exported into your shell or into a build run " +
        "somewhere else. A value being correct on the server says nothing " +
        "about this process being able to see it.",
    );
    return 1;
  }

  try {
    const version = await sql<{ v: string }>`SELECT VERSION() AS v`.execute(getDb());
    console.log(`connected: ${version.rows[0]?.v ?? "unknown"}`);
  } catch (error) {
    const { summary, fix } = diagnose(error);
    console.error(`FAILED: ${summary}`);
    console.error("");
    for (const line of fix) console.error(line);
    await probe();
    return 1;
  }

  // Connecting is necessary and not sufficient. A build against an empty
  // database succeeds and ships a homepage with no content, which is the
  // quieter and worse failure of the two.
  try {
    const counts = await sql<{ status: string; n: number }>`
      SELECT status, COUNT(*) AS n FROM content_items GROUP BY status
    `.execute(getDb());

    if (counts.rows.length === 0) {
      console.log("");
      console.log("WARNING: content_items is empty.");
      console.log(
        "A build against this database produces a site with empty sections " +
          "and no error. Run `npm run migrate` if the tables are missing, " +
          "then `npm run seed:content`.",
      );
      return 1;
    }

    console.log("");
    for (const row of counts.rows) {
      console.log(`${row.status.padEnd(10)} ${String(row.n)}`);
    }

    const live = counts.rows.find((row) => row.status === "published");
    if (!live || Number(live.n) === 0) {
      console.log("");
      console.log("WARNING: nothing is published, so every section will render empty.");
      return 1;
    }
  } catch (error) {
    const { summary, fix } = diagnose(error);
    console.error("");
    console.error(`Connected, but reading content_items failed: ${summary}`);
    for (const line of fix) console.error(line);
    console.error("Has `npm run migrate` been run against this database?");
    return 1;
  }

  console.log("");
  console.log("OK — this machine can build the public pages.");
  return 0;
}

main()
  .then(async (code) => {
    await closePool();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error);
    await closePool();
    process.exit(1);
  });
