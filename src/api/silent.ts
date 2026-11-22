import { wsRequest } from "./ws-request.js";

/** "Do not disturb" for the account.
 *
 *  `silent_on` / `silent_off` are plain `system` events with an empty payload and an empty
 *  ok reply — the server tracks the flag itself, nothing is returned. Note this is NOT the
 *  per-message "stealth" mode (that one lives in the message payload as `stealth`).
 *  The commands are idempotent: turning it on when already on is not an error. */
export async function setSilentMode(params: {
  enabled: boolean;
}): Promise<{ silent: boolean }> {
  const { enabled } = params;
  await wsRequest({
    topic: "system",
    event: enabled ? "silent_on" : "silent_off",
    payload: {},
  });
  return { silent: enabled };
}
