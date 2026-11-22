import type { ExpressSession } from "../session/session.js";

export interface ThreadCounter {
  thread_id: string;
  counter: number;
}

/** Live thread-reply counters.
 *
 *  `messages_list` currently asks `thread_list` for every chat it shows, which is a round
 *  trip per chat just to read a number. The socket pushes `thread_counter_updated` on the
 *  chat's own topic whenever a reply lands (`payload.thread_counter[]`), so a long-lived
 *  session can keep the map warm and answer instantly.
 *
 *  This is a thin view over an existing `ExpressSession`: `activity` events carry the raw
 *  push, and the counters accumulate per chat. It does not open its own socket — the
 *  session layer already owns the single connection this account may have. */
export class ThreadCounters {
  private readonly byChat = new Map<string, Map<string, number>>();

  constructor(private readonly session: ExpressSession) {
    session.on("activity", this.onActivity);
  }

  private onActivity = (activity: unknown): void => {
    const a = activity as {
      topic?: string;
      event?: string;
      payload?: { thread_counter?: ThreadCounter[] };
    };
    if (a?.event !== "thread_counter_updated") return;
    const chatId = a.topic?.startsWith("groupchat:") ? a.topic.slice("groupchat:".length) : undefined;
    if (!chatId) return;
    const counters = a.payload?.thread_counter ?? [];
    if (!counters.length) return;

    let chatCounters = this.byChat.get(chatId);
    if (!chatCounters) {
      chatCounters = new Map();
      this.byChat.set(chatId, chatCounters);
    }
    for (const c of counters) {
      if (c.thread_id) chatCounters.set(c.thread_id, c.counter ?? 0);
    }
  };

  /** Reply count for one thread, if a push has been seen. */
  get(chatId: string, threadId: string): number | undefined {
    return this.byChat.get(chatId)?.get(threadId);
  }

  /** All known thread counters for a chat, as a plain map. */
  forChat(chatId: string): Record<string, number> {
    return Object.fromEntries(this.byChat.get(chatId) ?? []);
  }

  /** Stop listening; call when the owner tears the session down. */
  dispose(): void {
    this.session.off("activity", this.onActivity);
    this.byChat.clear();
  }
}
