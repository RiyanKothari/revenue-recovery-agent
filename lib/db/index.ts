import type { RecoveryDb } from "./types";

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

  // Required lazily so the unused driver's package is never loaded.
  if (driver === "mysql") {
    const { createMysqlDb } = require("./mysql") as typeof import("./mysql");
    instance = createMysqlDb(url);
  } else {
    const { createPostgresDb } = require("./postgres") as typeof import("./postgres");
    instance = createPostgresDb(url);
  }

  return instance;
}

/** Test seam — lets a suite substitute a fake without touching the environment. */
export function setDb(db: RecoveryDb | null) {
  instance = db;
}
