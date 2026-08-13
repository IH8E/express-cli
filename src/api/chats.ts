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
    if (!ctsToken || !ctsKeyId) {
      console.error(
        !ctsToken
          ? "Warning: no auth token — run `express-cli auth import <token>` or `express-cli auth qr`"
          : "Warning: no encryption keys — run `express-cli auth qr` to authenticate"
      );
      console.error("Falling back to corporate directory (shows only global/public chats).\n");
      return this.listChatsViaDirectory();
    }

    try {
      return await fetchChatListViaWebSocket({
        host,
        ctsToken,
        encryptionKeyId: ctsKeyId,
      });
    } catch (err) {
      console.error(`Warning: WebSocket failed (${(err as Error).message}), falling back to corporate directory.\n`);
      return this.listChatsViaDirectory();
    }
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
