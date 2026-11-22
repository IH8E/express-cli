import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLimit } from "./limits.js";

const opts = { fallback: 20, max: 1000 };

test("parseLimit: absent or empty falls back to the default", () => {
  assert.equal(parseLimit(undefined, opts), 20);
  assert.equal(parseLimit("", opts), 20);
});

test("parseLimit: a plain number passes through", () => {
  assert.equal(parseLimit("1", opts), 1);
  assert.equal(parseLimit(" 250 ", opts), 250);
  assert.equal(parseLimit("1000", opts), 1000);
});

test("parseLimit: -1 is rejected instead of hanging the request", () => {
  // This used to go straight through to the server and time out.
  assert.throws(() => parseLimit("-1", opts), /whole number between 1 and 1000/);
});

test("parseLimit: 0 is rejected instead of silently becoming the default", () => {
  assert.throws(() => parseLimit("0", opts), /at least 1/);
});

test("parseLimit: garbage is rejected instead of silently becoming the default", () => {
  assert.throws(() => parseLimit("abc", opts), /whole number/);
  assert.throws(() => parseLimit("1.5", opts), /whole number/);
  assert.throws(() => parseLimit("1e3", opts), /whole number/);
});

test("parseLimit: above the cap is rejected with the cap in the message", () => {
  assert.throws(() => parseLimit("1001", opts), /at most 1000/);
  assert.throws(() => parseLimit("99999", opts), /at most 1000/);
});
