import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the `conf` store before anything imports it.
process.env.EXPRESS_CLI_CONFIG_DIR = mkdtempSync(join(tmpdir(), "express-cli-history-test-"));
process.env.EXPRESS_HOST = "test.invalid";

const { getMessageInfo, getCommonChats } = await import("./history.js");

const chat = (id: string, name?: string, members?: number) =>
  ({ group_chat_id: id, name, chat_type: "group_chat", members_count: members }) as never;

test("getCommonChats accepts a bare list of chat ids and resolves names", async () => {
    const chats = await getCommonChats({
      client: {} as never,
      userHuid: "user-huid",
      request: (async () => ({ common_chats: ["aaaaaaaa-1111-5111-8111-111111111111"] })) as never,
      listChats: (async () => [chat("aaaaaaaa-1111-5111-8111-111111111111", "шара", 2)]) as never,
    });
    assert.equal(chats.length, 1);
    assert.equal(chats[0].chat_id, "aaaaaaaa-1111-5111-8111-111111111111");
    assert.equal(chats[0].name, "шара");
    assert.equal(chats[0].members, 2);
});

test("getCommonChats keeps ids it cannot name instead of dropping them", async () => {
    const chats = await getCommonChats({
      client: {} as never,
      userHuid: "user-huid",
      request: (async () => ({ common_chats: ["bbbbbbbb-1111-5111-8111-111111111111"] })) as never,
      listChats: (async () => []) as never,
    });
    assert.equal(chats.length, 1, "an unknown chat is still a real shared chat");
    assert.equal(chats[0].name, undefined);
});

test("getCommonChats returns an empty list when there is nothing in common", async () => {
    const chats = await getCommonChats({
      client: {} as never,
      userHuid: "x",
      request: (async () => ({ common_chats: [] })) as never,
      listChats: (async () => []) as never,
    });
    assert.deepEqual(chats, []);
});

test("getMessageInfo preserves the caller's order and drops unknown ids", async () => {
    const out = await getMessageInfo({
      client: {} as never,
      chatId: "chat",
      syncIds: ["id-1", "id-2", "id-missing"],
      request: (async () => ({
        info: [
          { sync_id: "id-2", event_type: "message_new", inserted_at: "2026-01-02T00:00:00Z", edited_at: "2026-01-03T00:00:00Z", version: 2 },
          { sync_id: "id-1", event_type: "message_new", inserted_at: "2026-01-01T00:00:00Z" },
        ],
      })) as never,
      decrypt: (async (events: Array<{ sync_id: string }>) =>
        events.map((e) => ({ sync_id: e.sync_id, body: `body-of-${e.sync_id}`, decrypted: true }))) as never,
      loadKeys: (() => ({ signingKey: {}, encryptionKey: { keyId: "k", privateKey: "", publicKey: "" }, serverPublicKey: "", serverPublicKeyId: "x" })) as never,
    });
    assert.deepEqual(out.map((m) => m.sync_id), ["id-1", "id-2"]);
    assert.equal(out[0].body, "body-of-id-1");
    assert.equal(out[1].edited_at, "2026-01-03T00:00:00Z");
    assert.equal(out[1].version, 2);
});

test("getMessageInfo surfaces an undecryptable revision instead of hiding it", async () => {
    const out = await getMessageInfo({
      client: {} as never,
      chatId: "chat",
      syncIds: ["id-1"],
      request: (async () => ({
        info: [{ sync_id: "id-1", event_type: "message_new", inserted_at: "2026-01-01T00:00:00Z" }],
      })) as never,
      decrypt: (async () => ([{ sync_id: "id-1", body: "", decrypted: false, error: "key not for us" }])) as never,
      loadKeys: (() => ({ signingKey: {}, encryptionKey: { keyId: "k", privateKey: "", publicKey: "" }, serverPublicKey: "", serverPublicKeyId: "x" })) as never,
    });
    assert.equal(out[0].decrypted, false);
    assert.equal(out[0].error, "key not for us");
});
