import { Command } from "commander";
import { MessagingApi } from "../api/messaging.js";
import { sendMessageViaWebSocket } from "../api/messaging-ws.js";
import { ApiClient } from "../api/client.js";
import { resolveChatId } from "../api/resolve.js";
import { formatOutput, type OutputFormat } from "./output.js";
import { readFileSync } from "node:fs";

export function createSendCommand(): Command {
  const cmd = new Command("send");

  cmd.description("Send messages and files");

  cmd
    .command("message <chat-id-or-name> <text>")
    .description("Send a text message to a chat (chat ID or partial name)")
    .option("--stealth", "Send in stealth mode", false)
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (chatIdOrName: string, text: string, opts: { stealth: boolean; host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const chatId = await resolveChatId(client, chatIdOrName);
        const result = await sendMessageViaWebSocket({ client, chatId, body: text });
        console.log(formatOutput(result, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("file <chat-id> <file-path>")
    .description("Send a file to a chat")
    .option("--caption <caption>", "File caption")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (chatId: string, filePath: string, opts: { caption?: string; host?: string; output: OutputFormat }) => {
      try {
        const data = readFileSync(filePath);
        const fileName = filePath.split("/").pop() ?? "file";
        const mimeMap: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".pdf": "application/pdf",
          ".txt": "text/plain",
          ".json": "application/json",
          ".csv": "text/csv",
          ".zip": "application/zip",
        };
        const ext = fileName.includes(".") ? "." + fileName.split(".").pop()!.toLowerCase() : "";
        const mime = mimeMap[ext] ?? "application/octet-stream";
        const base64 = data.toString("base64");
        const dataUri = `data:${mime};base64,${base64}`;

        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const api = new MessagingApi(client);
        const result = await api.sendFile({
          groupChatId: chatId,
          fileName,
          fileData: dataUri,
          caption: opts.caption,
        });
        console.log(formatOutput(result, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
