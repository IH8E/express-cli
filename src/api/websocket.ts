import type { ExpressChat } from "../types/index.js";
import { randomUUID } from "node:crypto";

interface PhxMessage {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
  ref: number;
}

interface PhxReply {
  ref: number;
  event: string;
  topic: string;
  payload: {
    status: "ok" | "error";
    response: Record<string, unknown>;
  };
}

export async function fetchChatListViaWebSocket(params: {
  host: string;
  ctsToken: string;
  encryptionKeyId: string;
  timeoutMs?: number;
}): Promise<ExpressChat[]> {
  const { host, ctsToken, encryptionKeyId, timeoutMs = 15000 } = params;
  const instanceId = randomUUID();

  const wsUrl = `wss://${host}/socket/user/websocket?vsn=1.0.0&auto_join=true&key_id=${encryptionKeyId}&version=6&background=false&voex_unencrypted=true&voex_multistream=true&voex_audio_bridge=true&instance_id=${instanceId}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (!settled) { settled = true; fn(); }
    };

    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      done(() => reject(new Error("WebSocket timeout: no chat_list response")));
    }, timeoutMs);

    const hostParts = host.split('.');
  const webOrigin = `https://${hostParts.length > 2 ? hostParts.slice(1).join('.') : host}`;

  const ws = new WebSocket(wsUrl, {
      headers: {
        Origin: webOrigin,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      },
    } as ConstructorParameters<typeof WebSocket>[1]);

    const authRef = 0;
    const chatListRef = 1;

    const send = (msg: PhxMessage) => {
      ws.send(JSON.stringify(msg));
    };

    ws.addEventListener("open", () => {
      send({ topic: "phoenix", event: "authenticate", payload: { token: ctsToken }, ref: authRef });
    });

    ws.addEventListener("message", (event) => {
      let msg: PhxReply;
      try {
        msg = JSON.parse(event.data as string) as PhxReply;
      } catch {
        return;
      }

      if (msg.ref === authRef && msg.topic === "phoenix" && msg.event === "phx_reply") {
        if (msg.payload.status !== "ok") {
          clearTimeout(timer);
          ws.close();
          done(() => reject(new Error(`WebSocket auth failed: ${JSON.stringify(msg.payload.response)}`)));
          return;
        }
        send({ topic: "system", event: "chat_list", payload: { since: null, request_version: 6 }, ref: chatListRef });
        return;
      }

      if (msg.ref === chatListRef && msg.topic === "system" && msg.event === "phx_reply") {
        if (msg.payload.status !== "ok") {
          clearTimeout(timer);
          ws.close();
          done(() => reject(new Error(`WebSocket chat_list failed: ${JSON.stringify(msg.payload.response)}`)));
          return;
        }
        const response = msg.payload.response as { chat_list?: ExpressChat[] };
        if (Array.isArray(response.chat_list)) {
          clearTimeout(timer);
          ws.close();
          done(() => resolve(response.chat_list!));
        }
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(timer);
      done(() => reject(new Error(`WebSocket connection error: ${String(err)}`)));
    });

    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      done(() => reject(new Error(`WebSocket closed before completion (code=${event.code})`)));
    });
  });
}
