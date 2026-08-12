import { ApiClient } from "./client.js";
import { fetchChatListViaWebSocket } from "./websocket.js";
import { getAuthToken } from "../config/store.js";
import { loadApigwKeys } from "../auth/keys.js";
import { loadConfig, getBaseUrl } from "../config/index.js";
import type { ExpressChat } from "../types/index.js";

interface DirectoryEntry {
  position: number;
  entry_type: "user" | "bot" | "chat";
  entry_id: string;
  is_info_updated: boolean;
  deleted: boolean;
}

interface OpenChatsResponse {
  generated_at: string;
  open_chats: ExpressChat[];
}

export class ChatsApi {
  constructor(private client: ApiClient) {}

  async listChats(): Promise<ExpressChat[]> {
    const config = loadConfig();
    const host = new URL(getBaseUrl(config)).hostname;
    const ctsToken = getAuthToken();
    const keys = loadApigwKeys();

    const ctsKeyId = (keys?.ctsKey ?? keys?.encryptionKey)?.keyId;
    if (ctsToken && ctsKeyId) {
      try {
        return await fetchChatListViaWebSocket({
          host,
          ctsToken,
          encryptionKeyId: ctsKeyId,
        });
      } catch (err) {
        if (process.env.EXPRESS_DEBUG) {
          console.error(`  [DEBUG] WebSocket failed, falling back to directory: ${(err as Error).message}`);
        }
      }
    }

    return this.listChatsViaDirectory();
  }

  private async listChatsViaDirectory(): Promise<ExpressChat[]> {
    const data = await this.client.get<{ entries: DirectoryEntry[] }>("/api/v1/corporate_directory/entries");
    const entries = data?.entries ?? [];
    const chatIds = entries
      .filter((e) => e.entry_type === "chat" && !e.deleted)
      .map((e) => e.entry_id);
    if (chatIds.length === 0) return [];
    const result = await this.client.post<OpenChatsResponse>("/api/v1/messaging/chats/open_chats_list", {
      chat_ids: chatIds,
    });
    return result?.open_chats ?? [];
  }

  async getChatInfo(chatId: string): Promise<ExpressChat | null> {
    const data = await this.client.post<OpenChatsResponse>("/api/v1/messaging/chats/open_chats_list", {
      chat_ids: [chatId],
    });
    return data?.open_chats?.[0] ?? null;
  }
}
