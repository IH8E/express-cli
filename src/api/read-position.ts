import { wsRequest } from "./ws-request.js";

/** Mark a chat as read up to `syncId`.
 *
 *  `chat_position_report` goes to the chat's own topic and answers an empty ok — the server
 *  stores the position. `clean_badge` also clears the unread badge, which is what a client
 *  does when the user opens the chat; without it the counter stays until something else
 *  moves the position. `chat_info.read_position_at` reflects the result.
 *
 *  `is_big_chat` tells the server not to recompute counters for a huge chat; the web client
 *  passes it for the chats it marks as such, and omitting it is harmless. */
export async function markChatRead(params: {
  chatId: string;
  positionSyncId: string;
  cleanBadge?: boolean;
  cleanMissedCalls?: boolean;
}): Promise<{ chat_id: string; position_event_sync_id: string }> {
  const { chatId, positionSyncId, cleanBadge = true, cleanMissedCalls = false } = params;
  if (!positionSyncId) throw new Error("position_event_sync_id is required to report a read position");

  await wsRequest({
    topic: `groupchat:${chatId}`,
    event: "chat_position_report",
    payload: {
      position_event_sync_id: positionSyncId,
      clean_badge: cleanBadge,
      clean_missed_calls: cleanMissedCalls,
      is_big_chat: false,
    },
  });
  return { chat_id: chatId, position_event_sync_id: positionSyncId };
}
