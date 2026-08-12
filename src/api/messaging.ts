import { ApiClient } from "./client.js";

export interface SendMessagePayload {
  group_chat_id: string;
  notification: {
    status: "ok" | "error";
    body: string;
    metadata?: Record<string, unknown>;
    mentions?: Record<string, unknown>;
    opts?: {
      stealth_mode?: boolean;
      notification_opts?: {
        send?: boolean;
        force_dnd?: boolean;
      };
    };
  };
  file?: {
    file_name: string;
    data: string;
  };
}

export class MessagingApi {
  constructor(private client: ApiClient) {}

  async sendMessage(params: {
    groupChatId: string;
    body: string;
    metadata?: Record<string, unknown>;
    mentions?: Record<string, unknown>;
    stealthMode?: boolean;
  }): Promise<unknown> {
    const payload: SendMessagePayload = {
      group_chat_id: params.groupChatId,
      notification: {
        status: "ok",
        body: params.body,
        ...(params.metadata && { metadata: params.metadata }),
        ...(params.mentions && { mentions: params.mentions }),
        ...(params.stealthMode && {
          opts: { stealth_mode: true },
        }),
      },
    };

    return this.client.post("/api/v4/botx/notifications/direct", payload);
  }

  async sendFile(params: {
    groupChatId: string;
    fileName: string;
    fileData: string;
    caption?: string;
  }): Promise<unknown> {
    const payload: SendMessagePayload = {
      group_chat_id: params.groupChatId,
      notification: {
        status: "ok",
        body: params.caption ?? "",
      },
      file: {
        file_name: params.fileName,
        data: params.fileData,
      },
    };

    return this.client.post("/api/v4/botx/notifications/direct", payload);
  }
}
