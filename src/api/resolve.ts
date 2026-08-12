import { ApiClient } from "./client.js";
import { ChatsApi } from "./chats.js";
import { UserApi } from "./user.js";
import type { ExpressChat } from "../types/index.js";

/** List chats with DM display names resolved to the other participant's full name. */
export async function listChatsWithNames(client: ApiClient): Promise<ExpressChat[]> {
  const chats = await new ChatsApi(client).listChats();
  const dmChats = chats.filter((c) => c.chat_type === "chat" && c.member_huids?.length);
  if (dmChats.length === 0) return chats;

  const userApi = new UserApi(client);
  const myHuid = (await userApi.getSelfProfile()).user_huid;
  const otherHuids = [...new Set(dmChats.flatMap((c) => (c.member_huids ?? []).filter((h) => h !== myHuid)))];
  if (otherHuids.length === 0) return chats;

  const nameMap = new Map((await userApi.getProfilesByHuid(otherHuids)).map((p) => [p.user_huid, p.name]));
  for (const chat of chats) {
    if (chat.chat_type === "chat" && chat.member_huids) {
      const other = chat.member_huids.find((h) => h !== myHuid);
      if (other) chat.name = nameMap.get(other) ?? chat.name;
    }
  }
  return chats;
}

/** Resolve a chat name (partial match) or UUID to a full chat_id. Throws on 0/many matches. */
export async function resolveChatId(client: ApiClient, chatIdOrName: string): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(chatIdOrName)) return chatIdOrName;

  const chats = await listChatsWithNames(client);
  const lower = chatIdOrName.toLowerCase();
  const matches = chats.filter((c) => (c.name ?? "").toLowerCase().includes(lower));
  if (matches.length === 0) throw new Error(`No chat found matching "${chatIdOrName}"`);
  if (matches.length > 1) {
    const names = matches.map((c) => `  ${c.name} (${c.group_chat_id})`).join("\n");
    throw new Error(`Multiple chats match "${chatIdOrName}":\n${names}\nUse the full chat ID.`);
  }
  return matches[0].group_chat_id;
}
