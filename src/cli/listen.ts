import { Command } from "commander";
import chalk from "chalk";
import { ExpressSession, type SessionMessage, type SessionActivity } from "../session/session.js";
import type { ExpressChat } from "../types/index.js";

export function createListenCommand(): Command {
  const cmd = new Command("listen");

  cmd
    .description("Open a persistent session and stream incoming messages/notifications")
    .option("--host <host>", "eXpress host")
    .option("--activity", "Also print raw activity events (before decryption)", false)
    .action(async (opts: { host?: string; activity?: boolean }) => {
      let session: ExpressSession;
      try {
        session = new ExpressSession();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      const names = new Map<string, string>();
      const label = (chatId: string) => names.get(chatId) ?? chatId.slice(0, 8);
      const ts = (iso: string) => (iso ? new Date(iso).toLocaleTimeString("ru-RU") : new Date().toLocaleTimeString("ru-RU"));

      session.on("connected", () => console.log(chalk.green("● connected")));

      session.on("chats", (chats: ExpressChat[]) => {
        for (const c of chats) {
          const id = (c as { group_chat_id?: string; id?: string }).group_chat_id ?? (c as { id?: string }).id;
          const name = (c as { name?: string }).name;
          if (id) names.set(id, name || id.slice(0, 8));
        }
        console.log(chalk.dim(`  ${chats.length} chats loaded, subscribing to activity…`));
      });

      if (opts.activity) {
        session.on("activity", (a: SessionActivity) => {
          console.log(chalk.dim(`  · activity in ${label(a.chatId)} (${a.syncId.slice(0, 8)})`));
        });
      }

      session.on("message", (m: SessionMessage) => {
        const who = m.sender.slice(0, 8);
        if (m.decrypted) {
          console.log(`${chalk.dim(`[${ts(m.insertedAt)}]`)} ${chalk.cyan(label(m.chatId))} ${chalk.yellow(who)}: ${m.body}`);
        } else {
          console.log(`${chalk.dim(`[${ts(m.insertedAt)}]`)} ${chalk.cyan(label(m.chatId))} ${chalk.yellow(who)}: ${chalk.red(`[decrypt failed: ${m.error}]`)}`);
        }
      });

      session.on("reconnecting", ({ attempt, delayMs }: { attempt: number; delayMs: number }) => {
        console.log(chalk.yellow(`○ reconnecting (attempt ${attempt}) in ${Math.round(delayMs / 1000)}s…`));
      });
      session.on("disconnected", ({ code }: { code: number }) => console.log(chalk.yellow(`○ disconnected (code=${code})`)));
      session.on("error", (err: Error) => console.error(chalk.red(`! ${err.message}`)));

      const shutdown = () => { console.log(chalk.dim("\nclosing…")); session.close(); process.exit(0); };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      try {
        await session.connect();
        console.log(chalk.dim("Listening. Press Ctrl+C to stop."));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        session.close();
        process.exit(1);
      }
    });

  return cmd;
}
