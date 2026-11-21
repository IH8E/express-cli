import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExpressProfile } from "../types/index.js";

// Isolate the `conf` store BEFORE anything imports it: without this the chat lookup
// picks up the developer's real token/keys and escapes to the live network.
process.env.EXPRESS_CLI_CONFIG_DIR = mkdtempSync(join(tmpdir(), "express-cli-resolve-test-"));
process.env.EXPRESS_HOST = "test.invalid";

const { pickContact, resolveChat } = await import("./resolve.js");

const person = (name: string, email: string, user_huid: string) => ({ name, email, user_huid }) as ExpressProfile;
const borisovs = [
  person("Борисов Игорь Васильевич", "ivborisov@alfabank.ru", "h1"),
  person("Борисов Игорь Валерьевич", "ivborisov2@alfabank.ru", "h2"),
];

test("pickContact: exact full name wins over namesakes (WISHLIST #16)", () => {
  assert.equal(pickContact("борисов игорь валерьевич", borisovs).user_huid, "h2");
});

test("pickContact: exact email wins", () => {
  assert.equal(pickContact("IVBorisov@alfabank.ru", borisovs).user_huid, "h1");
});

test("pickContact: partial name with namesakes is still ambiguous", () => {
  assert.throws(() => pickContact("Борисов Игорь", borisovs), /multiple contacts[\s\S]*h1[\s\S]*h2/);
});

test("pickContact: nothing found", () => {
  assert.throws(() => pickContact("Никто", []), /No chat or contact/);
});

// ── resolveChat: a bare UUID stays a chat/thread id, not a phantom person ────────
// Threads have no profile and are absent from chat_list, so resolveChat must pass a
// UUID through untouched; the send/read layer (getChatKeyIds) is what tells a chat
// from a thread and rejects a bogus id with a precise error.

const stub = (chats: Array<{ group_chat_id: string }>, profiles: unknown[] = []) => ({
  get: async (path: string) => {
    if (path.includes("corporate_directory/entries")) {
      return { entries: chats.map((c) => ({ entry_type: "chat", deleted: false, entry_id: c.group_chat_id })) };
    }
    return {};
  },
  post: async (path: string) => {
    if (path.includes("cts_profiles/query")) return profiles.length ? [{ cts_profiles: profiles }] : undefined;
    if (path.includes("profiles/query")) return { profiles: [] };
    if (path.includes("open_chats_list")) return { open_chats: chats };
    return undefined;
  },
  rawRequest: async () => undefined,
}) as never;

test("resolveChat: a UUID without a profile passes through as chat_id", async () => {
  const client = stub([]);
  const id = "aaaaaaaa-0000-5000-8000-000000000001";
  const r = await resolveChat(client, id);
  assert.equal(r.chatId, id);
});

test("resolveChat: a person's huid resolves to their name, not to the raw id", async () => {
  const client = stub([], [person("Иванов Иван Иванович", "", "cccccccc-1111-5111-8111-111111111111")]);
  const r = await resolveChat(client, "cccccccc-1111-5111-8111-111111111111", { create: false });
  assert.equal(r.userHuid, "cccccccc-1111-5111-8111-111111111111");
  assert.equal(r.name, "Иванов Иван Иванович");
  assert.equal(r.chatId, null, "no DM yet — dry_run must not invent a chat_id");
});

test("resolveChat: an 8-char id prefix matches a chat whose full id starts with it", async () => {
  const id = "dddddddd-1111-5111-8111-111111111111";
  const client = stub([{ group_chat_id: id }]);
  const r = await resolveChat(client, "dddddddd");
  assert.equal(r.chatId, id);
});

test("resolveChat: an ambiguous id prefix lists candidates instead of guessing", async () => {
  const client = stub([
    { group_chat_id: "dddddddd-0000-5000-8000-000000000001" },
    { group_chat_id: "dddddddd-0000-5000-8000-000000000002" },
  ]);
  await assert.rejects(() => resolveChat(client, "dddddddd"), /Multiple chats start with/);
});

test("resolveChat: an unknown prefix falls through to a clear not-found error", async () => {
  const client = stub([{ group_chat_id: "bbbbbbbb-0000-5000-8000-000000000001" }]);
  await assert.rejects(() => resolveChat(client, "deadbeef"), /No chat or contact found matching/);
});
