import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import TextInput from "ink-text-input";
import { ExpressSession, type SessionMessage, type ThreadSummary } from "../session/session.js";
import { readMessages } from "../api/messages-read.js";
import { sendMessageViaWebSocket } from "../api/messaging-ws.js";
import { UserApi } from "../api/user.js";
import { ApiClient } from "../api/client.js";
import { renderImage } from "./image.js";
import type { ImageAttachment } from "../api/decrypt.js";
import type { ExpressChat } from "../types/index.js";

interface DisplayMsg {
  syncId: string;
  sender: string;
  body: string;
  decrypted: boolean;
  error?: string;
  insertedAt: string;
  type?: string;
  image?: ImageAttachment;
}

type Focus = "chats" | "thread" | "input" | "discussions";

const LIST_TYPES = new Set(["chat", "group_chat", "channel", "notes"]);
const shortHuid = (h: string) => (h ? h.slice(0, 8) : "unknown");
const clock = (iso: string) => {
  const d = iso ? new Date(iso) : new Date();
  return Number.isNaN(d.getTime()) ? "--:--" : d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
};

const MENTION_RE = /@\{mention:([0-9a-fA-F-]{36})\}/g;
type Seg = { mention?: string; text?: string };
function parseBody(body: string): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(body))) {
    if (m.index > last) out.push({ text: body.slice(last, m.index) });
    out.push({ mention: m[1] });
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last) });
  return out.length ? out : [{ text: body }];
}

const toDisplay = (m: { sync_id: string; sender: string; body: string; decrypted: boolean; error?: string; inserted_at: string; type?: string; image?: ImageAttachment }): DisplayMsg =>
  ({ syncId: m.sync_id, sender: m.sender, body: m.body, decrypted: m.decrypted, error: m.error, insertedAt: m.inserted_at, type: m.type, image: m.image });

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { isRawModeSupported } = useStdin();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 80;

  const sessionRef = useRef<ExpressSession | null>(null);
  const [chats, setChats] = useState<ExpressChat[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [selected, setSelected] = useState(0);
  const [messages, setMessages] = useState<Record<string, DisplayMsg[]>>({});
  const [status, setStatus] = useState<{ text: string; color: string }>({ text: "connecting…", color: "yellow" });
  const [focus, setFocus] = useState<Focus>("chats");
  const [draft, setDraft] = useState("");
  const [selfHuid, setSelfHuid] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [msgCursor, setMsgCursor] = useState(0);
  const [discussionsOpen, setDiscussionsOpen] = useState(false);
  const [threadCursor, setThreadCursor] = useState(0);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [threadTitles, setThreadTitles] = useState<Record<string, string>>({});
  const [renderedImages, setRenderedImages] = useState<Record<string, string>>({});
  const requested = useRef<Set<string>>(new Set());
  const titleRequested = useRef<Set<string>>(new Set());
  const imgRequested = useRef<Set<string>>(new Set());
  const currentIdRef = useRef<string | undefined>(undefined);

  const visibleChats = useMemo(
    () =>
      chats
        .filter((c) => LIST_TYPES.has(c.chat_type) && !c.left)
        .sort((a, b) => (b.last_event_inserted_at ?? "").localeCompare(a.last_event_inserted_at ?? "")),
    [chats],
  );

  const current = visibleChats[selected];
  const currentId = current?.group_chat_id;
  currentIdRef.current = currentId;

  const threadsForChat = useMemo(
    () => threads.filter((t) => t.group_chat_id === currentId).sort((a, b) => (b.last_event_inserted_at ?? "").localeCompare(a.last_event_inserted_at ?? "")),
    [threads, currentId],
  );
  const activeMessages = openThreadId ? messages[openThreadId] : (currentId ? messages[currentId] : undefined);

  const resolveHuids = (huids: string[]) => {
    const need = [...new Set(huids)].filter((h) => h && h.length >= 30 && !requested.current.has(h));
    if (need.length === 0) return;
    need.forEach((h) => requested.current.add(h));
    new UserApi(new ApiClient()).getProfilesByHuid(need)
      .then((profiles) => setNames((prev) => {
        const next = { ...prev };
        for (const p of profiles) if (p.name) next[p.user_huid] = p.name;
        return next;
      }))
      .catch(() => need.forEach((h) => requested.current.delete(h)));
  };

  const displayChatName = (c: ExpressChat): string => {
    if (c.chat_type === "chat" && c.member_huids && selfHuid) {
      const other = c.member_huids.find((h) => h !== selfHuid);
      if (other && names[other]) return names[other];
    }
    return c.name?.trim() || c.group_chat_id.slice(0, 8);
  };

  const senderLabel = (huid: string): string =>
    huid === selfHuid || huid === "me" ? "you" : names[huid] || shortHuid(huid);

  // A thread's title = its root (oldest) message
  const fetchThreadTitle = (threadId: string) => {
    if (threadTitles[threadId] || titleRequested.current.has(threadId)) return;
    titleRequested.current.add(threadId);
    readMessages({ chatId: threadId, limit: 1, direction: "forward" })
      .then((h) => {
        const root = h.find((m) => m.decrypted && m.body);
        if (root) setThreadTitles((p) => ({ ...p, [threadId]: root.body.replace(/\s+/g, " ").trim() }));
      })
      .catch(() => titleRequested.current.delete(threadId));
  };
  const threadTitle = (threadId: string) => threadTitles[threadId];

  // Session lifecycle
  useEffect(() => {
    let session: ExpressSession;
    try {
      session = new ExpressSession();
    } catch (err) {
      setStatus({ text: (err as Error).message, color: "red" });
      return;
    }
    sessionRef.current = session;

    session.on("connected", () => setStatus({ text: "connected", color: "green" }));
    session.on("chats", (list: ExpressChat[]) => setChats(list));
    session.on("threads", (list: ThreadSummary[]) => setThreads(list));
    session.on("message", (m: SessionMessage) => {
      setMessages((prev) => {
        const list = prev[m.chatId] ?? [];
        if (list.some((x) => x.syncId === m.syncId)) return prev;
        const next: DisplayMsg = { syncId: m.syncId, sender: m.sender, body: m.body, decrypted: m.decrypted, error: m.error, insertedAt: m.insertedAt, type: m.type, image: m.image };
        return { ...prev, [m.chatId]: [...list, next].slice(-200) };
      });
      if (m.chatId !== currentIdRef.current) setUnread((u) => ({ ...u, [m.chatId]: (u[m.chatId] ?? 0) + 1 }));
    });
    session.on("reconnecting", ({ attempt }: { attempt: number }) => setStatus({ text: `reconnecting (#${attempt})…`, color: "yellow" }));
    session.on("disconnected", () => setStatus({ text: "disconnected", color: "yellow" }));
    session.on("error", () => { /* status reflects it on disconnect */ });

    session.connect().catch((err) => setStatus({ text: (err as Error).message, color: "red" }));
    new UserApi(new ApiClient()).getSelfProfile().then((p) => setSelfHuid(p.user_huid)).catch(() => {});
    return () => session.close();
  }, []);

  const send = async (text: string) => {
    const body = text.trim();
    setDraft("");
    const target = openThreadId ?? currentId;
    if (!body || !target) return;
    const localId = `local-${Date.now()}`;
    const optimistic: DisplayMsg = { syncId: localId, sender: selfHuid || "me", body, decrypted: true, insertedAt: new Date().toISOString() };
    setMessages((prev) => ({ ...prev, [target]: [...(prev[target] ?? []), optimistic].slice(-200) }));
    try {
      await sendMessageViaWebSocket({ client: new ApiClient(), chatId: target, body });
    } catch (err) {
      setMessages((prev) => ({
        ...prev,
        [target]: (prev[target] ?? []).map((m) => (m.syncId === localId ? { ...m, decrypted: false, error: (err as Error).message } : m)),
      }));
    }
  };

  // Load history for a chat / thread when first opened (threads read the same way)
  const loadHistory = (id: string) => {
    if (messages[id]) return;
    readMessages({ chatId: id, limit: 40 })
      .then((h) => setMessages((prev) => (prev[id] ? prev : { ...prev, [id]: h.map(toDisplay) })))
      .catch(() => setMessages((prev) => (prev[id] ? prev : { ...prev, [id]: [] })));
  };
  useEffect(() => { if (currentId) loadHistory(currentId); }, [currentId]);
  useEffect(() => { if (openThreadId) { loadHistory(openThreadId); fetchThreadTitle(openThreadId); setMsgCursor((messages[openThreadId]?.length ?? 1) - 1); } }, [openThreadId]);

  // Resolve DM partner names
  useEffect(() => {
    if (!selfHuid) return;
    resolveHuids(visibleChats.filter((c) => c.chat_type === "chat").flatMap((c) => (c.member_huids ?? []).filter((h) => h !== selfHuid)));
  }, [chats, selfHuid]);

  // Resolve sender + mention names for the active message view
  useEffect(() => {
    if (!activeMessages) return;
    resolveHuids(activeMessages.flatMap((m) => [m.sender, ...parseBody(m.body).filter((s) => s.mention).map((s) => s.mention!)]));
  }, [activeMessages]);

  // Reset per-chat view state on chat change
  useEffect(() => {
    setDiscussionsOpen(false);
    setOpenThreadId(null);
    if (currentId) setUnread((u) => (u[currentId] ? { ...u, [currentId]: 0 } : u));
  }, [currentId]);

  // Fetch thread titles (root messages) when the discussions panel is open
  useEffect(() => {
    if (!discussionsOpen) return;
    threadsForChat.forEach((t) => fetchThreadTitle(t.thread_id));
  }, [discussionsOpen, threadsForChat]);

  // Render the inline preview of the currently-selected image message
  useEffect(() => {
    const m = focus === "thread" ? activeMessages?.[msgCursor] : undefined;
    const uri = m?.image?.previewDataUri;
    if (!m || !uri || renderedImages[m.syncId] || imgRequested.current.has(m.syncId)) return;
    imgRequested.current.add(m.syncId);
    const w = Math.min(40, Math.max(10, cols - 36));
    renderImage(uri, w)
      .then((s) => setRenderedImages((p) => ({ ...p, [m.syncId]: s })))
      .catch(() => imgRequested.current.delete(m.syncId));
  }, [focus, msgCursor, activeMessages]);

  useInput((input, key) => {
    if (focus === "input") { if (key.escape) setFocus(openThreadId ? "thread" : "chats"); return; }
    if (input === "q" || (key.ctrl && input === "c")) { sessionRef.current?.close(); exit(); return; }

    // Toggle discussions panel for the current chat
    if (input === "t" && currentId && !openThreadId) {
      if (discussionsOpen) { setDiscussionsOpen(false); setFocus("chats"); }
      else { setDiscussionsOpen(true); setThreadCursor(0); setFocus("discussions"); }
      return;
    }

    if (focus === "chats") {
      if (key.upArrow || input === "k") setSelected((i) => Math.max(0, i - 1));
      else if (key.downArrow || input === "j") setSelected((i) => Math.min(visibleChats.length - 1, i + 1));
      else if ((key.rightArrow || key.tab) && currentId) { setMsgCursor((activeMessages?.length ?? 1) - 1); setFocus("thread"); }
      else if (key.return && currentId) setFocus("input");
    } else if (focus === "discussions") {
      if (key.upArrow || input === "k") setThreadCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow || input === "j") setThreadCursor((c) => Math.min(threadsForChat.length - 1, c + 1));
      else if (key.return && threadsForChat[threadCursor]) { setOpenThreadId(threadsForChat[threadCursor].thread_id); setFocus("thread"); }
      else if (key.leftArrow || key.escape) { setDiscussionsOpen(false); setFocus("chats"); }
    } else if (focus === "thread") {
      const len = activeMessages?.length ?? 0;
      if (key.upArrow || input === "k") setMsgCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow || input === "j") setMsgCursor((c) => Math.min(len - 1, c + 1));
      else if (key.leftArrow || key.escape) {
        if (openThreadId) { setOpenThreadId(null); setFocus("discussions"); }
        else setFocus("chats");
      }
      else if (key.return) setFocus("input");
    }
  }, { isActive: isRawModeSupported });

  // --- Layout / viewport ---
  const bodyHeight = Math.max(4, rows - 4);
  const rightWidth = Math.max(20, cols - 34);
  const listWindow = windowAround(selected, visibleChats.length, bodyHeight);
  const showDiscussions = discussionsOpen && !openThreadId;

  const estLines = (m: DisplayMsg): number => {
    let n = 9 + senderLabel(m.sender).length + 2;
    for (const seg of parseBody(m.body)) n += seg.mention ? 1 + (names[seg.mention]?.length ?? 8) : (seg.text?.length ?? 0);
    return Math.max(1, Math.ceil(n / rightWidth));
  };
  let threadStart = activeMessages ? activeMessages.length : 0;
  if (activeMessages) {
    let used = 0;
    while (threadStart > 0 && used < bodyHeight) { used += estLines(activeMessages[threadStart - 1]); threadStart--; }
    if (focus === "thread" && msgCursor < threadStart) threadStart = msgCursor;
  }
  const threadView = activeMessages ? activeMessages.slice(threadStart) : undefined;

  const renderBody = (m: DisplayMsg) =>
    parseBody(m.body).map((seg, i) =>
      seg.mention
        ? <Text key={i} color="magenta">@{names[seg.mention] || shortHuid(seg.mention)}</Text>
        : <Text key={i}>{seg.text}</Text>,
    );

  const rightBorder = focus === "input" ? "green" : (focus === "thread" || focus === "discussions") ? "cyan" : "gray";
  const rightTitle = openThreadId
    ? `💬 ${threadTitle(openThreadId) ?? "Обсуждение"}`
    : (current ? displayChatName(current) : "—") + (threadsForChat.length ? `  💬 ${threadsForChat.length}` : "");

  return (
    <Box flexDirection="column" height={rows}>
      <Box>
        <Text> </Text>
        <Text color={status.color}>●</Text>
        <Text> eXpress TUI — </Text>
        <Text color={status.color}>{status.text}</Text>
        <Text dimColor>  ({visibleChats.length} chats)</Text>
      </Box>

      <Box flexGrow={1}>
        <Box flexDirection="column" width={32} borderStyle="single" borderColor={focus === "chats" ? "cyan" : "gray"} paddingX={1}>
          {visibleChats.length === 0 && <Text dimColor>loading…</Text>}
          {visibleChats.slice(listWindow.start, listWindow.end).map((c, i) => {
            const idx = listWindow.start + i;
            const active = idx === selected;
            const n = unread[c.group_chat_id] ?? 0;
            return (
              <Text key={c.group_chat_id} color={active ? "black" : n > 0 ? "cyan" : undefined} backgroundColor={active ? "cyan" : undefined} bold={n > 0 && !active} wrap="truncate">
                {active ? "› " : "  "}{displayChatName(c)}{n > 0 ? ` (${n})` : ""}
              </Text>
            );
          })}
        </Box>

        <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor={rightBorder} paddingX={1}>
          <Text bold wrap="truncate">{rightTitle}</Text>
          <Box flexDirection="column" flexGrow={1}>
            {showDiscussions ? (
              <>
                {threadsForChat.length === 0 && <Text dimColor>no discussions</Text>}
                {threadsForChat.map((t, i) => {
                  const on = focus === "discussions" && i === threadCursor;
                  const title = threadTitle(t.thread_id) ?? t.thread_id.slice(0, 8);
                  return (
                    <Text key={t.thread_id} color={on ? "black" : undefined} backgroundColor={on ? "cyan" : undefined} wrap="truncate">
                      {on ? "› " : "  "}💬 {title}  <Text dimColor={!on}>· {t.counter ?? 0} · {clock(t.last_event_inserted_at ?? "")}</Text>
                    </Text>
                  );
                })}
              </>
            ) : (
              <>
                {!current && <Text dimColor>select a chat</Text>}
                {current && !threadView && <Text dimColor>loading messages…</Text>}
                {threadView && threadView.length === 0 && <Text dimColor>no messages</Text>}
                {threadView?.map((m, i) => {
                  const idx = threadStart + i;
                  const mine = m.sender === selfHuid || m.sender === "me";
                  const onCursor = focus === "thread" && idx === msgCursor;
                  const img = renderedImages[m.syncId];
                  return (
                    <Box key={m.syncId} flexDirection="column">
                      <Text wrap="wrap">
                        <Text color={onCursor ? "cyan" : undefined}>{onCursor ? "▍" : " "}</Text>
                        <Text dimColor>[{clock(m.insertedAt)}] </Text>
                        <Text color={mine ? "green" : "yellow"}>{senderLabel(m.sender)}</Text>
                        <Text>: </Text>
                        {!m.decrypted
                          ? <Text color="red">[{m.error ? "send failed" : "decrypt failed"}]</Text>
                          : m.image
                            ? <Text color="cyan">🖼 {m.image.fileName}{m.body ? ` — ${m.body}` : ""}</Text>
                            : renderBody(m)}
                      </Text>
                      {onCursor && m.image?.previewDataUri && (img ? <Text>{img}</Text> : <Text dimColor>  rendering preview…</Text>)}
                    </Box>
                  );
                })}
              </>
            )}
          </Box>
          {current && !showDiscussions && (
            <Box>
              <Text color={focus === "input" ? "green" : "gray"}>{focus === "input" ? "› " : "  "}</Text>
              <TextInput value={draft} onChange={setDraft} onSubmit={send} focus={focus === "input"} placeholder={focus === "input" ? "type a message…" : "Enter to write"} />
            </Box>
          )}
        </Box>
      </Box>

      <Box>
        <Text dimColor> {footerHint(focus, openThreadId != null)}</Text>
      </Box>
    </Box>
  );
}

function footerHint(focus: Focus, inThread: boolean): string {
  if (focus === "input") return "Enter send · Esc cancel";
  if (focus === "discussions") return "↑/↓ discussions · Enter open · Esc back";
  if (focus === "thread") return `↑/↓ messages · ← ${inThread ? "discussions" : "chats"} · Enter write · q quit`;
  return "↑/↓ chats · → open thread · t discussions · Enter write · q quit";
}

/** Scrolling window that keeps `selected` visible within `size` rows. */
function windowAround(selected: number, total: number, size: number): { start: number; end: number } {
  if (total <= size) return { start: 0, end: total };
  let start = selected - Math.floor(size / 2);
  start = Math.max(0, Math.min(start, total - size));
  return { start, end: start + size };
}
