import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the `conf` store before anything imports it.
process.env.EXPRESS_CLI_CONFIG_DIR = mkdtempSync(join(tmpdir(), "express-cli-changes-test-"));
process.env.EXPRESS_HOST = "test.invalid";

const { getChatListChanges } = await import("./chat-changes.js");

/** Records what the function asked for and answers per event. */
function recorder(answers: Record<string, unknown>) {
  const calls: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const request = (async (params: { event: string; payload: Record<string, unknown> }) => {
    calls.push({ event: params.event, payload: params.payload });
    return answers[params.event] ?? {};
  }) as never;
  return { request, calls };
}

test("getChatListChanges asks both cursors with their request versions", async () => {
  const { request, calls } = recorder({});
  await getChatListChanges({ since: "2026-01-01T00:00:00Z", request });

  const base = calls.find((c) => c.event === "get_chat_list_base_changes");
  const frequent = calls.find((c) => c.event === "get_chat_list_frequent_changes");
  assert.ok(base && frequent, "both deltas are requested");
  assert.equal(base.payload.since, "2026-01-01T00:00:00Z");
  assert.equal(base.payload.request_version, 6, "base uses request_version 6");
  assert.equal(frequent.payload.request_version, 4, "frequent uses request_version 4");
});

test("getChatListChanges merges both payloads and prefers the newer generated_at", async () => {
  const { request } = recorder({
    get_chat_list_base_changes: { get_chat_list_base_changes: [{ group_chat_id: "a" }], generated_at: "2026-01-01T00:00:00Z" },
    get_chat_list_frequent_changes: { get_chat_list_frequent_changes: [{ group_chat_id: "a", has_delayed_messages: true }], generated_at: "2026-01-01T00:00:05Z" },
  });
  const out = await getChatListChanges({ since: "2026-01-01T00:00:00Z", request });
  assert.equal(out.base.length, 1);
  assert.equal(out.frequent.length, 1);
  assert.equal(out.generated_at, "2026-01-01T00:00:05Z", "the frequent cursor is the newer one");
});

test("an empty response still yields a usable cursor", async () => {
  const { request } = recorder({
    get_chat_list_base_changes: { get_chat_list_base_changes: [], generated_at: "2026-01-01T10:00:00Z" },
    get_chat_list_frequent_changes: { get_chat_list_frequent_changes: [] },
  });
  const out = await getChatListChanges({ since: "2026-01-01T00:00:00Z", request });
  assert.deepEqual(out.base, []);
  assert.deepEqual(out.frequent, []);
  assert.equal(out.generated_at, "2026-01-01T10:00:00Z", "a caller can still advance its cursor");
});

test("a missing array in the response is treated as no changes", async () => {
  const { request } = recorder({});
  const out = await getChatListChanges({ since: "2026-01-01T00:00:00Z", request });
  assert.deepEqual(out.base, []);
  assert.deepEqual(out.frequent, []);
});
