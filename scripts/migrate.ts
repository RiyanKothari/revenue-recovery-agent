/**
 * Applies the schema for whichever database DATABASE_URL points at.
 *
 *   npm run db:migrate
 *
 * Exists because there is no reason to require a psql or mysql client just to
 * create seven tables — the drivers are already a dependency, and a hosted
 * SQL editor isn't available for a local container. Safe to re-run: the
 * Postgres schema is written with `if not exists`, and the MySQL path
 * tolerates "already exists" errors for the same reason.
 */

import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./load-env";
import { resolveDriver } from "../lib/db";

loadEnv();

/** MySQL cannot say `create index if not exists`, so re-runs hit these. */
const MYSQL_ALREADY_EXISTS = new Set([
  1050, // ER_TABLE_EXISTS_ERROR
  1061, // ER_DUP_KEYNAME
  1826, // ER_FK_DUP_NAME
]);

/**
 * Splits on statement boundaries after stripping line comments. The schema
 * files contain no semicolons inside string literals, which is what makes
 * this safe here — it is not a general-purpose SQL parser.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function migratePostgres(url: string, sql: string) {
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    // node-postgres runs a multi-statement string in one go via the simple
    // query protocol, and the whole file is idempotent.
    await client.query(sql);
    console.log("  applied schema (single transaction-free batch)");
  } finally {
    await client.end();
  }
}

async function migrateMysql(url: string, sql: string) {
  const mysql = (await import("mysql2/promise")).default;
  const connection = await mysql.createConnection({
    uri: url,
    multipleStatements: true,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  });

  try {
    let applied = 0;
    let skipped = 0;

    for (const statement of splitStatements(sql)) {
      try {
        await connection.query(statement);
        applied += 1;
      } catch (err: any) {
        if (MYSQL_ALREADY_EXISTS.has(err?.errno)) {
          skipped += 1;
          continue;
        }
        throw new Error(`${err?.message}\n  in statement: ${statement.slice(0, 120)}...`);
      }
    }

    console.log(`  applied ${applied} statements, skipped ${skipped} already present`);
  } finally {
    await connection.end();
  }
}

async function main() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Put a postgres:// or mysql:// connection string in .env.local — see docs/SETUP.md."
    );
  }

  const driver = resolveDriver(url, process.env.DATABASE_DRIVER);
  const file = path.resolve(process.cwd(), `db/schema.${driver}.sql`);

  if (!fs.existsSync(file)) {
    throw new Error(`No schema file at ${file}`);
  }

  const sql = fs.readFileSync(file, "utf8");

  console.log(`Applying db/schema.${driver}.sql`);
  // Host only — never print the credentials embedded in the URL.
  console.log(`  target: ${new URL(url).host}\n`);

  if (driver === "mysql") {
    await migrateMysql(url, sql);
  } else {
    await migratePostgres(url, sql);
  }

  console.log("\nDone. Verify with: npm run preflight database");
}

main().catch((err) => {
  console.error("\nMigration failed:", err?.message ?? err);
  process.exit(1);
});
