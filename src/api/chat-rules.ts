import { wsRequest } from "./ws-request.js";

/** One upload constraint the chat enforces. `file_size: 0` with a `file_ext` list means those
 *  extensions are blocked outright (0 MB allowed), not "no limit". */
export interface ChatRule {
  action: string;
  rule_meta: {
    file_size?: number;
    content_type?: string;
    file_ext?: string[];
  };
}

export interface ChatRules {
  /** Per-content-type size limits in MB. */
  uploadLimits: Array<{ content_type: string; file_size_mb: number }>;
  /** Extensions the chat refuses to upload. */
  blockedExtensions: string[];
}

/** Upload rules for a chat (`get_rules` on the chat's topic → `{rules: [...]}`).
 *
 *  Worth knowing before sending a file: the server rejects the upload anyway, but the error
 *  arrives after the bytes are already encrypted and posted, so checking first is cheaper.
 *  A rule with `file_size: 0` and a `file_ext` list is a denial, not a zero limit. */
export async function getChatRules(params: {
  chatId: string;
  /** Injection point for tests; defaults to the real WS call. */
  request?: typeof wsRequest;
}): Promise<ChatRules> {
  const { chatId, request = wsRequest } = params;
  const response = await request({
    topic: `groupchat:${chatId}`,
    event: "get_rules",
    payload: { group_chat_id: chatId },
  }) as { rules?: ChatRule[] };

  const rules = response.rules ?? [];
  const uploadLimits: Array<{ content_type: string; file_size_mb: number }> = [];
  const blockedExtensions = new Set<string>();

  for (const rule of rules) {
    if (rule.action !== "upload") continue;
    const meta = rule.rule_meta ?? {};
    if (Array.isArray(meta.file_ext) && meta.file_ext.length) {
      for (const ext of meta.file_ext) blockedExtensions.add(ext.toLowerCase());
      continue;
    }
    if (typeof meta.file_size === "number" && meta.content_type) {
      uploadLimits.push({ content_type: meta.content_type, file_size_mb: meta.file_size });
    }
  }

  return { uploadLimits, blockedExtensions: [...blockedExtensions].sort() };
}
