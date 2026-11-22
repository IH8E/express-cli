import { decryptMessages } from "./decrypt.js";
import type { HistoryMessage } from "./decrypt.js";
import { listChatsWithNames } from "./resolve.js";
import { wsRequest } from "./ws-request.js";
import { loadApigwKeys } from "../auth/keys.js";
import type { ApiClient } from "./client.js";

/** One message revision as the server knows it.
 *
 *  IMPORTANT: eXpress does not keep a version chain for edits. `event_edit` replaces the
 *  payload of the SAME `sync_id` and only bumps `edited_at` / `version`, so the previous
 *  text is gone — `prev_event_sync_id` links to the previous *chat event*, not to an older
 *  revision of this message. This type therefore reports the current state, not a history. */
export interface MessageVersion {
  sync_id: string;
  event_type: string;
  inserted_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  version?: number;
  sender_huid?: string;
  body: string;
  decrypted: boolean;
  error?: string;
}

type EventInfoEntry = HistoryMessage & {
  edited_at?: string | null;
  deleted_at?: string | null;
  version?: number;
};

/** Current state of specific messages, fetched by id (`system/event_info`).
 *
 *  More precise than scanning history: it returns the event regardless of how far back it
 *  is in the chat, including its `edited_at` / `version` / `deleted_at`, which the normal
 *  history read does not expose for old messages. */
export async function getMessageInfo(params: {
  client: ApiClient;
  chatId: string;
  syncIds: string[];
  /** Injection point for tests; defaults to the real WS call. */
  request?: typeof wsRequest;
  decrypt?: typeof decryptMessages;
  /** Injection point for tests; defaults to the real key store. */
  loadKeys?: typeof loadApigwKeys;
}): Promise<MessageVersion[]> {
  const { client, chatId, syncIds, request = wsRequest, decrypt = decryptMessages, loadKeys = loadApigwKeys } = params;
  const apigwKeys = loadKeys();
  if (!apigwKeys) throw new Error("No apigw keys. Run 'express auth qr' first.");

  const response = await request({
    topic: "system",
    event: "event_info",
    payload: { group_chat_id: chatId, sync_ids: syncIds },
  }) as { info?: EventInfoEntry[] };

  const events = response.info ?? [];
  if (!events.length) return [];

  const decrypted = await decrypt(events, apigwKeys, client);
  const bySyncId = new Map(decrypted.map((m) => [m.sync_id, m]));

  // Preserve the caller's order, dropping ids the server did not return.
  return syncIds.flatMap((id) => {
    const event = events.find((e) => e.sync_id === id);
    if (!event) return [];
    const d = bySyncId.get(id);
    return [{
      sync_id: event.sync_id,
      event_type: event.event_type,
      inserted_at: event.inserted_at,
      edited_at: event.edited_at ?? null,
      deleted_at: event.deleted_at ?? null,
      version: event.version,
      sender_huid: event.sender ?? undefined,
      body: d?.body ?? "",
      decrypted: d?.decrypted ?? false,
      ...(d?.error ? { error: d.error } : {}),
    }];
  });
}

/** Chats shared with a person (`system/common_chats`), with names resolved where known. */
export async function getCommonChats(params: {
  client: ApiClient;
  userHuid: string;
  /** Injection points for tests; default to the real implementations. */
  request?: typeof wsRequest;
  listChats?: typeof listChatsWithNames;
}): Promise<Array<{ chat_id: string; name?: string; chat_type?: string; members?: number }>> {
  const { client, userHuid, request = wsRequest, listChats = listChatsWithNames } = params;
  const response = await request({
    topic: "system",
    event: "common_chats",
    payload: { user_huid: userHuid },
  }) as { common_chats?: Array<string | Record<string, unknown>> };

  const raw = response.common_chats ?? [];
  if (!raw.length) return [];

  // The payload is a bare list of chat ids (not objects) — names come from our chat list.
  const ids = raw.map((c) => (typeof c === "string" ? c : String(c.group_chat_id ?? c.chat_id ?? "")))
    .filter(Boolean);
  const known = new Map((await listChats(client)).map((c) => [c.group_chat_id, c]));
  return ids.map((id) => {
    const chat = known.get(id);
    return {
      chat_id: id,
      name: chat?.name,
      chat_type: chat?.chat_type,
      members: chat?.members_count,
    };
  });
}
