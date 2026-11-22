import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { loadConfig, getBaseUrl, getWebOrigin } from "../config/index.js";
import { getAuthToken } from "../config/store.js";
import { loadApigwKeys } from "../auth/keys.js";

export interface PresenceStatus {
  user_huid: string;
  status: string;
  status_changed: string;
  in_call: boolean;
}

/** Presence for a set of people.
 *
 *  Presence is push-only: `system/users_status_list` arrives unsolicited, and the only way
 *  to ask for it is to subscribe (`subscribe_contacts_presences {user_huids}`) and read the
 *  broadcast that follows. There is no request/reply, so this opens a socket, subscribes,
 *  waits for the first broadcast, and closes — a snapshot, not a live feed.
 *
 *  The REST route `/api/v1/user_statuses/get` looks like the obvious answer and returns an
 *  empty list in practice, which is why this goes through the socket. */
export async function getPresence(params: {
  userHuids: string[];
  timeoutMs?: number;
}): Promise<PresenceStatus[]> {
  const { userHuids, timeoutMs = 8000 } = params;
  if (!userHuids.length) return [];

  const apigwKeys = loadApigwKeys();
  if (!apigwKeys) throw new Error("No apigw keys. Run 'express auth qr' first.");
  const config = loadConfig();
  const host = new URL(getBaseUrl(config)).hostname;
  const webOrigin = getWebOrigin(config);
  const ctsToken = getAuthToken();
  if (!ctsToken) throw new Error("Not authenticated. Run 'express auth qr' first.");
  const encKeyId = (apigwKeys.ctsKey ?? apigwKeys.encryptionKey).keyId;
  const wsUrl = `wss://${host}/socket/user/websocket?vsn=1.0.0&auto_join=true&key_id=${encKeyId}&version=6&background=false&instance_id=${randomUUID()}`;
  const wanted = new Set(userHuids);

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      // No broadcast within the window is not a failure: report what we know (nothing).
      done(() => resolve([]));
    }, timeoutMs);

    const ws = new WebSocket(wsUrl, { headers: { Origin: webOrigin, "User-Agent": "Mozilla/5.0" } });
    const authRef = 0;
    const subRef = 1;

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ topic: "phoenix", event: "authenticate", payload: { token: ctsToken }, ref: authRef }));
    });

    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string) as {
        ref: number | null; event: string;
        payload: Record<string, unknown> & { status?: string; users_status_list?: PresenceStatus[] };
      };
      if (msg.ref === authRef && msg.event === "phx_reply") {
        if (msg.payload?.status !== "ok") {
          clearTimeout(timer); ws.close();
          done(() => reject(new Error(`WebSocket auth failed: ${JSON.stringify(msg.payload)}`)));
          return;
        }
        ws.send(JSON.stringify({
          topic: "system", event: "subscribe_contacts_presences",
          payload: { user_huids: [...wanted] }, ref: subRef,
        }));
        return;
      }
      // The broadcast is unprompted (ref: null) and may be partial — take it as-is.
      if (msg.event === "users_status_list" && Array.isArray(msg.payload?.users_status_list)) {
        const list = msg.payload.users_status_list.filter((s) => wanted.has(s.user_huid));
        if (list.length) {
          clearTimeout(timer); ws.close();
          done(() => resolve(list));
        }
      }
    });

    ws.addEventListener("error", (err) => { clearTimeout(timer); done(() => reject(new Error(`WS error: ${String(err)}`))); });
    ws.addEventListener("close", () => { clearTimeout(timer); done(() => resolve([])); });
  });
}
