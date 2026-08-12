import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { loadApigwKeys, type ApigwKeys } from "../auth/keys.js";
import { getAuthToken } from "../config/store.js";
import { loadConfig, getBaseUrl, getWebOrigin } from "../config/index.js";
import { refreshToken } from "../auth/token-refresh.js";
import { decryptMessages, type HistoryMessage, type ImageAttachment } from "../api/decrypt.js";
import type { ExpressChat } from "../types/index.js";

export interface SessionMessage {
  chatId: string;
  syncId: string;
  sender: string;
  body: string;
  decrypted: boolean;
  error?: string;
  insertedAt: string;
  type?: string;
  image?: ImageAttachment;
}

export interface SessionActivity {
  chatId: string;
  syncId: string;
  sender: string;
  senderKeyId: string;
}

/** A discussion/thread — a chat-like entity keyed by thread_id under a parent chat. */
export interface ThreadSummary {
  thread_id: string;
  group_chat_id: string;
  counter?: number;
  last_event_inserted_at?: string | null;
}

interface PhxFrame {
  ref: number | string | null;
  topic: string;
  event: string;
  payload: Record<string, unknown> & { status?: string; response?: Record<string, unknown> };
}

interface Pending {
  resolve: (response: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const HEARTBEAT_MS = 25_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Persistent, stateful eXpress connection. One WebSocket stays open: it holds the
 * chat list, subscribes to every chat's activities, decrypts incoming messages
 * (live pushes carry no key, so we pull `events_history` which returns it), and
 * re-connects with backoff + token refresh. Reused by the TUI and MCP layers.
 *
 * Events: `connected`, `chats` (ExpressChat[]), `activity` (SessionActivity),
 * `message` (SessionMessage), `disconnected` ({code}), `reconnecting`
 * ({attempt, delayMs}), `error` (Error).
 */
export class ExpressSession extends EventEmitter {
  private ws: WebSocket | null = null;
  private ref = 0;
  private pending = new Map<number, Pending>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private chats: ExpressChat[] = [];
  private threads: ThreadSummary[] = [];
  private subscribed = new Set<string>();
  private closing = false;
  private connecting = false;
  private reconnectAttempt = 0;
  private readonly host: string;
  private readonly webOrigin: string;
  private readonly keyId: string;
  private readonly apigwKeys: ApigwKeys;

  constructor() {
    super();
    const config = loadConfig();
    this.host = new URL(getBaseUrl(config)).hostname;
    this.webOrigin = getWebOrigin(config);
    const keys = loadApigwKeys();
    if (!keys) throw new Error("No apigw keys. Run 'express auth qr' first.");
    this.apigwKeys = keys;
    this.keyId = (keys.ctsKey ?? keys.encryptionKey).keyId;
  }

  getChats(): ExpressChat[] {
    return this.chats;
  }

  getThreads(): ThreadSummary[] {
    return this.threads;
  }

  /** Initial connect (awaited by the caller). Reconnection afterwards is driven
   * solely by `handleClose` → `scheduleReconnect`. */
  async connect(): Promise<void> {
    this.closing = false;
    await this.openSocket();
  }

  private async openSocket(): Promise<void> {
    if (this.closing) return;
    // Never run two sockets at once — overlapping connections with the same
    // key_id make the server kill each other (observed as a 1006 storm).
    if (this.connecting || (this.ws && this.ws.readyState === this.ws.OPEN)) return;
    this.connecting = true;

    const token = getAuthToken();
    if (!token) { this.connecting = false; throw new Error("Not authenticated. Run 'express auth qr'."); }

    const url = `wss://${this.host}/socket/user/websocket?vsn=1.0.0&auto_join=true&key_id=${this.keyId}`
      + `&version=6&background=false&voex_unencrypted=true&voex_multistream=true&voex_audio_bridge=true&instance_id=${randomUUID()}`;
    const ws = new WebSocket(url, {
      headers: { Origin: this.webOrigin, "User-Agent": "Mozilla/5.0" },
    } as ConstructorParameters<typeof WebSocket>[1]);
    this.ws = ws;

    // Only the currently-active socket's events matter; ignore stale ones.
    ws.addEventListener("message", (e) => { if (this.ws === ws) this.onMessage(e.data as string); });
    ws.addEventListener("close", () => this.handleClose(ws));
    ws.addEventListener("error", () => { /* a close event always follows; reconnect is handled there */ });

    try {
      await new Promise<void>((resolve, reject) => {
        const openTimer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error("WebSocket open timeout")); }, REQUEST_TIMEOUT_MS);
        ws.addEventListener("open", () => {
          clearTimeout(openTimer);
          this.request("phoenix", "authenticate", { token }).then(() => resolve()).catch(reject);
        });
        ws.addEventListener("close", () => { clearTimeout(openTimer); reject(new Error("closed during connect")); });
      });
    } catch (err) {
      if (this.ws === ws) { this.connecting = false; try { ws.close(); } catch { /* ignore */ } }
      throw err; // handleClose (fired by the close event) drives the reconnect
    }

    if (this.ws !== ws) return; // a newer socket superseded us — abandon this one
    this.connecting = false;
    this.reconnectAttempt = 0;
    this.startHeartbeat();
    this.emit("connected");
    await this.loadChats(ws);
  }

  close(): void {
    this.closing = true;
    this.connecting = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* ignore */ }
  }

  /** chat_type values that accept `subscribe_to_chat_activities` (others like
   * "global"/"voex_call" reply "unmatched topic"). */
  private static readonly SUBSCRIBABLE = new Set(["chat", "group_chat", "channel", "notes"]);

  /** Load the chat list and subscribe to each real chat's live activities.
   * Bails if the socket changes/closes mid-way (avoids error spam on teardown). */
  private async loadChats(ws: WebSocket): Promise<void> {
    const response = await this.request("system", "chat_list", { since: null, request_version: 6 });
    const chats = (response.chat_list ?? []) as ExpressChat[];
    this.chats = Array.isArray(chats) ? chats : [];
    this.emit("chats", this.chats);

    const ids = this.chats
      .filter((c) => !c.chat_type || ExpressSession.SUBSCRIBABLE.has(c.chat_type))
      .map((c) => c.group_chat_id)
      .filter((id): id is string => Boolean(id));

    await Promise.allSettled(ids.map((id) => this.subscribe(id, ws)));

    // Discussions (threads) — chat-like entities read via events_history by thread_id.
    // Thread messages carry group_chat_id = thread_id, so subscribing routes their
    // live pushes through the same message pipeline (chatId === thread_id).
    try {
      const tl = await this.request("system", "thread_list", { group_chat_id: null, limit: 200, request_version: 2 });
      this.threads = (tl.thread_list ?? []) as ThreadSummary[];
      this.emit("threads", this.threads);
      const threadIds = this.threads.map((t) => t.thread_id).filter(Boolean);
      await Promise.allSettled(threadIds.map((id) => this.subscribe(id, ws)));
    } catch { /* threads are optional; ignore on failure */ }
  }

  private async subscribe(chatId: string, ws: WebSocket): Promise<void> {
    if (this.subscribed.has(chatId) || this.ws !== ws) return;
    try {
      await this.request(`groupchat:${chatId}`, "subscribe_to_chat_activities", { group_chat_id: chatId });
      this.subscribed.add(chatId);
    } catch {
      // Transient (socket closing / server hiccup) — next reconnect re-subscribes. Stay quiet.
    }
  }

  private onMessage(data: string): void {
    let frame: PhxFrame;
    try { frame = JSON.parse(data) as PhxFrame; } catch { return; }

    const ref = frame.ref == null ? null : (typeof frame.ref === "string" ? parseInt(frame.ref, 10) : frame.ref);

    // Reply to one of our requests
    if (ref != null && this.pending.has(ref) && frame.event === "phx_reply") {
      const p = this.pending.get(ref)!;
      this.pending.delete(ref);
      clearTimeout(p.timer);
      if (frame.payload?.status === "ok") p.resolve(frame.payload.response ?? {});
      else p.reject(new Error(`${frame.event} failed: ${JSON.stringify(frame.payload?.response)}`));
      return;
    }

    // Live push: a new message in a subscribed chat (carries no decryption key)
    if (ref == null && frame.event === "message_new") {
      const p = frame.payload as Record<string, unknown>;
      const chatId = (p.group_chat_id as string) ?? frame.topic.replace("groupchat:", "");
      const activity: SessionActivity = {
        chatId,
        syncId: (p.sync_id as string) ?? "",
        sender: (p.sender as string) ?? "",
        senderKeyId: (p.sender_key_id as string) ?? "",
      };
      this.emit("activity", activity);
      void this.resolveMessage(activity);
    }
  }

  /** Pushes have `key: null`; pull recent history (which includes our key) and decrypt. */
  private async resolveMessage(activity: SessionActivity): Promise<void> {
    try {
      const response = await this.request(`groupchat:${activity.chatId}`, "events_history", {
        direction: "backward",
        group_chat_id: activity.chatId,
        limit: 5,
        skip_non_affecting_rc: true,
        skip_to_sync_id_event: true,
        last_ignore_messages_at: null,
      });
      const history = (response.history ?? []) as HistoryMessage[];
      const decrypted = await decryptMessages(history, this.apigwKeys);
      const match = decrypted.find((m) => m.sync_id === activity.syncId) ?? decrypted[0];
      if (!match) return;
      const msg: SessionMessage = {
        chatId: activity.chatId,
        syncId: match.sync_id,
        sender: match.sender,
        body: match.body,
        decrypted: match.decrypted,
        error: match.error,
        insertedAt: match.inserted_at,
        type: match.type,
        image: match.image,
      };
      this.emit("message", msg);
    } catch (err) {
      this.emit("error", new Error(`decrypt push failed: ${(err as Error).message}`));
    }
  }

  private request(topic: string, event: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return Promise.reject(new Error("WebSocket not open"));
    const ref = this.ref++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ref);
        reject(new Error(`request timeout: ${event}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(ref, { resolve, reject, timer });
      ws.send(JSON.stringify({ topic, event, payload, ref }));
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (ws && ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: this.ref++ }));
      }
    }, HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  /** Sole reconnect trigger. Ignores events from stale sockets. */
  private handleClose(ws: WebSocket): void {
    if (this.ws !== ws) return; // stale socket from a previous connection
    this.ws = null;
    this.connecting = false;
    this.stopHeartbeat();
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("WebSocket closed")); }
    this.pending.clear();
    this.subscribed.clear();
    this.emit("disconnected", { code: 1006 });
    if (!this.closing) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return; // single pending timer
    this.reconnectAttempt += 1;
    const delayMs = Math.min(1000 * 2 ** (this.reconnectAttempt - 1), MAX_RECONNECT_DELAY_MS);
    this.emit("reconnecting", { attempt: this.reconnectAttempt, delayMs });
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closing) return;
      await refreshToken().catch(() => false); // best-effort; keep a valid token across reconnects
      // Failure closes the socket → handleClose reschedules; don't schedule here (avoids storms).
      this.openSocket().catch(() => { /* handled via handleClose */ });
    }, delayMs);
  }
}
