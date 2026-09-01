import type { RecoveryDb } from "./types";
import { createPostgresDb } from "./postgres";
import { createMysqlDb } from "./mysql";

export type { RecoveryDb } from "./types";
export * from "./types";

/**
 * Picks the database implementation from the environment.
 *
 * Razorpay's published stack runs MySQL historically and PostgreSQL / Aurora
 * PostgreSQL for newer transactional systems, so this pipeline runs on either
 * rather than picking a side. Nothing above this module knows which one is
 * in use — the whole difference is confined to two files behind one
 * interface.
 *
 *   DATABASE_DRIVER=postgres   DATABASE_URL=postgres://...
 *   DATABASE_DRIVER=mysql      DATABASE_URL=mysql://...
 *
 * The driver is inferred from the URL scheme when not stated, so a correct
 * connection string alone is enough.
 *
 * Built lazily on first use. Constructing a pool at module scope would make
 * importing anything that touches the database fail without configuration —
 * which is what previously made the safety rules impossible to test and
 * forced `next build` to be fed placeholder credentials.
 */

let instance: RecoveryDb | null = null;

export function resolveDriver(url: string | undefined, explicit?: string): "postgres" | "mysql" {
  const stated = explicit?.trim().toLowerCase();
  if (stated === "postgres" || stated === "postgresql") return "postgres";
  if (stated === "mysql" || stated === "tidb") return "mysql";

  if (url?.startsWith("mysql://")) return "mysql";
  if (url?.startsWith("postgres://") || url?.startsWith("postgresql://")) return "postgres";

  // Postgres is the default: it is what Razorpay uses for newer transactional
  // systems, and what this project's reference schema targets.
  return "postgres";
}

export function getDb(): RecoveryDb {
  if (instance) return instance;

  const url = process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      "Missing DATABASE_URL. Set a postgres:// or mysql:// connection string in .env.local — see docs/SETUP.md."
    );
  }

  const driver = resolveDriver(url, process.env.DATABASE_DRIVER);

  // Statically imported, not require()'d. An earlier version lazily required
  // only the driver in use, to avoid loading the other one's package. That
  // works under tsx's CommonJS interop — all the tests passed — and breaks
  // inside Next's webpack bundle, where require() on an ES module does not
  // hand back the named exports: `createPostgresDb is not a function`, at
  // runtime, on the first webhook.
  //
  // Importing both costs nothing that matters. Neither driver opens a
  // connection at import time, and the laziness worth having — not building
  // a pool until something actually queries — is the `instance` cache below.
  instance = driver === "mysql" ? createMysqlDb(url) : createPostgresDb(url);

  return instance;
}

/** Test seam — lets a suite substitute a fake without touching the environment. */
export function setDb(db: RecoveryDb | null) {
  instance = db;
}
