import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldForceColour } from "./colour.js";

test("forces truecolor when stdout is a terminal and nothing is set", () => {
  assert.equal(shouldForceColour({}, true), true);
});

test("respects an explicit FORCE_COLOR from the user", () => {
  assert.equal(shouldForceColour({ FORCE_COLOR: "1" }, true), false, "a user choice of 256 colours is kept");
  assert.equal(shouldForceColour({ FORCE_COLOR: "3" }, true), false);
});

test("treats FORCE_COLOR=0 as undecided rather than a request for no colour", () => {
  // chalk reads 0 as "no colour"; the TUI wants pixels, so it upgrades it.
  assert.equal(shouldForceColour({ FORCE_COLOR: "0" }, true), true);
});

test("does not force colour into a pipe or file redirect", () => {
  assert.equal(shouldForceColour({}, false), false);
  assert.equal(shouldForceColour({ FORCE_COLOR: "0" }, false), false);
});
