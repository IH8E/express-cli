import { wsRequest } from "./ws-request.js";

/** A light delta for one chat: position/read markers and delayed-message flags.
 *  Delivered by `get_chat_list_frequent_changes` and cheap enough to poll often. */
export interface ChatFrequentChange {
  group_chat_id: string;
  unread_marker?: string | null;
  last_event_sync_id?: string | null;
  last_event_inserted_at?: string | null;
  read_position_at?: string | null;
  received_position_at?: string | null;
  has_delayed_messages?: boolean;
  has_failed_delayed_messages?: boolean;
  pinned_messages_changed_at?: string | null;
}

/** A structural delta for one chat: the full chat record changed (members, name, keys…). */
export type ChatBaseChange = Record<string, unknown>;

/** Incremental chat-list sync.
 *
 *  The web client does not re-fetch the whole `chat_list` on reconnect: it asks
 *  `get_chat_list_base_changes` (structural) and `get_chat_list_frequent_changes`
 *  (position/unread, `request_version: 4`) with a `since` cursor and applies only what
 *  changed. Both answer even when nothing changed, so a caller can advance its cursor.
 */
export async function getChatListChanges(params: {
  since: string;
  /** Injection point for tests; defaults to the real WS call. */
  request?: typeof wsRequest;
}): Promise<{ base: ChatBaseChange[]; frequent: ChatFrequentChange[]; generated_at?: string }> {
  const { since, request = wsRequest } = params;

  const [baseResponse, frequentResponse] = await Promise.all([
    request({
      topic: "system",
      event: "get_chat_list_base_changes",
      payload: { since, request_version: 6 },
    }) as Promise<{ get_chat_list_base_changes?: ChatBaseChange[]; generated_at?: string }>,
    request({
      topic: "system",
      event: "get_chat_list_frequent_changes",
      payload: { since, request_version: 4 },
    }) as Promise<{ get_chat_list_frequent_changes?: ChatFrequentChange[]; generated_at?: string }>,
  ]);

  return {
    base: baseResponse.get_chat_list_base_changes ?? [],
    frequent: frequentResponse.get_chat_list_frequent_changes ?? [],
    generated_at: frequentResponse.generated_at ?? baseResponse.generated_at,
  };
}
