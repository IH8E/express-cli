import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { loadApigwKeys } from "../auth/keys.js";
import { getAuthToken } from "../config/store.js";
import { loadConfig, getBaseUrl, getWebOrigin } from "../config/index.js";
import { decryptMessages, type HistoryMessage, type DecryptedMessage } from "./decrypt.js";

export async function readMessages(params: {
  chatId: string;
  limit?: number;
  timeoutMs?: number;
  direction?: "backward" | "forward";
  host?: string;
}): Promise<DecryptedMessage[]> {
  const { chatId, limit = 20, timeoutMs = 20000, direction = "backward", host } = params;

  const apigwKeys = loadApigwKeys();
  if (!apigwKeys) throw new Error("No apigw keys. Run 'express auth login' first.");

  const config = loadConfig(host ? { host } : {});
  const ctsHost = new URL(getBaseUrl(config)).hostname;
  const webOrigin = getWebOrigin(config);
  const ctsToken = getAuthToken();
  const ctsKey = apigwKeys.ctsKey ?? apigwKeys.encryptionKey;

  const history = await fetchEventsHistory(ctsHost, webOrigin, ctsToken, ctsKey.keyId, chatId, limit, timeoutMs, direction);
  return decryptMessages(history, apigwKeys);
}

async function fetchEventsHistory(
  host: string,
  webOrigin: string,
  ctsToken: string,
  encKeyId: string,
  chatId: string,
  limit: number,
  timeoutMs: number,
  direction: "backward" | "forward" = "backward",
): Promise<HistoryMessage[]> {
  const wsUrl = `wss://${host}/socket/user/websocket?vsn=1.0.0&auto_join=true&key_id=${encKeyId}&version=6&background=false&voex_unencrypted=true&instance_id=${randomUUID()}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      done(() => reject(new Error("Timeout fetching messages")));
    }, timeoutMs);

    const ws = new WebSocket(wsUrl, {
      headers: { Origin: webOrigin, "User-Agent": "Mozilla/5.0" },
    });

    let ref = 0;
    const authRef = ref++;
    let subRef = 0;
    let histRef = 0;

    const send = (msg: object) => ws.send(JSON.stringify(msg));

    ws.addEventListener("open", () => {
      send({ topic: "phoenix", event: "authenticate", payload: { token: ctsToken }, ref: authRef });
    });

    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string) as {
        ref: number | string; event: string; topic: string;
        payload: Record<string, unknown>;
      };

      const msgRef = typeof msg.ref === "string" ? parseInt(msg.ref, 10) : msg.ref;

      if (msgRef === authRef && msg.event === "phx_reply" && msg.payload?.status === "ok") {
        subRef = ref++;
        send({ topic: `groupchat:${chatId}`, event: "subscribe_to_chat_activities", payload: { group_chat_id: chatId }, ref: subRef });
        return;
      }

      if (msgRef === subRef && msg.event === "phx_reply") {
        histRef = ref++;
        send({
          topic: `groupchat:${chatId}`,
          event: "events_history",
          payload: {
            direction,
            group_chat_id: chatId,
            limit,
            skip_non_affecting_rc: true,
            skip_to_sync_id_event: true,
            last_ignore_messages_at: null,
          },
          ref: histRef,
        });
        return;
      }

      if (msgRef === histRef && msg.event === "phx_reply") {
        clearTimeout(timer);
        ws.close();
        const response = (msg.payload?.response ?? msg.payload) as Record<string, unknown>;
        const history = (response?.history ?? []) as HistoryMessage[];
        done(() => resolve(Array.isArray(history) ? history : []));
        return;
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(timer);
      done(() => reject(new Error(`WS error: ${String(err)}`)));
    });

    ws.addEventListener("close", () => {
      clearTimeout(timer);
      done(() => reject(new Error("WS closed before messages received")));
    });
  });
}
