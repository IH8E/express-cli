/** Active typing hints, keyed by chat then huid → expiry epoch ms. */
export type TypingState = Record<string, Record<string, number>>;

/** Apply one `typing` / `stop_typing` push.
 *
 *  The server sends no "stopped" when a draft is simply abandoned, so every hint carries an
 *  expiry and `activeTypers` drops it on read — a pure function, which keeps the TUI free of
 *  a second timer-driven code path and makes the behaviour testable. */
export function applyTyping(
  state: TypingState,
  event: { chatId: string; userHuid: string; stopped: boolean },
  now: number,
  ttlMs = 5000,
): TypingState {
  if (!event.userHuid) return state;
  const chat = { ...(state[event.chatId] ?? {}) };
  if (event.stopped) delete chat[event.userHuid];
  else chat[event.userHuid] = now + ttlMs;
  return { ...state, [event.chatId]: chat };
}

/** Huids still typing in a chat at `now`. */
export function activeTypers(state: TypingState, chatId: string, now: number): string[] {
  const chat = state[chatId] ?? {};
  return Object.entries(chat)
    .filter(([, until]) => until > now)
    .map(([huid]) => huid);
}

/** One-line label for the header: "Иванов, Петров печатает…" (or "" when nobody is). */
export function typingLabel(huids: string[], nameOf: (huid: string) => string): string {
  if (!huids.length) return "";
  const shown = huids.slice(0, 2).map(nameOf).join(", ");
  const extra = huids.length > 2 ? ` +${huids.length - 2}` : "";
  return `${shown}${extra} печатает…`;
}
