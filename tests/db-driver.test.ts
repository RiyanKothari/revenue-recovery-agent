import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDriver } from "../lib/db";

/**
 * Picking the wrong driver fails in a confusing way — the client connects on
 * the wrong protocol and reports a parse error rather than "wrong database".
 * Inference from the URL scheme is what makes a correct connection string
 * sufficient on its own.
 */

test("infers postgres from the URL scheme", () => {
  assert.equal(
    resolveDriver("postgresql://user:pw@db.example.com:5432/postgres"),
    "postgres"
  );
  assert.equal(resolveDriver("postgres://user:pw@localhost:5432/app"), "postgres");
});

test("infers mysql from the URL scheme", () => {
  assert.equal(
    resolveDriver("mysql://user:pw@gateway.tidbcloud.com:4000/revenue_recovery"),
    "mysql"
  );
});

test("an explicit driver overrides the scheme", () => {
  // Some managed MySQL hosts hand out non-standard URIs.
  assert.equal(resolveDriver("postgres://host/db", "mysql"), "mysql");
  assert.equal(resolveDriver("mysql://host/db", "postgres"), "postgres");
});

test("treats tidb as mysql", () => {
  // TiDB speaks the MySQL wire protocol.
  assert.equal(resolveDriver(undefined, "tidb"), "mysql");
});

test("accepts postgresql as a spelling of postgres", () => {
  assert.equal(resolveDriver(undefined, "postgresql"), "postgres");
});

test("ignores case and surrounding whitespace in the override", () => {
  assert.equal(resolveDriver("mysql://host/db", "  Postgres  "), "postgres");
});

test("defaults to postgres for an unrecognised URL", () => {
  // Postgres is what Razorpay uses for newer transactional systems, and what
  // the reference schema targets.
  assert.equal(resolveDriver(undefined), "postgres");
  assert.equal(resolveDriver("something-odd"), "postgres");
});
