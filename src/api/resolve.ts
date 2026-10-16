import { ApiClient } from "./client.js";
import { ChatsApi } from "./chats.js";
import { UserApi } from "./user.js";
import { PhonebookApi } from "./phonebook.js";
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

/** Resolve a chat name (partial match) or UUID to a full chat_id.
 *  If no existing DM matches and the query looks like a person's name,
 *  searches the phonebook and auto-creates a DM. Throws on ambiguity. */
export async function resolveChatId(client: ApiClient, chatIdOrName: string): Promise<string> {
  return (await resolveChat(client, chatIdOrName)).chatId!;
}

/** Like resolveChatId, plus the display name. With `create: false` a phonebook-only match
 *  returns `chatId: null` instead of creating a DM (for read-only / dry-run callers). */
export async function resolveChat(
  client: ApiClient,
  chatIdOrName: string,
  opts: { create?: boolean } = {},
): Promise<{ chatId: string | null; name?: string }> {
  if (/^[0-9a-f-]{36}$/i.test(chatIdOrName)) return { chatId: chatIdOrName };

  const chats = await listChatsWithNames(client);
  const lower = chatIdOrName.toLowerCase();
  const matches = chats.filter((c) => (c.name ?? "").toLowerCase().includes(lower));
  if (matches.length === 1) return { chatId: matches[0].group_chat_id, name: matches[0].name };
  if (matches.length > 1) {
    const names = matches.map((c) => `  ${c.name} (${c.group_chat_id})`).join("\n");
    throw new Error(`Multiple chats match "${chatIdOrName}":\n${names}\nUse the full chat ID.`);
  }

  // No existing chat — try phonebook and auto-create DM
  const results = await new PhonebookApi(client).searchUsers(chatIdOrName, 5);
  if (results.length === 0) throw new Error(`No chat or contact found matching "${chatIdOrName}"`);
  if (results.length > 1) {
    const names = results.map((p) => `  ${p.name} (${p.user_huid})`).join("\n");
    throw new Error(`No existing DM with "${chatIdOrName}", found multiple contacts:\n${names}\nBe more specific.`);
  }

  const person = results[0];
  if (opts.create === false) return { chatId: null, name: person.name };
  process.stderr.write(`No DM with "${person.name}" — creating one...\n`);
  const chatId = await new ChatsApi(client).createDm(person.user_huid);
  process.stderr.write(`DM created: ${chatId}\n`);
  return { chatId, name: person.name };
}
