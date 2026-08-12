import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ApiClient } from "../api/client.js";
import { PhonebookApi } from "../api/phonebook.js";
import { UserApi } from "../api/user.js";
import { readMessages } from "../api/messages-read.js";
import { sendMessageViaWebSocket } from "../api/messaging-ws.js";
import { resolveChatId, listChatsWithNames } from "../api/resolve.js";
import { getAuthToken, getTokenExpiresAt } from "../config/store.js";
import { ExpressSession, type SessionMessage } from "../session/session.js";
import type { ExpressChat } from "../types/index.js";

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

interface Incoming { seq: number; chatId: string; sender: string; body: string; time: string; decrypted: boolean; image?: string }

/** Buffers incoming messages so `wait_for_messages` can hand an agent everything
 * new since its last call, blocking up to a timeout when nothing is pending. */
class Inbox {
  private buf: Incoming[] = [];
  private seq = 0;
  private cursor = 0;
  private waiters: Array<() => void> = [];

  add(m: SessionMessage): void {
    this.buf.push({ seq: ++this.seq, chatId: m.chatId, sender: m.sender, body: m.body, time: m.insertedAt, decrypted: m.decrypted, image: m.image?.fileName });
    if (this.buf.length > 500) this.buf.splice(0, this.buf.length - 500);
    const woken = this.waiters; this.waiters = []; woken.forEach((fn) => fn());
  }

  private pending(): Incoming[] { return this.buf.filter((x) => x.seq > this.cursor); }

  /** Return (and consume) messages arrived since the last take, waiting up to timeoutMs. */
  async take(timeoutMs: number): Promise<Incoming[]> {
    if (this.pending().length === 0) {
      await new Promise<void>((resolve) => {
        const fn = () => { clearTimeout(t); resolve(); };
        const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== fn); resolve(); }, timeoutMs);
        this.waiters.push(fn);
      });
    }
    const items = this.pending();
    if (this.buf.length) this.cursor = this.buf[this.buf.length - 1].seq;
    return items;
  }
}

/**
 * MCP server (stdio) exposing eXpress chat over the existing api layer. Reuses the
 * same E2E send/read code as the CLI, so nothing is duplicated. stdout carries only
 * the MCP protocol (the request/refresh path is free of stdout logging).
 */
export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: "express-cli", version: "0.1.0" });

  // Persistent session that buffers incoming messages for wait_for_messages.
  const inbox = new Inbox();
  const chatNames = new Map<string, string>();
  const senderNames = new Map<string, string>();
  let sessionReady = false;
  let session: ExpressSession | null = null;
  try {
    session = new ExpressSession();
    session.on("connected", () => { sessionReady = true; });
    session.on("chats", (list: ExpressChat[]) => { for (const c of list) chatNames.set(c.group_chat_id, c.name?.trim() || c.group_chat_id.slice(0, 8)); });
    session.on("message", (m: SessionMessage) => inbox.add(m));
    session.connect().catch((err) => { process.stderr.write(`[mcp] session connect failed: ${(err as Error).message}\n`); });
    // Resolve DM names in the background for nicer chat labels
    listChatsWithNames(new ApiClient()).then((chats) => { for (const c of chats) chatNames.set(c.group_chat_id, c.name ?? c.group_chat_id.slice(0, 8)); }).catch(() => {});
  } catch (err) {
    process.stderr.write(`[mcp] session unavailable: ${(err as Error).message}\n`);
  }

  const enrich = async (items: Incoming[]) => {
    const unknown = [...new Set(items.map((i) => i.sender))].filter((h) => h && h.length >= 30 && !senderNames.has(h));
    if (unknown.length) {
      try {
        const profiles = await new UserApi(new ApiClient()).getProfilesByHuid(unknown);
        for (const p of profiles) if (p.name) senderNames.set(p.user_huid, p.name);
      } catch { /* names are best-effort */ }
    }
    return items.map((i) => ({
      time: i.time,
      chat: chatNames.get(i.chatId) ?? i.chatId.slice(0, 8),
      chat_id: i.chatId,
      sender: senderNames.get(i.sender) ?? i.sender.slice(0, 8),
      message: i.decrypted ? (i.image ? `🖼 ${i.image}` : i.body) : "[decrypt failed]",
    }));
  };

  server.registerTool("chats_list", {
    title: "List chats",
    description: "List chats (DMs, groups, channels) with names and full chat IDs. DM names are resolved to the person's full name.",
    inputSchema: { type: z.enum(["all", "dm", "group", "channel"]).optional().describe("Filter by chat type (default all)") },
  }, async ({ type }) => {
    const chats = await listChatsWithNames(new ApiClient());
    const kind: Record<string, string> = { dm: "chat", group: "group_chat", channel: "channel" };
    const filtered = !type || type === "all" ? chats : chats.filter((c) => c.chat_type === kind[type]);
    return ok(filtered.map((c) => ({ name: c.name, chat_id: c.group_chat_id, type: c.chat_type, members: c.members_count })));
  });

  server.registerTool("chats_find", {
    title: "Find a chat by name",
    description: "Find chats whose name (person or group) contains the query. Returns name + full chat_id to use with other tools.",
    inputSchema: { query: z.string().describe("Part of the chat or person name") },
  }, async ({ query }) => {
    const chats = await listChatsWithNames(new ApiClient());
    const q = query.toLowerCase();
    return ok(chats.filter((c) => (c.name ?? "").toLowerCase().includes(q)).map((c) => ({ name: c.name, chat_id: c.group_chat_id, type: c.chat_type })));
  });

  server.registerTool("messages_list", {
    title: "Read messages",
    description: "Read and decrypt recent messages from a chat, identified by name or chat_id.",
    inputSchema: {
      chat: z.string().describe("Chat name (partial ok) or full chat_id"),
      limit: z.number().int().min(1).max(200).optional().describe("How many recent messages (default 20)"),
    },
  }, async ({ chat, limit }) => {
    const client = new ApiClient();
    const chatId = await resolveChatId(client, chat);
    const msgs = await readMessages({ chatId, limit: limit ?? 20 });
    return ok(msgs.map((m) => ({
      time: m.inserted_at,
      sender: m.sender,
      body: m.decrypted ? (m.image ? `🖼 ${m.image.fileName}${m.body ? ` — ${m.body}` : ""}` : m.body) : `[decrypt failed: ${m.error}]`,
    })));
  });

  server.registerTool("send_message", {
    title: "Send a message",
    description: "Send a text message to a chat, identified by name (partial ok) or chat_id. Returns the sync_id.",
    inputSchema: { chat: z.string().describe("Chat name or full chat_id"), text: z.string().describe("Message text") },
  }, async ({ chat, text }) => {
    const client = new ApiClient();
    const chatId = await resolveChatId(client, chat);
    const res = await sendMessageViaWebSocket({ client, chatId, body: text });
    return ok({ sent: true, chat_id: chatId, sync_id: res.sync_id });
  });

  server.registerTool("contacts_search", {
    title: "Search employees",
    description: "Global company phonebook search across all employees by name.",
    inputSchema: { query: z.string().describe("Name to search"), limit: z.number().int().min(1).max(50).optional() },
  }, async ({ query, limit }) => {
    const profiles = await new PhonebookApi(new ApiClient()).searchUsers(query, limit ?? 20);
    return ok(profiles.map((p) => ({ name: p.name, huid: p.user_huid, email: p.email, position: p.company_position, department: p.department })));
  });

  server.registerTool("contacts_self", {
    title: "My profile",
    description: "Get the authenticated user's own profile.",
    inputSchema: {},
  }, async () => ok(await new UserApi(new ApiClient()).getSelfProfile()));

  server.registerTool("wait_for_messages", {
    title: "Wait for incoming messages",
    description: "Block until new incoming messages arrive (from any chat/discussion), then return them. Returns messages received since the previous call to this tool; if none are pending, waits up to timeout_seconds. Your own sent messages are not included. Use this to react to new messages instead of polling.",
    inputSchema: { timeout_seconds: z.number().int().min(1).max(120).optional().describe("Max seconds to wait when nothing is pending (default 30)") },
  }, async ({ timeout_seconds }) => {
    if (!session) return ok({ error: "Session unavailable — run 'express auth qr' to authenticate." });
    const items = await inbox.take((timeout_seconds ?? 30) * 1000);
    return ok({ connected: sessionReady, count: items.length, messages: await enrich(items) });
  });

  server.registerTool("status", {
    title: "Auth status",
    description: "Check authentication and access-token status.",
    inputSchema: {},
  }, async () => {
    const exp = getTokenExpiresAt();
    return ok({
      authenticated: !!getAuthToken(),
      token_expires_in_seconds: exp ? Math.max(0, Math.floor((exp - Date.now()) / 1000)) : null,
    });
  });

  await server.connect(new StdioServerTransport());
}
