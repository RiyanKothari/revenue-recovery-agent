import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeEventId } from "../lib/api-errors";

/**
 * The id in the URL is the only user-controlled input this API takes, and
 * passing an unchecked one to the database turned a bad link into a 500 that
 * named the engine and the column type.
 */

test("a real event id is accepted in either case", () => {
  assert.equal(looksLikeEventId("5733e1b1-d2e0-44c9-86cb-b835aaae31d8"), true);
  assert.equal(looksLikeEventId("5733E1B1-D2E0-44C9-86CB-B835AAAE31D8"), true);
});

test("anything the database could not cast is rejected before it is asked", () => {
  for (const bad of [
    "not-a-uuid",
    "",
    "1",
    "'; drop table revenue_events; --",
    "../../etc/passwd",
    "5733e1b1-d2e0-44c9-86cb",              // too short
    "5733e1b1-d2e0-44c9-86cb-b835aaae31d8x", // trailing junk
    "5733e1b1_d2e0_44c9_86cb_b835aaae31d8",  // wrong separators
    "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz",  // right shape, not hex
  ]) {
    assert.equal(looksLikeEventId(bad), false, `${JSON.stringify(bad)} should be rejected`);
  }
});

test("a stored id is not rejected for an unfashionable version nibble", () => {
  // A strict RFC 4122 version check would refuse ids the database is
  // perfectly happy to hold — worse than accepting one that is simply absent.
  assert.equal(looksLikeEventId("5733e1b1-d2e0-14c9-06cb-b835aaae31d8"), true);
});
