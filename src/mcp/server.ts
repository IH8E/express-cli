import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { writeFileSync, readFileSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ApiClient } from "../api/client.js";
import { PhonebookApi } from "../api/phonebook.js";
import { UserApi } from "../api/user.js";
import { readMessageEvents } from "../api/messages-read.js";
import { deleteMessagesViaWebSocket, editMessageViaWebSocket, reactViaWebSocket, sendFileViaWebSocket, sendMessageViaWebSocket, type ReplyQuote } from "../api/messaging-ws.js";
import { resolveChat, resolvePerson, listChatsWithNames } from "../api/resolve.js";
import { downloadAttachment, unboxStreamKey } from "../api/attachments.js";
import { decryptMessages, fetchKeyMap, getSenderPublicKey, unboxMessageKey, type DecryptedMessage, type FileAttachment, type HistoryMessage, type ReplyRef } from "../api/decrypt.js";
import { loadApigwKeys } from "../auth/keys.js";
import { getAuthToken, getTokenExpiresAt } from "../config/store.js";
import { refreshToken } from "../auth/token-refresh.js";
import { buildQrMaterial, pollForQrScan, completeQrRegistration } from "../auth/qr-login.js";
import { openQrInBrowser } from "../auth/qr-browser.js";
import { ExpressSession, type SessionMessage, type ThreadSummary } from "../session/session.js";
import { MENTION_RE, ALL_MENTION_HUID, applyMentions, type MentionTarget } from "../api/mentions.js";
import type { ExpressChat } from "../types/index.js";
import QRCode from "qrcode";
import packageJson from "../../package.json" with { type: "json" };

const AUTH_INSTRUCTION = "Run 'express-cli auth qr' (or 'npx @ih8e/express-cli auth qr') in a terminal to log in.";

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});

const notAuthenticated = () => ok({ error: "not_authenticated", instruction: AUTH_INSTRUCTION });

/** Human-friendly error text instead of a raw zod/stack dump (WISHLIST #8). */
function errorText(err: unknown): string {
  if (err instanceof Error) {
    // undici's bare "fetch failed" hides the real reason (DNS, timeout, refused) in `cause`
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return cause ? `${err.message} (${cause.code ?? cause.message})` : err.message;
  }
  if (typeof err === "object" && err !== null) {
    // zod-style issues dump: distill to "path: message" lines
    const issues = (err as { issues?: Array<{ path: (string | number)[]; message: string }> }).issues;
    if (Array.isArray(issues) && issues.length) return issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return JSON.stringify(err);
  }
  return String(err);
}

/** Wrap a tool body: config/login failures become a human-readable payload with a hint,
 * never a bare exception that an agent can't interpret. */
function withHumanErrors(fn: () => Promise<ReturnType<typeof ok>>): Promise<ReturnType<typeof ok>> {
  return fn().catch((err) => {
    const message = errorText(err);
    const hint = /host|token|not authenticated|no apigw keys/i.test(message)
      ? ` Call the 'status' tool to check authentication; ${AUTH_INSTRUCTION}`
      : /fetch failed|timeout|ECONN|ENOTFOUND|EAI_AGAIN/i.test(message)
        ? " Network problem reaching the eXpress server (VPN?) — retry the call."
        : "";
    return ok({ error: message + hint });
  });
}

/** Refresh if token expires within 5 minutes; return true if auth is valid after. */
async function ensureAuth(): Promise<boolean> {
  const exp = getTokenExpiresAt();
  if (exp && Date.now() > exp - 5 * 60 * 1000) {
    await refreshToken();
  }
  return !!getAuthToken();
}

interface Incoming {
  seq: number; syncId: string; chatId: string; sender: string; body: string; time: string; decrypted: boolean;
  image?: string; attachment?: FileAttachment; reply?: ReplyRef;
}

/** Buffers incoming messages so `wait_for_messages` can hand an agent everything
 * new since its last call, blocking up to a timeout when nothing is pending. */
export class Inbox {
  private buf: Incoming[] = [];
  private seq = 0;
  private cursor = 0;
  private waiters: Array<() => void> = [];

  add(m: SessionMessage): void {
    this.buf.push({ seq: ++this.seq, syncId: m.syncId, chatId: m.chatId, sender: m.sender, body: m.body, time: m.insertedAt, decrypted: m.decrypted, image: m.image?.fileName, attachment: m.attachment, reply: m.reply });
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


export interface McpToolDeps {
  /** Live session, created lazily (see `sessionProvider`); null while there are no apigw keys. */
  session: () => ExpressSession | null;
  inbox: Inbox;
  chatNames: Map<string, string>;
  senderNames: Map<string, string>;
  isSessionReady: () => boolean;
  /** Overrides for tests; in production resolved lazily from contacts_self. */
  selfHuid?: () => string | undefined;
  setSelfHuid?: (huid: string) => void;
}

/** Renders an ISO timestamp in the local timezone, e.g. "2026-10-14 14:34:54" (agents' users
 * speak local time; the raw UTC string is kept too). */
function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Uniform message shape shared by messages_list and wait_for_messages (WISHLIST #10). */
interface NormalizedMessage {
  sync_id: string;
  chat: string;
  chat_id: string;
  time: string;
  local_time: string;
  sender: string;
  sender_huid: string;
  own: boolean;
  message: string;
  mentions: string[];
  /** True when a discussion (thread) starts at this message. */
  thread_started?: boolean;
  /** Replies in that thread (from thread_list; absent when unknown). */
  thread_replies?: number;
  /** Reaction summary, e.g. "✅:1;👀:1". */
  reactions?: string;
  /** Present when the message carries a downloadable encrypted attachment. */
  attachment?: { file_name: string; mime_type?: string; size?: number; downloadable: true };
  reply_to?: { message_id: string; sender: string; sender_huid: string; text: string };
  /** When the sender edited it; `message` is already the edited text. */
  edited_at?: string;
}

interface NormalizeInput {
  chatId: string; syncId: string; sender: string; body: string; decrypted: boolean;
  error?: string; insertedAt: string; image?: { fileName: string };
  attachment?: { fileName: string; mimeType?: string; fileSize?: number };
  thread_started?: boolean; reactions?: string; reply?: ReplyRef; editedAt?: string;
}

const fromDecrypted = (chatId: string, m: DecryptedMessage): NormalizeInput => ({
  chatId, syncId: m.sync_id, sender: m.sender, body: m.body, decrypted: m.decrypted,
  error: m.error, insertedAt: m.inserted_at, image: m.image, attachment: m.attachment,
  thread_started: m.thread_started, reactions: m.reactions, reply: m.reply, editedAt: m.edited_at,
});

/** One shape for messages_list and wait_for_messages (WISHLIST #10): names, local time,
 * message_id, own flag, mention list, reply, attachment and thread info. Exported for tests. */
export function makeNormalizer(deps: McpToolDeps) {
  const { chatNames, senderNames, selfHuid, setSelfHuid, session } = deps;

  let selfHuidCached: string | undefined = selfHuid?.();
  const ensureSelf = async (): Promise<string | undefined> => {
    if (!selfHuidCached) {
      try {
        selfHuidCached = (await new UserApi(new ApiClient()).getSelfProfile()).user_huid;
        setSelfHuid?.(selfHuidCached);
      } catch (err) {
        process.stderr.write(`[mcp] self profile lookup failed, own=false: ${errorText(err)}\n`);
      }
    }
    return selfHuidCached;
  };

  /** Fill senderNames via phonebook lookup for huids we haven't seen yet. */
  const resolveNames = async (huids: string[]): Promise<void> => {
    const unknown = [...new Set(huids)].filter((h) => h && h.length >= 30 && h !== ALL_MENTION_HUID && !senderNames.has(h));
    if (!unknown.length) return;
    try {
      const profiles = await new UserApi(new ApiClient()).getProfilesByHuid(unknown);
      for (const p of profiles) if (p.name) senderNames.set(p.user_huid, p.name);
    } catch (err) {
      process.stderr.write(`[mcp] name lookup failed, showing huid prefixes: ${errorText(err)}\n`);
    }
  };

  const nameOf = (huid: string) => senderNames.get(huid) ?? (huid === ALL_MENTION_HUID ? "all" : huid.slice(0, 8));
  const renderMentions = (body: string) => body.replace(MENTION_RE, (_m, huid: string) => `@${nameOf(huid)}`);

  /** `threads` — the chat's thread list (for reply counts); defaults to the session's global list. */
  const normalize = async (items: NormalizeInput[], threads = session()?.getThreads() ?? []): Promise<NormalizedMessage[]> => {
    await ensureSelf();
    const mentioned = items.flatMap((i) => [...i.body.matchAll(MENTION_RE)].map((m) => m[1]));
    await resolveNames([...items.map((i) => i.sender), ...items.flatMap((i) => i.reply ? [i.reply.sender] : []), ...mentioned]);
    const threadReplies = new Map(threads.map((t) => [t.thread_id, t.counter]));

    return items.map((i) => {
      const mentions = [...i.body.matchAll(MENTION_RE)].map((m) => m[1]);
      const body = i.decrypted ? renderMentions(i.body) : `[decrypt failed: ${i.error ?? "unknown"}]`;
      const label = !i.decrypted ? "" : i.image ? `🖼 ${i.image.fileName}` : i.attachment ? `📎 ${i.attachment.fileName}` : "";
      return {
        sync_id: i.syncId,
        chat: chatNames.get(i.chatId) ?? i.chatId.slice(0, 8),
        chat_id: i.chatId,
        time: i.insertedAt,
        local_time: localTime(i.insertedAt),
        sender: nameOf(i.sender),
        sender_huid: i.sender,
        own: selfHuidCached !== undefined && i.sender === selfHuidCached,
        message: label && body ? `${label}\n${body}` : label || body,
        mentions,
        thread_started: i.thread_started || undefined,
        thread_replies: i.thread_started ? threadReplies.get(i.syncId) : undefined,
        reactions: i.reactions || undefined,
        attachment: i.attachment ? {
          file_name: i.attachment.fileName,
          mime_type: i.attachment.mimeType,
          size: i.attachment.fileSize,
          downloadable: true,
        } : undefined,
        reply_to: i.reply ? {
          message_id: i.reply.sync_id,
          sender: nameOf(i.reply.sender),
          sender_huid: i.reply.sender,
          text: renderMentions(i.reply.body).slice(0, 200),
        } : undefined,
        edited_at: i.editedAt,
      };
    });
  };

  return { normalize, resolveNames, self: () => selfHuidCached };
}

/**
 * Slice one events_history page for messages_list. The page holds the newest `limit`
 * EVENTS (joins/leaves included) newest-first; output is chronological. `has_more` is
 * true only when older history exists AND none of the requested boundaries (since /
 * since_message_id) was reached inside the page. Exported for tests.
 */
export function sliceHistory(
  msgs: DecryptedMessage[],
  page: { full: boolean; oldestAt?: string },
  opts: { since?: number; sinceMessageId?: string },
): { items: DecryptedMessage[]; hasMore: boolean } {
  let items = [...msgs].sort((a, b) => Date.parse(a.inserted_at) - Date.parse(b.inserted_at));
  let boundaryReached = false;
  if (opts.since !== undefined) {
    items = items.filter((m) => Date.parse(m.inserted_at) >= opts.since!);
    if (page.oldestAt && Date.parse(page.oldestAt) < opts.since) boundaryReached = true;
  }
  if (opts.sinceMessageId) {
    const idx = items.findIndex((m) => m.sync_id === opts.sinceMessageId);
    if (idx >= 0) { items = items.slice(idx + 1); boundaryReached = true; }
  }
  return { items, hasMore: page.full && !boundaryReached };
}

/** Find one message event by full sync_id (direct fetch) or by a unique prefix (searched in
 * the last 1000 events). Returns an error text for the agent when not found / ambiguous. */
async function findMessageEvent(chatId: string, messageId: string): Promise<HistoryMessage | string> {
  const id = messageId.trim().toLowerCase();
  if (/^[0-9a-f-]{36}$/.test(id)) {
    // A forward page from the cursor starts AT it; an unknown id yields some other event
    const page = await readMessageEvents({ chatId, limit: 1, direction: "forward", fromSyncId: id });
    return page.find((e) => e.sync_id === id) ?? `Message ${messageId} not found in this chat.`;
  }
  if (!/^[0-9a-f-]{4,}$/.test(id)) return `Invalid message_id "${messageId}" — pass the sync_id (or its prefix) from messages_list.`;
  const matches = (await readMessageEvents({ chatId, limit: 1000 })).filter((e) => e.sync_id.startsWith(id));
  if (matches.length === 1) return matches[0];
  return matches.length
    ? `Message id prefix ${messageId} is ambiguous (${matches.length} matches) — pass the full sync_id.`
    : `No message with id prefix ${messageId} in the last 1000 events — pass the full sync_id.`;
}

/** Registers all express-cli tools on `server`. Split out from `runMcpServer` so tests
 * can exercise tools over an in-memory transport without a live session/stdio transport. */
export function registerTools(server: McpServer, deps: McpToolDeps): void {
  const { session, inbox, isSessionReady, chatNames } = deps;
  const { normalize, self } = makeNormalizer(deps);

  /** Resolve a chat and remember its name (new DMs aren't in chatNames yet). `create`
   * only for a real send — reading or a dry run must not create a DM as a side effect. */
  const resolveChatNamed = async (client: ApiClient, chat: string, create = false) => {
    const r = await resolveChat(client, chat, { create });
    if (r.chatId && r.name) chatNames.set(r.chatId, r.name);
    return r;
  };
  const resolveExistingChat = async (client: ApiClient, chat: string): Promise<string> => {
    const r = await resolveChatNamed(client, chat);
    if (!r.chatId) throw new Error(`No chat with ${r.name} yet — there is nothing to read.`);
    return r.chatId;
  };
  /** The quote a reply carries; an error string when the target can't be read. */
  const quoteForReply = async (client: ApiClient, chatId: string, messageId: string): Promise<ReplyQuote | string> => {
    const event = await findMessageEvent(chatId, messageId);
    if (typeof event === "string") return event;
    const apigwKeys = loadApigwKeys();
    if (!apigwKeys) return "No apigw keys. Run 'express auth qr' first.";
    const [msg] = await decryptMessages([event], apigwKeys, client);
    if (!msg?.decrypted) return `Cannot reply to ${messageId}: it does not decrypt (${msg?.error ?? "no message"}).`;
    const meta = (await listChatsWithNames(client)).find((c) => c.group_chat_id === chatId);
    return {
      sync_id: event.sync_id, group_chat_id: chatId, reply_type: meta?.chat_type ?? "group_chat",
      source_name: meta?.name ?? "", sender_conn_type: "cts",
      payload: { type: msg.type ?? "text", body: msg.body, from: msg.sender },
    };
  };
  /** messages_list/thread_read read one chat — chat/chat_id go on the envelope, not on every message (WISHLIST #14). */
  const withoutChat = (msgs: NormalizedMessage[]) => msgs.map(({ chat: _chat, chat_id: _chatId, ...m }) => m);

  server.registerTool("chats_list", {
    title: "List chats",
    description: "List chats (DMs, groups, channels) with names and full chat IDs. DM names are resolved to the person's full name.",
    inputSchema: { type: z.enum(["all", "dm", "group", "channel"]).optional().describe("Filter by chat type (default all)") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ type }) => withHumanErrors(async () => {
    if (!await ensureAuth()) return notAuthenticated();
    const chats = await listChatsWithNames(new ApiClient());
    const kind: Record<string, string> = { dm: "chat", group: "group_chat", channel: "channel" };
    const filtered = !type || type === "all" ? chats : chats.filter((c) => c.chat_type === kind[type]);
    // Unread counters need the live session (system/get_unread_counters over WS).
    let unread = new Map<string, { counter?: number; mention_counter?: number }>();
    try {
      unread = new Map((await session()?.getUnreadCounters())?.map((u) => [u.group_chat_id, u]) ?? []);
    } catch (err) {
      process.stderr.write(`[mcp] unread counters unavailable: ${errorText(err)}\n`);
    }
    return ok(filtered.map((c) => ({
      name: c.name, chat_id: c.group_chat_id, type: c.chat_type, members: c.members_count,
      unread: unread.get(c.group_chat_id)?.counter ?? 0,
      unread_mentions: unread.get(c.group_chat_id)?.mention_counter ?? 0,
    })));
  }));

  server.registerTool("chats_find", {
    title: "Find a chat by name",
    description: "Find chats whose name (person or group) contains the query. Returns name + full chat_id to use with other tools.",
    inputSchema: { query: z.string().describe("Part of the chat or person name") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query }) => withHumanErrors(async () => {
    if (!await ensureAuth()) return notAuthenticated();
    const chats = await listChatsWithNames(new ApiClient());
    const q = query.toLowerCase();
    const found = chats.filter((c) => (c.name ?? "").toLowerCase().includes(q)).map((c) => ({ name: c.name, chat_id: c.group_chat_id, type: c.chat_type }));
    if (found.length) return ok(found);
    // No chat yet — say whether the person exists, so the agent doesn't conclude they don't
    const people = await new PhonebookApi(new ApiClient()).searchUsers(query, 5);
    return ok(people.map((p) => ({ name: p.name, chat_id: null, type: "person", user_huid: p.user_huid, note: "No DM with this person yet; send_message creates one." })));
  }));

  server.registerTool("messages_list", {
    title: "Read messages",
    description: "Read and decrypt recent messages from a chat (or a thread, by thread_id), identified by name or chat_id. Messages are chronological (oldest first). Each has: sync_id (message id), sender name + sender_huid, own flag, text, local time, mentions, reply_to, thread info and attachment. `has_more: true` means older messages exist beyond the fetched window — read further back with before_message_id = sync_id of the oldest returned message.",
    inputSchema: {
      chat: z.string().describe("Chat name (partial ok) or full chat_id"),
      limit: z.number().int().min(1).max(200).optional().describe("History window in events (joins/leaves count too, so fewer messages may come back). Default 20, or 200 with since/since_message_id/unread_only"),
      since: z.string().optional().describe("ISO date-time or YYYY-MM-DD (local midnight) — only messages at or after this moment"),
      since_message_id: z.string().optional().describe("sync_id of a message — only messages newer than it"),
      before_message_id: z.string().optional().describe("sync_id of a message — only messages older than it (page backwards through history)"),
      unread_only: z.boolean().optional().describe("Only the chat's unread messages (per the server's unread counter)"),
      mentions_me: z.boolean().optional().describe("Only messages that @mention me or reply to my messages"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ chat, limit, since, since_message_id, before_message_id, unread_only, mentions_me }) => withHumanErrors(async () => {
    if (!await ensureAuth()) return notAuthenticated();
    let sinceMs: number | undefined;
    if (since) {
      sinceMs = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T00:00:00` : since);
      if (Number.isNaN(sinceMs)) return ok({ error: `Invalid 'since' value: ${since}. Use ISO date-time or YYYY-MM-DD.` });
    }
    const live = session();
    if (unread_only && (!live || !isSessionReady())) {
      return ok({ error: live
        ? "unread_only needs the live session, which is not connected yet — retry shortly."
        : "unread_only needs the live session, which is unavailable (no apigw keys).", instruction: AUTH_INSTRUCTION });
    }

    const client = new ApiClient();
    const chatId = await resolveExistingChat(client, chat);
    const unreadCount = unread_only
      ? (await live!.getUnreadCounters()).find((u) => u.group_chat_id === chatId)?.counter ?? 0
      : undefined;

    const window = limit ?? (since || since_message_id || unread_only ? 200 : 20);
    // The backward page starts AT the cursor event — drop it
    const page = await readMessageEvents({ chatId, limit: window, fromSyncId: before_message_id });
    const events = before_message_id ? page.filter((e) => e.sync_id !== before_message_id) : page;
    const apigwKeys = loadApigwKeys();
    if (!apigwKeys) return ok({ error: "No apigw keys. Run 'express auth qr' first." });
    const msgs = await decryptMessages(events, apigwKeys, client);
    const oldestAt = events.reduce<string | undefined>((min, e) => (!min || e.inserted_at < min ? e.inserted_at : min), undefined);
    const sliced = sliceHistory(msgs, { full: page.length >= window, oldestAt }, { since: sinceMs, sinceMessageId: since_message_id });
    let items = sliced.items;
    if (unreadCount !== undefined) items = items.slice(Math.max(0, items.length - unreadCount));

    let threads: ThreadSummary[] | undefined;
    if (live && isSessionReady() && items.some((m) => m.thread_started)) {
      try {
        threads = await live.listChatThreads(chatId);
      } catch (err) {
        process.stderr.write(`[mcp] thread_list failed, thread_replies may be missing: ${errorText(err)}\n`);
      }
    }
    let normalized = await normalize(items.map((m) => fromDecrypted(chatId, m)), threads);
    if (mentions_me) {
      const me = self();
      if (!me) return ok({ error: "mentions_me: could not determine your own huid (contacts_self failed)." });
      normalized = normalized.filter((m) => m.mentions.includes(me) || m.reply_to?.sender_huid === me);
    }
    // unread_only stops at the unread counter, so older history is irrelevant
    const hasMore = unreadCount !== undefined ? items.length < unreadCount && sliced.hasMore : sliced.hasMore;
    return ok({ chat: chatNames.get(chatId) ?? chatId.slice(0, 8), chat_id: chatId, count: normalized.length, has_more: hasMore, messages: withoutChat(normalized) });
  }));

  server.registerTool("attachment_download", {
    title: "Download an attachment",
    description: "Download and decrypt a file/image attachment from a chat message to a local path (default: a fresh temp dir). Use messages_list to find messages with an `attachment` field, then pass its sync_id (a unique prefix works); for a thread message pass the thread_id as `chat`. Returns {path, file_name, mime_type, size} — open the file at `path` to view it. An existing file at output_path is overwritten.",
    inputSchema: {
      chat: z.string().describe("Chat name (partial ok), full chat_id, or thread_id"),
      message_id: z.string().describe("sync_id of the message carrying the attachment (full, or a unique prefix of the last 1000 events)"),
      output_path: z.string().optional().describe("Where to save the decrypted file (default: temp dir; missing folders are created)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ chat, message_id, output_path }) => withHumanErrors(async () => {
    if (!await ensureAuth()) return notAuthenticated();
    const client = new ApiClient();
    const chatId = await resolveExistingChat(client, chat);
    const event = await findMessageEvent(chatId, message_id);
    if (typeof event === "string") return ok({ error: event });

    const apigwKeys = loadApigwKeys();
    if (!apigwKeys) return ok({ error: "No apigw keys. Run 'express auth qr' first." });
    const ctsKey = apigwKeys.ctsKey ?? apigwKeys.encryptionKey;

    const [msg] = await decryptMessages([event], apigwKeys, client);
    if (!msg?.decrypted || !msg.attachment) {
      return ok({ error: `Message ${message_id} has no downloadable attachment${msg && !msg.decrypted ? ` (decrypt failed: ${msg.error})` : ""}.` });
    }

    const keyMap = await fetchKeyMap([event], client);
    let streamKey: Uint8Array;
    if (msg.attachment.keys?.length) {
      const senderPub = getSenderPublicKey(event, keyMap, apigwKeys);
      if (!senderPub) return ok({ error: "Cannot determine sender public key — stream key unboxing impossible." });
      streamKey = unboxStreamKey(msg.attachment, ctsKey.privateKey, ctsKey.keyId, senderPub);
    } else {
      streamKey = unboxMessageKey(event, ctsKey.privateKey, ctsKey.keyId, keyMap, apigwKeys);
    }

    return ok(await downloadAttachment({ chatId, attachment: msg.attachment, streamKey, outputPath: output_path }));
  }));

  server.registerTool("thread_read", {
    title: "Read a discussion thread",
    description: "Read and decrypt messages of a discussion (thread) started at a message. Use messages_list to find messages with thread_started=true — the thread_id equals that message's sync_id. Returns the same message shape as messages_list, chronological.",
    inputSchema: {
      chat: z.string().describe("Parent chat name (partial ok) or full chat_id"),
      message_id: z.string().describe("sync_id of the thread's root message (= thread_id)"),
      limit: z.number().int().min(1).max(200).optional().describe("History window in events (default 50)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ chat, message_id, limit }) => withHumanErrors(async () => {
    if (!await ensureAuth()) return notAuthenticated();
    const client = new ApiClient();
    const chatId = await resolveExistingChat(client, chat); // parent chat, for the name label
    const window = limit ?? 50;
    const events = await readMessageEvents({ chatId: message_id, limit: window }); // thread_id works as a chat id
    if (!events.length) return ok({ error: `No thread ${message_id}. Pass the sync_id of a messages_list entry with thread_started=true.` });
    const apigwKeys = loadApigwKeys();
    if (!apigwKeys) return ok({ error: "No apigw keys. Run 'express auth qr' first." });
    const { items, hasMore } = sliceHistory(await decryptMessages(events, apigwKeys, client), { full: events.length >= window }, {});
    const normalized = await normalize(items.map((m) => fromDecrypted(message_id, m)));
    const parentName = chatNames.get(chatId) ?? chatId.slice(0, 8);
    return ok({ count: normalized.length, has_more: hasMore, thread_id: message_id, parent_chat: parentName, messages: withoutChat(normalized) });
  }));

  server.registerTool("send_message", {
    title: "Send a message",
    description: "Send a text message to a chat, identified by name (partial ok), chat_id, or a person's full name / email / huid (from contacts_search). To reply in an existing thread, pass its thread_id (= sync_id of the root message with thread_started: true). Optional: reply_to (quote a message), mentions (@person or @all, with a notification), file_path (attach any file; images get a preview, `text` becomes the caption). If no DM exists with that person, one is created automatically. Returns the sync_id. With dry_run: true nothing is sent — it returns the resolved chat, the final text, who gets mentioned, the quoted message and the file, for a human to check first.",
    inputSchema: {
      chat: z.string().describe("Chat name, full chat_id, thread_id, or a person's full name / email / huid"),
      text: z.string().describe("Message text; {0}, {1}… place the n-th mention, otherwise mentions go first"),
      dry_run: z.boolean().optional().describe("Validate and preview the send without actually sending anything"),
      reply_to: z.string().optional().describe("sync_id of a message in this chat to reply to (shown quoted, like a reply in the app)"),
      mentions: z.array(z.string()).optional().describe("People to @mention: full name, email or huid; \"all\" for everyone in the chat"),
      file_path: z.string().optional().describe("Local file to attach (any type; .png/.jpg/.jpeg/.gif/.webp go as images); `text` becomes its caption"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ chat, text, dry_run, reply_to, mentions, file_path }) => withHumanErrors(async () => {
    if (!await ensureAuth()) return notAuthenticated();
    if (mentions?.length && file_path) return ok({ error: "mentions with file_path is not supported yet — send the mention as a separate text message." });
    const client = new ApiClient();
    const targets: MentionTarget[] = [];
    for (const m of mentions ?? []) {
      if (m.trim().toLowerCase() === "all") targets.push({ all: true });
      else { const p = await resolvePerson(client, m); targets.push({ user_huid: p.user_huid, name: p.name }); }
    }
    const withMentions = targets.length ? applyMentions(text, targets) : undefined;
    const body = withMentions?.body ?? text;
    const file = file_path ? { file_name: basename(file_path), size: statSync(file_path).size } : undefined;
    if (dry_run) {
      const { chatId, name, userHuid } = await resolveChatNamed(client, chat);
      const quote = reply_to && chatId ? await quoteForReply(client, chatId, reply_to) : undefined;
      if (typeof quote === "string") return ok({ error: quote });
      const shown = targets.reduce((t, m, i) => t.split(`@{mention:${withMentions!.mentions[i].mention_id}}`).join(`@${m.all ? "all" : m.name}`), body);
      return ok({
        sent: false, dry_run: true, chat_id: chatId, chat: name ?? (chatId && chatNames.get(chatId)) ?? chatId?.slice(0, 8),
        ...(userHuid ? { user_huid: userHuid } : {}),
        ...(chatId ? {} : { note: "No DM with this person yet — a real send creates one." }),
        text: shown, characters: shown.length,
        ...(targets.length ? { mentions: targets.map((m) => (m.all ? { all: true } : { name: m.name, user_huid: m.user_huid })) } : {}),
        ...(quote ? { reply_to: { message_id: quote.sync_id, sender: deps.senderNames.get(quote.payload.from) ?? quote.payload.from.slice(0, 8), text: quote.payload.body.slice(0, 200) } } : {}),
        ...(file ? { file } : {}),
      });
    }
    const { chatId } = await resolveChatNamed(client, chat, true);
    if (!chatId) throw new Error(`Could not resolve chat "${chat}"`);
    const reply = reply_to ? await quoteForReply(client, chatId, reply_to) : undefined;
    if (typeof reply === "string") return ok({ error: reply });
    const res = file_path
      ? await sendFileViaWebSocket({ client, chatId, filePath: file_path, caption: text, reply })
      : await sendMessageViaWebSocket({ client, chatId, body, reply, mentions: withMentions?.mentions });
    return ok({ sent: true, chat_id: chatId, sync_id: res.sync_id });
  }));

  server.registerTool("react", {
    title: "React to a message",
    description: "Put an emoji reaction on a message (e.g. ✅ for «taken»), or take your reaction back with remove: true.",
    inputSchema: {
      chat: z.string().describe("Chat name, chat_id, or thread_id the message is in"),
      message_id: z.string().describe("sync_id of the message (full, or a unique prefix of the last 1000 events)"),
      emoji: z.string().describe("The reaction emoji, e.g. ✅"),
      remove: z.boolean().optional().describe("Take back your reaction instead of adding it"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ chat, message_id, emoji, remove }) => withHumanErrors(async () => {
    if (!await ensureAuth()) return notAuthenticated();
    const chatId = await resolveExistingChat(new ApiClient(), chat);
    const event = await findMessageEvent(chatId, message_id);
    if (typeof event === "string") return ok({ error: event });
    await reactViaWebSocket({ event, reaction: emoji, remove });
    return ok({ chat_id: chatId, sync_id: event.sync_id, reaction: emoji, removed: !!remove });
  }));

  server.registerTool("edit_message", {
    title: "Edit a message",
    description: "Replace the text of one of YOUR OWN messages (the chat shows it as edited). Pass the chat (or thread_id for a thread message) and the message's sync_id from messages_list/thread_read.",
    inputSchema: {
      chat: z.string().describe("Chat name, chat_id, or thread_id the message is in"),
      message_id: z.string().describe("sync_id of your message (full, or a unique prefix of the last 1000 events)"),
      text: z.string().describe("The new message text"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ chat, message_id, text }) => withHumanErrors(async () => {
    if (!await ensureAuth()) return notAuthenticated();
    const client = new ApiClient();
    const chatId = await resolveExistingChat(client, chat);
    const event = await findMessageEvent(chatId, message_id);
    if (typeof event === "string") return ok({ error: event });
    const res = await editMessageViaWebSocket({ client, event, body: text });
    return ok({ edited: true, chat_id: chatId, ...res });
  }));

  server.registerTool("delete_message", {
    title: "Delete messages",
    description: "Delete one or more of YOUR OWN messages for everyone (the chat shows «message deleted»). Irreversible.",
    inputSchema: {
      chat: z.string().describe("Chat name, chat_id, or thread_id the messages are in"),
      message_ids: z.array(z.string()).min(1).describe("Full sync_ids of your messages"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ chat, message_ids }) => withHumanErrors(async () => {
    if (!await ensureAuth()) return notAuthenticated();
    const chatId = await resolveExistingChat(new ApiClient(), chat);
    const res = await deleteMessagesViaWebSocket({ chatId, syncIds: message_ids });
    return ok({ chat_id: chatId, ...res });
  }));

  server.registerTool("contacts_search", {
    title: "Search employees",
    description: "Global company phonebook search across all employees by name.",
    inputSchema: { query: z.string().describe("Name to search"), limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ query, limit }) => withHumanErrors(async () => {
    if (!await ensureAuth()) return notAuthenticated();
    const profiles = await new PhonebookApi(new ApiClient()).searchUsers(query, limit ?? 20);
    return ok(profiles.map((p) => ({ name: p.name, huid: p.user_huid, email: p.email, position: p.company_position, department: p.department })));
  }));

  server.registerTool("contacts_self", {
    title: "My profile",
    description: "Get the authenticated user's own profile.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => withHumanErrors(async () => {
    if (!await ensureAuth()) return notAuthenticated();
    return ok(await new UserApi(new ApiClient()).getSelfProfile());
  }));

  server.registerTool("wait_for_messages", {
    title: "Wait for incoming messages",
    description: "Block until new incoming messages arrive (from any chat/discussion), then return them. Returns messages received since the previous call to this tool; if none are pending, waits up to timeout_seconds. Your own sent messages are not included. Use this to react to new messages instead of polling.",
    inputSchema: { timeout_seconds: z.number().int().min(1).max(120).optional().describe("Max seconds to wait when nothing is pending (default 30)") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ timeout_seconds }) => {
    if (!session()) return ok({ error: "Session unavailable.", instruction: AUTH_INSTRUCTION });
    const items = await inbox.take((timeout_seconds ?? 30) * 1000);
    const messages = await normalize(items.map((i) => ({
      chatId: i.chatId, syncId: i.syncId, sender: i.sender, body: i.body,
      decrypted: i.decrypted, insertedAt: i.time, image: i.image ? { fileName: i.image } : undefined,
      attachment: i.attachment, reply: i.reply,
    })));
    return ok({ connected: isSessionReady(), count: items.length, messages });
  });

  server.registerTool("status", {
    title: "Auth status",
    description: "Check authentication and access-token status. Call this first if other tools return not_authenticated.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const exp = getTokenExpiresAt();
    return ok({
      authenticated: !!getAuthToken(),
      token_expires_in_seconds: exp ? Math.max(0, Math.floor((exp - Date.now()) / 1000)) : null,
      login_instruction: AUTH_INSTRUCTION,
    });
  });

  // ─── QR login (two-phase) ──────────────────────────────────────────────────
  //
  // Phase 1 (auth_qr_start): generates QR material, persists it to disk so that
  //   auth_qr_poll can recover it even after a server restart, kicks off the
  //   background long-poll, and returns the QR ASCII inline (no bash cat needed).
  //   Model MUST call auth_qr_poll immediately after — no user confirmation needed.
  //
  // Phase 2 (auth_qr_poll): awaits the background poll (or re-spawns it from the
  //   persisted material if the server restarted), then completes registration.

  const QR_MATERIAL_FILE = join(tmpdir(), "express-qr-material.json");

  let pendingQrMaterial: ReturnType<typeof buildQrMaterial> | null = null;
  let pendingQrPoll: Promise<Awaited<ReturnType<typeof pollForQrScan>>> | null = null;

  server.registerTool("auth_qr_start", {
    title: "Start QR login — step 1 of 2",
    description:
      "Step 1: generate a QR code for eXpress login. " +
      "The QR code is included in the response — display it to the user as-is. " +
      "After displaying the QR you MUST immediately call the MCP tool `auth_qr_poll` (step 2) — " +
      "do NOT wait for the user to confirm scanning first; auth_qr_poll waits automatically. " +
      "Do NOT run auth_qr_poll as a shell command — it is an MCP tool. " +
      "Use when status reports not_authenticated.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async () => {
    const material = buildQrMaterial();

    const qrAscii = await QRCode.toString(material.qrPayload, { type: "utf8" as "terminal", small: true });

    writeFileSync(join(tmpdir(), "express-qr.txt"), qrAscii, { encoding: "utf8", mode: 0o600 });
    process.stderr.write("\n" + qrAscii + "\n");
    const qrPageUrl = await openQrInBrowser(material.qrPayload, material.registrationId).catch(() => null);

    // Persist serialisable fields so auth_qr_poll can recover after a server restart.
    const persistent = {
      registrationId: material.registrationId,
      encryptionKey: Buffer.from(material.encryptionKey).toString("base64"),
      qrSigningKey: {
        keyId: material.qrSigningKey.keyId,
        privateKey: Buffer.from(material.qrSigningKey.privateKey).toString("base64"),
        publicKey: Buffer.from(material.qrSigningKey.publicKey).toString("base64"),
      },
      udid: material.udid,
      qrPayload: material.qrPayload,
      qrBody: material.qrBody,
    };
    writeFileSync(QR_MATERIAL_FILE, JSON.stringify(persistent), { encoding: "utf8", mode: 0o600 });

    pendingQrMaterial = material;
    pendingQrPoll = pollForQrScan(material).catch((err) => {
      process.stderr.write(`[mcp] QR poll error: ${(err as Error).message}\n`);
      pendingQrMaterial = null;
      pendingQrPoll = null;
      throw err;
    });

    return ok(
      `${qrAscii.trim()}\n\n` +
      `Scan with the eXpress mobile app.\n` +
      (qrPageUrl ? `Or open this link in a browser: ${qrPageUrl}\n` : "") +
      `\n[AGENT: call auth_qr_poll immediately — do not wait for user input]`,
    );
  });

  server.registerTool("auth_qr_poll", {
    title: "Complete QR login — step 2 of 2",
    description:
      "Step 2: wait for the phone scan and complete QR login. " +
      "Call this immediately after auth_qr_start — do NOT wait for user confirmation. " +
      "Waits up to 90 s for the server handshake, then saves tokens and keys. " +
      "IMPORTANT: call this as an MCP tool, not as a shell command.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async () => {
    let material = pendingQrMaterial;
    let poll = pendingQrPoll;

    // If server restarted and lost in-memory state, recover from disk.
    if (!material || !poll) {
      let saved: Record<string, unknown> | null = null;
      try { saved = JSON.parse(readFileSync(QR_MATERIAL_FILE, "utf8")) as Record<string, unknown>; } catch { /* no file */ }

      if (!saved) return ok("No pending QR session. Call auth_qr_start first.");

      // Re-hydrate material from persisted data.
      const sk = saved.qrSigningKey as Record<string, string>;
      const hydrated = {
        registrationId: saved.registrationId as string,
        encryptionKey: Buffer.from(saved.encryptionKey as string, "base64"),
        qrSigningKey: {
          keyId: sk.keyId,
          privateKey: Buffer.from(sk.privateKey, "base64"),
          publicKey: Buffer.from(sk.publicKey, "base64"),
        },
        udid: saved.udid as string,
        qrPayload: saved.qrPayload as string,
        qrBody: saved.qrBody as string,
        config: (await import("../config/loader.js")).loadConfig(),
      } as ReturnType<typeof buildQrMaterial>;

      material = hydrated;
      poll = pollForQrScan(material);
    }

    pendingQrMaterial = null;
    pendingQrPoll = null;
    try { unlinkSync(QR_MATERIAL_FILE); } catch { /* already gone */ }

    try {
      const pollResult = await poll;
      await completeQrRegistration(material, pollResult, (msg) => {
        process.stderr.write(msg + "\n");
      });
      session(); // bring up (or re-key) the live session without a restart
      return ok("Login successful. You are now authenticated.");
    } catch (err) {
      return ok(`Login failed: ${(err as Error).message}`);
    }
  });
}

/** Returns a getter for the live session that (re)creates it on demand: a process started
 * before `auth qr` recovers once keys appear, and a re-login swaps the session to the new
 * key (issue #1). `start` attaches listeners and connects; it runs once per created session. */
export function sessionProvider(start: (s: ExpressSession) => void): () => ExpressSession | null {
  let session: ExpressSession | null = null;
  let keyId: string | undefined;
  return () => {
    const keys = loadApigwKeys();
    const currentKeyId = keys ? (keys.ctsKey ?? keys.encryptionKey).keyId : undefined;
    if (session && currentKeyId === keyId) return session;
    session?.close();
    session = null;
    keyId = undefined;
    if (!keys) return null;
    try {
      session = new ExpressSession();
      keyId = currentKeyId;
      start(session);
    } catch (err) {
      process.stderr.write(`[mcp] session unavailable: ${(err as Error).message}\n`);
      session = null;
      keyId = undefined;
    }
    return session;
  };
}

/**
 * MCP server (stdio) exposing eXpress chat over the existing api layer. Reuses the
 * same E2E send/read code as the CLI, so nothing is duplicated. stdout carries only
 * the MCP protocol (the request/refresh path is free of stdout logging).
 */
export async function runMcpServer(): Promise<void> {
  const server = new McpServer({ name: "express-cli", version: packageJson.version });

  // Persistent session that buffers incoming messages for wait_for_messages.
  const inbox = new Inbox();
  const chatNames = new Map<string, string>();
  const senderNames = new Map<string, string>();
  let sessionReady = false;
  const session = sessionProvider((s) => {
    sessionReady = false;
    s.on("connected", () => { sessionReady = true; });
    s.on("chats", (list: ExpressChat[]) => {
      for (const c of list) {
        if (c.chat_type === "chat" && chatNames.has(c.group_chat_id)) continue; // raw DM name is "personal chat"
        chatNames.set(c.group_chat_id, c.name?.trim() || c.group_chat_id.slice(0, 8));
      }
    });
    s.on("message", (m: SessionMessage) => inbox.add(m));
    // EventEmitter throws on an unhandled "error" event — without this listener a single
    // decrypt failure on an incoming push (session.ts) would crash the whole MCP process.
    s.on("error", (err: Error) => { process.stderr.write(`[mcp] session error: ${err.message}\n`); });
    s.connect().catch((err) => { process.stderr.write(`[mcp] session connect failed: ${(err as Error).message}\n`); });
    // Resolve DM names in the background for nicer chat labels
    listChatsWithNames(new ApiClient()).then((chats) => { for (const c of chats) chatNames.set(c.group_chat_id, c.name ?? c.group_chat_id.slice(0, 8)); }).catch(() => {});
  });
  session(); // eager start when keys are already there

  registerTools(server, { session, inbox, chatNames, senderNames, isSessionReady: () => sessionReady });

  await server.connect(new StdioServerTransport());
}
