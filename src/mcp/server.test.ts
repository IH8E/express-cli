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
const { registerTools, Inbox } = await import("./server.js");
const { buildQrMaterial } = await import("../auth/qr-login.js");

const EXPECTED_TOOLS = [
  "chats_list", "chats_find", "messages_list", "send_message", "contacts_search",
  "contacts_self", "wait_for_messages", "status", "auth_qr_start", "auth_qr_poll",
];

async function connectedClient() {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, {
    session: null,
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

test("registers all 10 tools with complete annotations", async () => {
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
