import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the `conf` store before anything imports it.
process.env.EXPRESS_CLI_CONFIG_DIR = mkdtempSync(join(tmpdir(), "express-cli-counters-test-"));
process.env.EXPRESS_HOST = "test.invalid";

const { ThreadCounters } = await import("./thread-counters.js");

/** Minimal stand-in for ExpressSession: it only needs to emit `activity`. */
function fakeSession(): EventEmitter & { emit: (e: string, ...a: unknown[]) => boolean } {
  return new EventEmitter() as never;
}

const push = (chatId: string, counters: Array<{ thread_id: string; counter: number }>) => ({
  topic: `groupchat:${chatId}`,
  event: "thread_counter_updated",
  payload: { thread_counter: counters },
});

test("ThreadCounters records counters from a push", () => {
  const session = fakeSession();
  const counters = new ThreadCounters(session as never);
  session.emit("activity", push("chat-1", [{ thread_id: "t-1", counter: 3 }]));

  assert.equal(counters.get("chat-1", "t-1"), 3);
  assert.deepEqual(counters.forChat("chat-1"), { "t-1": 3 });
  counters.dispose();
});

test("ThreadCounters updates an existing thread counter", () => {
  const session = fakeSession();
  const counters = new ThreadCounters(session as never);
  session.emit("activity", push("chat-1", [{ thread_id: "t-1", counter: 3 }]));
  session.emit("activity", push("chat-1", [{ thread_id: "t-1", counter: 7 }]));

  assert.equal(counters.get("chat-1", "t-1"), 7, "the newer push wins");
  counters.dispose();
});

test("ThreadCounters keeps chats apart", () => {
  const session = fakeSession();
  const counters = new ThreadCounters(session as never);
  session.emit("activity", push("chat-1", [{ thread_id: "t-1", counter: 2 }]));
  session.emit("activity", push("chat-2", [{ thread_id: "t-1", counter: 9 }]));

  assert.equal(counters.get("chat-1", "t-1"), 2);
  assert.equal(counters.get("chat-2", "t-1"), 9);
  counters.dispose();
});

test("ThreadCounters ignores unrelated events and malformed topics", () => {
  const session = fakeSession();
  const counters = new ThreadCounters(session as never);
  session.emit("activity", { topic: "groupchat:chat-1", event: "message_new", payload: {} });
  session.emit("activity", { topic: "system", event: "thread_counter_updated", payload: { thread_counter: [{ thread_id: "t-1", counter: 5 }] } });
  session.emit("activity", { topic: "groupchat:chat-1", event: "thread_counter_updated", payload: { thread_counter: [] } });

  assert.equal(counters.get("chat-1", "t-1"), undefined, "nothing valid arrived");
  assert.deepEqual(counters.forChat("chat-1"), {});
  counters.dispose();
});

test("dispose stops listening", () => {
  const session = fakeSession();
  const counters = new ThreadCounters(session as never);
  session.emit("activity", push("chat-1", [{ thread_id: "t-1", counter: 1 }]));
  counters.dispose();
  session.emit("activity", push("chat-1", [{ thread_id: "t-1", counter: 99 }]));

  assert.equal(counters.get("chat-1", "t-1"), undefined, "no updates after dispose");
});
