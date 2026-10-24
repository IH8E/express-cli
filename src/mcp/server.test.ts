import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the `conf` store at a throwaway directory before anything imports it,
// so tests never read/write the developer's real eXpress login/tokens.
const configDir = mkdtempSync(join(tmpdir(), "express-cli-test-"));
process.env.EXPRESS_CLI_CONFIG_DIR = configDir;

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { registerTools, Inbox } = await import("./server.js");const { buildQrMaterial } = await import("../auth/qr-login.js");

const EXPECTED_TOOLS = [
  "chats_list", "chats_find", "messages_list", "send_message", "contacts_search",
  "contacts_self", "wait_for_messages", "status", "auth_qr_start", "auth_qr_poll",
  "attachment_download", "thread_read",
];

async function connectedClient() {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, {
    session: () => null,
    inbox: new Inbox(),
    chatNames: new Map(),
    senderNames: new Map(),
    isSessionReady: () => false,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

after(() => { rmSync(configDir, { recursive: true, force: true }); });

test("registers all 12 tools with complete annotations", async () => {
  const { client } = await connectedClient();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
  for (const tool of tools) {
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      assert.equal(typeof tool.annotations?.[hint], "boolean", `${tool.name} is missing ${hint}`);
    }
    assert.ok(tool.inputSchema, `${tool.name} is missing an inputSchema`);
  }
});

test("read/write tools report not_authenticated without a stored token", async () => {
  const { client } = await connectedClient();
  const calls: Array<[string, Record<string, unknown>]> = [
    ["chats_list", {}],
    ["chats_find", { query: "alice" }],
    ["messages_list", { chat: "alice" }],
    ["send_message", { chat: "alice", text: "hi" }],
    ["contacts_search", { query: "alice" }],
    ["contacts_self", {}],
  ];
  for (const [name, args] of calls) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text: string }>)[0].text;
    assert.equal(JSON.parse(text).error, "not_authenticated", `${name} should require auth`);
  }
});

test("status reports unauthenticated state without touching the network", async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({ name: "status", arguments: {} });
  const text = (result.content as Array<{ text: string }>)[0].text;
  assert.deepEqual(JSON.parse(text).authenticated, false);
});

test("wait_for_messages reports session unavailable when there is no live session", async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({ name: "wait_for_messages", arguments: { timeout_seconds: 1 } });
  const text = (result.content as Array<{ text: string }>)[0].text;
  assert.equal(JSON.parse(text).error, "Session unavailable.");
});

test("auth_qr_poll reports no pending session before auth_qr_start has run", async () => {
  const { client } = await connectedClient();
  const result = await client.callTool({ name: "auth_qr_poll", arguments: {} });
  const text = (result.content as Array<{ text: string }>)[0].text;
  assert.match(text, /No pending QR session/);
});

test("sessionProvider comes up once apigw keys appear and re-keys after a new login (issue #1)", async () => {
  const { sessionProvider } = await import("./server.js");
  const { saveApigwKeys, generateSigningKeyPair, generateEncryptionKeyPair } = await import("../auth/keys.js");
  const { setApigwKeysRaw } = await import("../config/store.js");
  const login = () => saveApigwKeys({
    signingKey: generateSigningKeyPair(),
    encryptionKey: generateEncryptionKeyPair(),
    ctsKey: generateEncryptionKeyPair(),
    serverPublicKey: new Uint8Array(32),
    serverPublicKeyId: "server",
  });
  const prevHost = process.env.EXPRESS_HOST;
  process.env.EXPRESS_HOST = "express.example.com"; // ExpressSession needs a configured host
  const started: unknown[] = [];
  const session = sessionProvider((s) => started.push(s)); // no connect — offline
  try {
    assert.equal(session(), null);
    login();
    const first = session();
    assert.ok(first);
    assert.equal(session(), first);
    assert.equal(started.length, 1);
    login();
    const second = session();
    assert.ok(second);
    assert.notEqual(second, first);
    assert.equal(started.length, 2);
    setApigwKeysRaw(null);
    assert.equal(session(), null);
  } finally {
    setApigwKeysRaw(null);
    if (prevHost === undefined) delete process.env.EXPRESS_HOST;
    else process.env.EXPRESS_HOST = prevHost;
  }
});

test("Inbox buffers messages and hands out only what arrived since the last take", async () => {
  const inbox = new Inbox();
  const msg = (body: string) => ({ chatId: "c1", syncId: "s", sender: "u1", body, decrypted: true, insertedAt: new Date().toISOString() });

  inbox.add(msg("first"));
  const first = await inbox.take(50);
  assert.equal(first.length, 1);
  assert.equal(first[0].body, "first");

  const empty = await inbox.take(50);
  assert.equal(empty.length, 0);

  inbox.add(msg("second"));
  const second = await inbox.take(50);
  assert.equal(second.length, 1);
  assert.equal(second[0].body, "second");
  assert.equal(second[0].syncId, "s");
});

// The normalizer is the pure part of messages_list/wait_for_messages (WISHLIST #1,#4,#6,#7,#10).
test("makeNormalizer produces the uniform message shape: names, own flag, local time, mentions, sync_id", async () => {
  const { registerTools, Inbox, makeNormalizer } = await import("./server.js");
  void registerTools;

  const deps = {
    session: () => null,
    inbox: new Inbox(),
    chatNames: new Map([["chat-uuid-1", "Склянчук DM"]]),
    senderNames: new Map([
      ["11111111-1111-1111-1111-111111111111", "Комиссаров И."],
      ["22222222-2222-2222-2222-222222222222", "Павленко А."],
    ]),
    isSessionReady: () => false,
    selfHuid: () => "22222222-2222-2222-2222-222222222222",
    setSelfHuid: () => {},
  };
  void registerTools;
  const { normalize } = makeNormalizer(deps as Parameters<typeof makeNormalizer>[0]);

  const [mine, other, mention] = await normalize([
    {
      chatId: "chat-uuid-1", syncId: "sync-3", sender: "22222222-2222-2222-2222-222222222222",
      body: "мой ответ", decrypted: true, insertedAt: "2026-10-13T11:34:54Z",
    },
    {
      chatId: "chat-uuid-1", syncId: "sync-2", sender: "11111111-1111-1111-1111-111111111111",
      body: "вопрос @{mention:22222222-2222-2222-2222-222222222222}", decrypted: true, insertedAt: "2026-10-13T10:00:00Z",
    },
    {
      chatId: "chat-uuid-1", syncId: "sync-1", sender: "11111111-1111-1111-1111-111111111111",
      body: "привет @{mention:8551ce6a-a2aa-5aad-b0e4-0301e65e73e8}", decrypted: true, insertedAt: "2026-10-13T09:00:00Z",
    },
  ]);

  assert.equal(mine.own, true);
  assert.equal(mine.sender, "Павленко А.");
  assert.equal(mine.sync_id, "sync-3");
  assert.equal(other.own, false);
  assert.equal(other.sender, "Комиссаров И.");
  assert.equal(other.sender_huid, "11111111-1111-1111-1111-111111111111");
  assert.equal(other.chat, "Склянчук DM");
  assert.ok(other.message.includes("@Павленко А."), "mention should render as @Name");
  assert.deepEqual(other.mentions, ["22222222-2222-2222-2222-222222222222"]);
  assert.deepEqual(mention.mentions, ["8551ce6a-a2aa-5aad-b0e4-0301e65e73e8"]);
  assert.ok(mention.message.includes("@all"));
  // local_time is a wall-clock string in the machine's timezone, not the raw UTC ISO
  assert.match(mine.local_time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(mine.time, "2026-10-13T11:34:54Z");
});

// messages_list `since` filtering is client-side; its pure helpers can be checked via the tool
// schema. Here we only assert the tool exposes the new params.
test("messages_list schema exposes since and since_message_id", async () => {
  const { client } = await connectedClient();
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "messages_list");
  assert.ok(tool);
  const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  assert.ok(props.since, "missing 'since' param");
  assert.ok(props.since_message_id, "missing 'since_message_id' param");
});

// send_message dry_run (WISHLIST #9): without a token the tool reports not_authenticated
// before touching the network, proving the auth gate precedes any send path.
test("send_message schema exposes dry_run and stays auth-gated", async () => {
  const { client } = await connectedClient();
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "send_message");
  assert.ok(tool);
  const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  assert.ok(props.dry_run, "missing 'dry_run' param");

  const result = await client.callTool({ name: "send_message", arguments: { chat: "alice", text: "draft", dry_run: true } });
  const text = (result.content as Array<{ text: string }>)[0].text;
  assert.equal(JSON.parse(text).error, "not_authenticated", "dry_run must still require auth (chat resolution needs it)");
});

// Attachments (WISHLIST #3), live wire format: the payload has NO keys[]; `file` is the
// download path; the file is a secretstream keyed by the MESSAGE's own symmetric key,
// split into chunk_size chunks; file_hash = base64(BLAKE2b-256(plaintext)).
test("image message decrypts to a downloadable attachment keyed by the message key", async () => {
  const sodium = (await import("libsodium-wrappers-sumo")).default;
  await sodium.ready;
  const nacl = (await import("tweetnacl")).default;
  const { decryptMessages, unboxMessageKey, fetchKeyMap } = await import("../api/decrypt.js");
  const { decryptFileStream } = await import("../api/attachments.js");

  const sender = nacl.box.keyPair();
  const me = nacl.box.keyPair();
  const msgKey = sodium.crypto_secretstream_xchacha20poly1305_keygen(); // 32 bytes, also the AEAD key
  const chatId = "d8ab03e2-4d91-56b2-896e-192988e72d75";
  const syncId = "2fc30c88-c6f6-5755-8fa0-9819cf42a4f5";

  // File: 2.5 chunks of 1 KiB → three secretstream chunks.
  const CHUNK = 1024;
  const file = sodium.randombytes_buf(CHUNK * 2 + 512);
  const { header, state } = sodium.crypto_secretstream_xchacha20poly1305_init_push(msgKey);
  const parts: Uint8Array[] = [header];
  for (let off = 0; off < file.length; off += CHUNK) {
    const last = off + CHUNK >= file.length;
    parts.push(sodium.crypto_secretstream_xchacha20poly1305_push(state, file.slice(off, off + CHUNK), null,
      last ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE));
  }
  const wire = Buffer.concat(parts);

  const payload = {
    type: "image", body: "скрин ошибки", from: "sender-huid",
    reply: { sync_id: "root-sync", payload: { from: "me-huid", body: "что падает?" } },
    payload: {
      file: `/uploads/files/${chatId}/2b8df6fe`, file_name: "image.png", file_mime_type: "image/png",
      file_size: file.length, chunk_size: CHUNK, file_encryption_algo: "stream",
      file_hash: Buffer.from(sodium.crypto_generichash(32, file, null)).toString("base64"),
    },
  };
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    JSON.stringify(payload), new Uint8Array(Buffer.from(`${chatId}:${syncId}`)), null, nonce, msgKey);
  const boxNonce = nacl.randomBytes(nacl.box.nonceLength);
  const event = {
    sync_id: syncId, group_chat_id: chatId, sender: "sender-huid", sender_key_id: "sender-key",
    inserted_at: "2026-10-13T11:34:54Z", event_type: "message_new",
    payload: Buffer.concat([nonce, ct]).toString("base64"),
    key: { algo: "x", key_id: "my-key", key: Buffer.concat([boxNonce, nacl.box(msgKey, boxNonce, me.publicKey, sender.secretKey)]).toString("base64") },
    meta: { thread_started: true },
  };
  const keys = { ctsKey: { keyId: "my-key", privateKey: me.secretKey, publicKey: me.publicKey } } as never;
  const client = { get: async () => [{ id: "sender-key", body: Buffer.from(sender.publicKey).toString("base64"), user_huid: "sender-huid" }] } as never;

  const [msg] = await decryptMessages([event], keys, client);
  assert.equal(msg.decrypted, true, msg.error);
  assert.equal(msg.body, "скрин ошибки");
  assert.equal(msg.image?.fileName, "image.png");
  assert.equal(msg.attachment?.file, payload.payload.file);
  assert.equal(msg.attachment?.keys, undefined);
  assert.deepEqual(msg.reply, { sync_id: "root-sync", sender: "me-huid", body: "что падает?" });
  assert.equal(msg.thread_started, true);

  const streamKey = unboxMessageKey(event, me.secretKey, "my-key", await fetchKeyMap([event], client), keys);
  const pt = decryptFileStream(wire, streamKey, msg.attachment!.chunkSize);
  assert.deepEqual(Buffer.from(pt), Buffer.from(file));
  assert.equal(Buffer.from(sodium.crypto_generichash(32, pt, null)).toString("base64"), msg.attachment!.fileHash);
});

// Legacy envelope: payload-level keys[] (nacl.box nonce||ct to our key_id).
test("unboxStreamKey recovers a key from payload keys[] and rejects foreign key_ids", async () => {
  const nacl = (await import("tweetnacl")).default;
  const { unboxStreamKey } = await import("../api/attachments.js");
  const senderPair = nacl.box.keyPair();
  const myPair = nacl.box.keyPair();
  const streamKey = nacl.randomBytes(32);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const envelope = Buffer.concat([nonce, nacl.box(streamKey, nonce, myPair.publicKey, senderPair.secretKey)]).toString("base64");
  const attachment = { fileName: "x.png", file: "ab".repeat(16), keys: [{ key_id: "my-key", key: envelope, algo: "x" }] };
  assert.deepEqual(unboxStreamKey(attachment, myPair.secretKey, "my-key", senderPair.publicKey), streamKey);
  assert.throws(() => unboxStreamKey(attachment, myPair.secretKey, "other-key", senderPair.publicKey), /no key for our key_id/);
});

// events_history (backward) is NEWEST-FIRST and `limit` counts all events, so
// messages_list must sort, cut at the cursor on the NEWER side, and only claim
// has_more when the page is full and no requested boundary was reached.
test("sliceHistory: chronological output, since_message_id keeps newer messages, honest has_more", async () => {
  const { sliceHistory } = await import("./server.js");
  const m = (id: string, at: string) => ({ sync_id: id, body: id, sender: "x", inserted_at: at, decrypted: true });
  const newestFirst = [m("c", "2026-10-13T12:00:00Z"), m("b", "2026-10-13T11:00:00Z"), m("a", "2026-10-12T10:00:00Z")];
  const full = { full: true, oldestAt: "2026-10-12T09:00:00Z" };

  const all = sliceHistory(newestFirst, full, {});
  assert.deepEqual(all.items.map((x) => x.sync_id), ["a", "b", "c"]);
  assert.equal(all.hasMore, true, "full page without boundaries → older history may exist");
  assert.equal(sliceHistory(newestFirst, { full: false }, {}).hasMore, false);

  const cursor = sliceHistory(newestFirst, full, { sinceMessageId: "a" });
  assert.deepEqual(cursor.items.map((x) => x.sync_id), ["b", "c"]);
  assert.equal(cursor.hasMore, false, "cursor found → nothing missing between it and now");

  const lost = sliceHistory(newestFirst, full, { sinceMessageId: "older-than-window" });
  assert.equal(lost.items.length, 3);
  assert.equal(lost.hasMore, true, "cursor outside the window → a gap, raise limit");

  const today = sliceHistory(newestFirst, full, { since: Date.parse("2026-10-13T00:00:00Z") });
  assert.deepEqual(today.items.map((x) => x.sync_id), ["b", "c"]);
  assert.equal(today.hasMore, false, "window reaches past `since`");
  const notReached = sliceHistory(newestFirst, full, { since: Date.parse("2026-10-01T00:00:00Z") });
  assert.equal(notReached.hasMore, true, "window ends after `since` → older matching messages may exist");
});

test("normalizer keeps image captions and exposes reply_to and thread_replies", async () => {
  const { Inbox, makeNormalizer } = await import("./server.js");
  const self = "22222222-2222-2222-2222-222222222222";
  const other = "11111111-1111-1111-1111-111111111111";
  const { normalize } = makeNormalizer({
    session: () => ({ getThreads: () => [{ thread_id: "root", counter: 3 }] }) as never,
    inbox: new Inbox(),
    chatNames: new Map(),
    senderNames: new Map([[self, "Я"], [other, "Коллега"]]),
    isSessionReady: () => true,
    selfHuid: () => self,
  });
  const [n] = await normalize([{
    chatId: "chat", syncId: "root", sender: other, body: "вот скрин", decrypted: true, insertedAt: "2026-10-13T11:00:00Z",
    image: { fileName: "image.png" }, attachment: { fileName: "image.png", mimeType: "image/png", fileSize: 10 },
    thread_started: true, reply: { sync_id: "q", sender: self, body: "что падает?" },
  }]);
  assert.equal(n.message, "🖼 image.png\nвот скрин");
  assert.equal(n.thread_replies, 3);
  assert.deepEqual(n.reply_to, { message_id: "q", sender: "Я", sender_huid: self, text: "что падает?" });
  assert.deepEqual(n.attachment, { file_name: "image.png", mime_type: "image/png", size: 10, downloadable: true });
});

// auth_qr_start deliberately isn't invoked as a tool here: it opens the user's
// real browser and starts a live long-poll against the eXpress backend as a
// side effect. Its only pure, testable piece is the local QR material it builds.
test("buildQrMaterial produces self-consistent local crypto material", () => {
  const material = buildQrMaterial({ host: "example.invalid" });
  assert.equal(material.qrSigningKey.keyId, material.registrationId);
  const payload = JSON.parse(material.qrPayload);
  assert.equal(payload.registration_id, material.registrationId);
  assert.equal(material.encryptionKey.length, 32);
});
