import { Command } from "commander";
import { ChatsApi } from "../api/chats.js";
import { UserApi } from "../api/user.js";
import { getChatInfoViaWebSocket } from "../api/messaging-ws.js";
import { getCommonChats } from "../api/history.js";
import { getChatListChanges } from "../api/chat-changes.js";
import { markChatRead } from "../api/read-position.js";
import { getChatRules } from "../api/chat-rules.js";
import { readMessageEvents } from "../api/messages-read.js";
import { resolvePerson, resolveChatId } from "../api/resolve.js";
import { ApiClient } from "../api/client.js";
import { formatOutput, type OutputFormat } from "./output.js";
import type { ExpressChat } from "../types/index.js";
import Table from "cli-table3";
import chalk from "chalk";

async function resolveDmNames(chats: ExpressChat[], client: ApiClient): Promise<void> {
  const dmChats = chats.filter((c) => c.chat_type === "chat" && c.member_huids?.length);
  if (dmChats.length === 0) return;
  try {
    const userApi = new UserApi(client);
    const self = await userApi.getSelfProfile();
    const myHuid = self.user_huid;
    const otherHuids = [...new Set(
      dmChats.flatMap((c) => (c.member_huids ?? []).filter((h) => h !== myHuid)),
    )];
    if (otherHuids.length === 0) return;
    const profiles = await userApi.getProfilesByHuid(otherHuids);
    const nameMap = new Map(profiles.map((p) => [p.user_huid, p.name]));
    for (const chat of chats) {
      if (chat.chat_type === "chat" && chat.member_huids) {
        const otherHuid = chat.member_huids.find((h) => h !== myHuid);
        if (otherHuid) chat.name = nameMap.get(otherHuid) ?? chat.name;
      }
    }
  } catch (err) {
    if (process.env.EXPRESS_DEBUG) {
      console.error(`  [DEBUG] Failed to resolve DM names: ${(err as Error).message}`);
    }
  }
}

function typeLabel(chatType: string): string {
  if (chatType === "channel" || chatType === "global") return chalk.magenta(chatType);
  if (chatType === "group_chat") return chalk.blue("group");
  if (chatType === "chat") return chalk.green("dm");
  return chalk.gray(chatType);
}

function memberCount(c: ExpressChat): string {
  return c.members_count != null ? String(c.members_count) :
    c.member_huids?.length != null ? String(c.member_huids.length) : "-";
}

export function createChatsCommand(): Command {
  const cmd = new Command("chats");

  cmd.description("Chat management");

  cmd
    .command("list")
    .description("List all chats (uses WebSocket for full list)")
    .option("--host <host>", "eXpress host")
    .option("--type <type>", "Filter by type: dm, group, channel, all", "all")
    .option("-o, --output <format>", "Output format", "table")
    .action(async (opts: { host?: string; type: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const api = new ChatsApi(client);
        let chats = await api.listChats();

        await resolveDmNames(chats, client);

        if (opts.type !== "all") {
          const typeMap: Record<string, string[]> = {
            dm: ["chat"],
            group: ["group_chat"],
            channel: ["channel", "global"],
          };
          const allowed = typeMap[opts.type];
          // An unknown filter used to match nothing and print an empty list, which reads as
          // "you have no chats of that kind" instead of "that type does not exist".
          if (!allowed) {
            throw new Error(`Unknown --type "${opts.type}". Use one of: dm, group, channel, all.`);
          }
          chats = chats.filter((c) => allowed.includes(c.chat_type));
        }

        if (opts.output === "json") {
          console.log(formatOutput(chats, "json"));
          return;
        }

        const table = new Table({
          head: ["Name", "Type", "Members", "Chat ID"],
          style: { head: ["cyan"] },
        });

        for (const c of chats) {
          table.push([c.name ?? "-", typeLabel(c.chat_type), memberCount(c), c.group_chat_id.slice(0, 8) + "..."]);
        }

        console.log(table.toString());
        console.log(chalk.gray(`  ${chats.length} chats`));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("find <query>")
    .description("Find chats by name (case-insensitive), shows full IDs")
    .option("--host <host>", "eXpress host")
    .option("--type <type>", "Filter by type: dm, group, channel, all", "all")
    .option("-o, --output <format>", "Output format", "table")
    .action(async (query: string, opts: { host?: string; type: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const api = new ChatsApi(client);
        let chats = await api.listChats();

        await resolveDmNames(chats, client);

        const lowerQuery = query.toLowerCase();
        chats = chats.filter((c) => (c.name ?? "").toLowerCase().includes(lowerQuery));

        if (opts.type !== "all") {
          const typeMap: Record<string, string[]> = {
            dm: ["chat"],
            group: ["group_chat"],
            channel: ["channel", "global"],
          };
          const allowed = typeMap[opts.type];
          // An unknown filter used to match nothing and print an empty list, which reads as
          // "you have no chats of that kind" instead of "that type does not exist".
          if (!allowed) {
            throw new Error(`Unknown --type "${opts.type}". Use one of: dm, group, channel, all.`);
          }
          chats = chats.filter((c) => allowed.includes(c.chat_type));
        }

        if (chats.length === 0) {
          console.log(chalk.yellow(`No chats matching "${query}".`));
          return;
        }

        if (opts.output === "json") {
          console.log(formatOutput(chats, "json"));
          return;
        }

        const table = new Table({
          head: ["Name", "Type", "Members", "Chat ID (full)"],
          style: { head: ["cyan"] },
        });

        for (const c of chats) {
          table.push([c.name ?? "-", typeLabel(c.chat_type), memberCount(c), c.group_chat_id]);
        }

        console.log(table.toString());
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("info <chat-id>")
    .description("Get chat details")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (chatId: string, opts: { host?: string; output: OutputFormat }) => {
      try {
        // WS chat_info, not REST open_chats_list: the latter returns [] for every id.
        const chat = await getChatInfoViaWebSocket({ chatId });
        if (!chat) {
          console.error(`Chat not found: ${chatId}`);
          process.exit(1);
        }
        console.log(formatOutput(chat, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("common <person>")
    .description("Chats you share with a person (name, email or huid)")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (person: string, opts: { host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const profile = await resolvePerson(client, person);
        const chats = await getCommonChats({ client, userHuid: profile.user_huid });
        console.log(formatOutput({ person: profile.name, user_huid: profile.user_huid, count: chats.length, chats }, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("changes")
    .description("Incremental chat-list changes since a timestamp")
    .option("--since <iso>", "ISO timestamp of the last sync")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (opts: { since?: string; host?: string; output: OutputFormat }) => {
      try {
        const since = opts.since ? new Date(opts.since) : new Date(Date.now() - 86_400_000);
        if (Number.isNaN(since.getTime())) throw new Error(`Invalid --since "${opts.since}": expected an ISO timestamp.`);
        const changes = await getChatListChanges({ since: since.toISOString() });
        console.log(formatOutput({
          since: since.toISOString(),
          generated_at: changes.generated_at,
          base_count: changes.base.length,
          frequent_count: changes.frequent.length,
          base: changes.base,
          frequent: changes.frequent,
        }, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("read <chat-id-or-name>")
    .description("Mark a chat read up to the newest message")
    .option("--message <sync-id>", "Mark read up to this message instead of the newest")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (chatIdOrName: string, opts: { message?: string; host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const chatId = await resolveChatId(client, chatIdOrName);
        let positionId = opts.message;
        if (!positionId) {
          const newest = await readMessageEvents({ chatId, limit: 1 });
          positionId = newest[0]?.sync_id;
          if (!positionId) throw new Error("This chat has no messages to mark read.");
        }
        const result = await markChatRead({ chatId, positionSyncId: positionId });
        console.log(formatOutput(result, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("rules <chat-id-or-name>")
    .description("Upload limits and blocked file extensions for a chat")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (chatIdOrName: string, opts: { host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const chatId = await resolveChatId(client, chatIdOrName);
        const rules = await getChatRules({ chatId });
        console.log(formatOutput({ chat_id: chatId, ...rules }, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
