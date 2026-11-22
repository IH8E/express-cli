import { Command } from "commander";
import { sendMessageViaWebSocket, listDelayedMessages, cancelDelayedMessage, sendFileViaWebSocket } from "../api/messaging-ws.js";
import { ApiClient } from "../api/client.js";
import { resolveChatId } from "../api/resolve.js";
import { parseSchedule } from "../api/schedule.js";
import { formatOutput, type OutputFormat } from "./output.js";

export function createSendCommand(): Command {
  const cmd = new Command("send");

  cmd.description("Send messages and files");

  cmd
    .command("message <chat-id-or-name> <text>")
    .description("Send a text message to a chat (chat ID or partial name)")
    .option("--stealth", "Send in stealth mode", false)
    .option("--at <when>", "Deliver later: ISO timestamp (2026-11-21T16:43:00Z) or '+5m' / '+2h'")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (chatIdOrName: string, text: string, opts: { stealth: boolean; at?: string; host?: string; output: OutputFormat }) => {
      try {
        const scheduledAt = opts.at ? parseSchedule(opts.at) : undefined;
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const chatId = await resolveChatId(client, chatIdOrName);
        const result = await sendMessageViaWebSocket({ client, chatId, body: text, scheduledAt });
        console.log(formatOutput(result, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("file <chat-id-or-name> <file-path>")
    .description("Send a file to a chat (chat ID or partial name). Images (.png, .jpg, .jpeg, .gif, .webp) go with a preview, anything else as a document")
    .option("--caption <caption>", "File caption")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (chatIdOrName: string, filePath: string, opts: { caption?: string; host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const chatId = await resolveChatId(client, chatIdOrName);
        const result = await sendFileViaWebSocket({ client, chatId, filePath, caption: opts.caption });
        console.log(formatOutput(result, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("delayed <chat-id-or-name>")
    .description("List messages queued for later delivery in a chat")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (chatIdOrName: string, opts: { host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const chatId = await resolveChatId(client, chatIdOrName);
        const pending = await listDelayedMessages({ client, chatId });
        console.log(formatOutput(pending.map((p) => ({
          sync_id: (p as Record<string, unknown>).sync_id,
          scheduled_at: (p as Record<string, unknown>).scheduled_at,
          failed_at: (p as Record<string, unknown>).failed_at ?? null,
        })), opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("cancel <chat-id-or-name> <sync-id>")
    .description("Cancel a delayed message before it is delivered")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (chatIdOrName: string, syncId: string, opts: { host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const chatId = await resolveChatId(client, chatIdOrName);
        await cancelDelayedMessage({ chatId, syncId });
        console.log(formatOutput({ cancelled: syncId, chat_id: chatId }, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
