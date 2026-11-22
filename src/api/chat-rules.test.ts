import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the `conf` store before anything imports it.
process.env.EXPRESS_CLI_CONFIG_DIR = mkdtempSync(join(tmpdir(), "express-cli-rules-test-"));
process.env.EXPRESS_HOST = "test.invalid";

const { getChatRules } = await import("./chat-rules.js");

const responder = (rules: unknown) =>
  (async () => ({ rules })) as never;

test("getChatRules separates size limits from blocked extensions", async () => {
  const rules = await getChatRules({
    chatId: "c1",
    request: responder([
      { action: "upload", rule_meta: { file_size: 25, content_type: "document" } },
      { action: "upload", rule_meta: { file_size: 5, content_type: "image" } },
      { action: "upload", rule_meta: { file_size: 0, content_type: "document", file_ext: ["exe", "dll"] } },
    ]),
  });
  assert.deepEqual(rules.uploadLimits, [
    { content_type: "document", file_size_mb: 25 },
    { content_type: "image", file_size_mb: 5 },
  ]);
  assert.deepEqual(rules.blockedExtensions, ["dll", "exe"]);
});

test("a file_size 0 rule with file_ext is a denial, not a zero limit", async () => {
  const rules = await getChatRules({
    chatId: "c1",
    request: responder([
      { action: "upload", rule_meta: { file_size: 0, content_type: "document", file_ext: ["bat"] } },
    ]),
  });
  assert.deepEqual(rules.uploadLimits, [], "no 0 MB limit is reported as a usable cap");
  assert.deepEqual(rules.blockedExtensions, ["bat"]);
});

test("non-upload rules are ignored", async () => {
  const rules = await getChatRules({
    chatId: "c1",
    request: responder([
      { action: "pin", rule_meta: { file_size: 1, content_type: "document" } },
      { action: "upload", rule_meta: { file_size: 10, content_type: "document" } },
    ]),
  });
  assert.deepEqual(rules.uploadLimits, [{ content_type: "document", file_size_mb: 10 }]);
});

test("an empty rules list yields no limits, not an error", async () => {
  const rules = await getChatRules({ chatId: "c1", request: responder([]) });
  assert.deepEqual(rules, { uploadLimits: [], blockedExtensions: [] });
});

test("extension duplicates across rules collapse, case-insensitively", async () => {
  const rules = await getChatRules({
    chatId: "c1",
    request: responder([
      { action: "upload", rule_meta: { file_size: 0, file_ext: ["EXE", "exe"] } },
      { action: "upload", rule_meta: { file_size: 0, file_ext: ["Exe", "js"] } },
    ]),
  });
  assert.deepEqual(rules.blockedExtensions, ["exe", "js"]);
});
