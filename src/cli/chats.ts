import { Command } from "commander";
import { ChatsApi } from "../api/chats.js";
import { UserApi } from "../api/user.js";
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
          const allowed = typeMap[opts.type] ?? [];
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
          const allowed = typeMap[opts.type] ?? [];
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
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const api = new ChatsApi(client);
        const chat = await api.getChatInfo(chatId);
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

  return cmd;
}
