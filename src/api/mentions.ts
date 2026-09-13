/** Reserved sentinel huid the client uses for a broadcast "@all" mention —
 * not a real profile, cts_profiles/query and chats info both return nothing for it. */
export const ALL_MENTION_HUID = "8551ce6a-a2aa-5aad-b0e4-0301e65e73e8";
export const MENTION_RE = /@\{mention:([0-9a-fA-F-]{36})\}/g;
