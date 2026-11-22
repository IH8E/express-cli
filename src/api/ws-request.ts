import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { loadConfig, getBaseUrl, getWebOrigin } from "../config/index.js";
import { getAuthToken } from "../config/store.js";
import { loadApigwKeys } from "../auth/keys.js";

/** One-shot authenticated Phoenix request over a throwaway socket.
 *
 *  Every WS call in this file used to repeat the same 40 lines: open, authenticate,
 *  send, match the reply, tear down. Collecting it here keeps the per-feature code to
 *  the couple of lines that actually differ, and gives one place for the timeout and
 *  the error wording. Returns the `response` object of the `phx_reply`. */
export async function wsRequest(params: {
  topic: string;
  event: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const { topic, event, payload = {}, timeoutMs = 15000 } = params;

  const apigwKeys = loadApigwKeys();
  if (!apigwKeys) throw new Error("No apigw keys. Run 'express auth qr' first.");
  const config = loadConfig();
  const host = new URL(getBaseUrl(config)).hostname;
  const webOrigin = getWebOrigin(config);
  const ctsToken = getAuthToken();
  if (!ctsToken) throw new Error("Not authenticated. Run 'express auth qr' first.");
  const encKeyId = (apigwKeys.ctsKey ?? apigwKeys.encryptionKey).keyId;
  const wsUrl = `wss://${host}/socket/user/websocket?vsn=1.0.0&auto_join=true&key_id=${encKeyId}&version=6&background=false&instance_id=${randomUUID()}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      done(() => reject(new Error(`Timeout on ${event} (${timeoutMs}ms)`)));
    }, timeoutMs);

    const ws = new WebSocket(wsUrl, { headers: { Origin: webOrigin, "User-Agent": "Mozilla/5.0" } });
    const authRef = 0;
    const askRef = 1;

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ topic: "phoenix", event: "authenticate", payload: { token: ctsToken }, ref: authRef }));
    });

    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string) as {
        ref: number; event: string;
        payload: { status: string; response: Record<string, unknown> };
      };
      if (msg.ref === authRef && msg.event === "phx_reply") {
        if (msg.payload?.status !== "ok") {
          clearTimeout(timer); ws.close();
          done(() => reject(new Error(`WebSocket auth failed: ${JSON.stringify(msg.payload?.response)}`)));
          return;
        }
        ws.send(JSON.stringify({ topic, event, payload, ref: askRef }));
        return;
      }
      if (msg.ref === askRef && msg.event === "phx_reply") {
        clearTimeout(timer); ws.close();
        if (msg.payload?.status === "ok") done(() => resolve(msg.payload.response ?? {}));
        else done(() => reject(new Error(`${event} failed: ${JSON.stringify(msg.payload?.response)}`)));
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(timer);
      done(() => reject(new Error(`WS error: ${String(err)}`)));
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      done(() => reject(new Error(`WS closed before ${event} replied`)));
    });
  });
}
