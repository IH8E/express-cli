import { Command } from "commander";
import { sendMessageViaWebSocket, sendImageViaWebSocket } from "../api/messaging-ws.js";
import { ApiClient } from "../api/client.js";
import { resolveChatId } from "../api/resolve.js";
import { formatOutput, type OutputFormat } from "./output.js";

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
    .command("file <chat-id-or-name> <file-path>")
    .description("Send a file to a chat (chat ID or partial name). Currently images only: .png, .jpg, .jpeg, .gif, .webp")
    .option("--caption <caption>", "File caption")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (chatIdOrName: string, filePath: string, opts: { caption?: string; host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const chatId = await resolveChatId(client, chatIdOrName);
        const result = await sendImageViaWebSocket({ client, chatId, filePath, caption: opts.caption });
        console.log(formatOutput(result, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
