import { randomUUID } from "node:crypto";

/** Reserved sentinel huid the client uses for a broadcast "@all" mention —
 * not a real profile, cts_profiles/query and chats info both return nothing for it. */
export const ALL_MENTION_HUID = "8551ce6a-a2aa-5aad-b0e4-0301e65e73e8";
export const MENTION_RE = /@\{mention:([0-9a-fA-F-]{36})\}/g;

/** A mention as the client stores it next to `body` (payload.mentions). */
export interface WireMention {
  mention_type: "user" | "all" | string;
  mention_id: string;
  mention_data?: { user_huid?: string; name?: string; conn_type?: string };
}

/** The body token points at a per-message mention_id, not at the person — rewrite it to the huid
 * (ALL_MENTION_HUID for @all) so names, `mentions` and `mentions_me` work on the person. */
export function mentionTokensToHuids(body: string, mentions?: WireMention[]): string {
  if (!mentions?.length) return body;
  const byId = new Map(mentions.map((m) => [m.mention_id, m.mention_type === "all" ? ALL_MENTION_HUID : m.mention_data?.user_huid]));
  return body.replace(MENTION_RE, (token, id: string) => {
    const huid = byId.get(id);
    return huid ? `@{mention:${huid}}` : token;
  });
}

/** Someone to mention: a person (huid + name) or everyone. */
export type MentionTarget = { all: true } | { all?: false; user_huid: string; name: string };

/** Body + payload.mentions the way the web client sends them (HAR 26.10): each mention gets a fresh
 * mention_id that the body token points at. `{0}`, `{1}`… in the text place the n-th mention; targets
 * without a placeholder go to the start. */
export function applyMentions(text: string, targets: MentionTarget[]): { body: string; mentions: WireMention[] } {
  const mentions: WireMention[] = targets.map((t) => ({
    mention_type: t.all ? "all" : "user",
    mention_id: randomUUID(),
    mention_data: t.all ? { name: "all" } : { conn_type: "cts", user_huid: t.user_huid, name: t.name },
  }));
  let body = text;
  const lead: string[] = [];
  mentions.forEach((m, i) => {
    const token = `@{mention:${m.mention_id}}`;
    if (body.includes(`{${i}}`)) body = body.split(`{${i}}`).join(token);
    else lead.push(token);
  });
  return { body: lead.length ? `${lead.join(" ")} ${body}` : body, mentions };
}
