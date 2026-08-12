import { Command } from "commander";
import { readMessages } from "../api/messages-read.js";
import { formatOutput, type OutputFormat } from "./output.js";

export function createMessagesCommand(): Command {
  const cmd = new Command("messages");

  cmd.description("Read and decrypt chat messages");

  cmd
    .command("list <chat-id>")
    .description("List recent messages from a chat")
    .option("-n, --limit <number>", "Number of messages", "20")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "table")
    .action(async (chatId: string, opts: { limit: string; host?: string; output: OutputFormat }) => {
      try {
        const messages = await readMessages({
          chatId,
          limit: parseInt(opts.limit, 10) || 20,
          host: opts.host,
        });

        if (opts.output === "json") {
          console.log(formatOutput(messages, opts.output));
          return;
        }

        for (const msg of messages) {
          const time = msg.inserted_at ? new Date(msg.inserted_at).toLocaleString("ru-RU") : "?";
          const sender = msg.sender ? msg.sender.slice(0, 8) + "..." : "unknown";
          if (msg.decrypted) {
            console.log(`[${time}] ${sender}: ${msg.body}`);
          } else {
            console.log(`[${time}] ${sender}: [DECRYPT FAILED: ${msg.error}]`);
          }
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
