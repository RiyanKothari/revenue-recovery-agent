import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "../scripts/load-env";

/**
 * Secrets go through this parser, so its edge cases matter: a base64 token
 * ending in '=', a webhook secret containing '#', a quoted value. Getting
 * any of them wrong produces an authentication failure that looks like a
 * wrong key rather than a mangled one.
 */

function withEnvFile(contents: string, run: (file: string) => void) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "rr-env-")),
    ".env.local"
  );
  fs.writeFileSync(file, contents, "utf8");
  try {
    run(file);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

function clear(...keys: string[]) {
  for (const k of keys) delete process.env[k];
}

test("loads plain key=value pairs", () => {
  clear("RR_TEST_PLAIN");
  withEnvFile("RR_TEST_PLAIN=hello\n", (file) => {
    assert.equal(loadEnv(file), true);
    assert.equal(process.env.RR_TEST_PLAIN, "hello");
  });
  clear("RR_TEST_PLAIN");
});

test("ignores comments and blank lines", () => {
  clear("RR_TEST_AFTER_COMMENT");
  withEnvFile("# a comment\n\n  \nRR_TEST_AFTER_COMMENT=value\n", (file) => {
    loadEnv(file);
    assert.equal(process.env.RR_TEST_AFTER_COMMENT, "value");
  });
  clear("RR_TEST_AFTER_COMMENT");
});

test("strips surrounding quotes without touching the inside", () => {
  clear("RR_TEST_QUOTED", "RR_TEST_SINGLE");
  withEnvFile(`RR_TEST_QUOTED="a b c"\nRR_TEST_SINGLE='x y'\n`, (file) => {
    loadEnv(file);
    assert.equal(process.env.RR_TEST_QUOTED, "a b c");
    assert.equal(process.env.RR_TEST_SINGLE, "x y");
  });
  clear("RR_TEST_QUOTED", "RR_TEST_SINGLE");
});

test("preserves '=' padding in a base64 token", () => {
  // RAZORPAY_MCP_MERCHANT_TOKEN is base64 and routinely ends in '='.
  clear("RR_TEST_B64");
  withEnvFile("RR_TEST_B64=cnpwX3Rlc3Q6c2VjcmV0==\n", (file) => {
    loadEnv(file);
    assert.equal(process.env.RR_TEST_B64, "cnpwX3Rlc3Q6c2VjcmV0==");
  });
  clear("RR_TEST_B64");
});

test("preserves a '#' inside a value", () => {
  // Naive parsers strip everything after '#' as a trailing comment and
  // silently truncate the secret.
  clear("RR_TEST_HASH");
  withEnvFile("RR_TEST_HASH=se#cret\n", (file) => {
    loadEnv(file);
    assert.equal(process.env.RR_TEST_HASH, "se#cret");
  });
  clear("RR_TEST_HASH");
});

test("an existing environment variable wins over the file", () => {
  // So a shell override or CI secret is never silently replaced.
  process.env.RR_TEST_PRECEDENCE = "from-shell";
  withEnvFile("RR_TEST_PRECEDENCE=from-file\n", (file) => {
    loadEnv(file);
    assert.equal(process.env.RR_TEST_PRECEDENCE, "from-shell");
  });
  clear("RR_TEST_PRECEDENCE");
});

test("handles an export prefix", () => {
  clear("RR_TEST_EXPORTED");
  withEnvFile("export RR_TEST_EXPORTED=yes\n", (file) => {
    loadEnv(file);
    assert.equal(process.env.RR_TEST_EXPORTED, "yes");
  });
  clear("RR_TEST_EXPORTED");
});

test("returns false when the file does not exist", () => {
  assert.equal(loadEnv(path.join(os.tmpdir(), "definitely-not-here-.env.local")), false);
});
