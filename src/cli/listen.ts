import { Command } from "commander";
import chalk from "chalk";
import { ExpressSession, type SessionMessage, type SessionActivity } from "../session/session.js";
import { ApiClient } from "../api/client.js";
import { UserApi } from "../api/user.js";
import { UploadsApi } from "../api/uploads.js";
import { ALL_MENTION_HUID, MENTION_RE } from "../api/mentions.js";
import terminalImage from "terminal-image";
import type { ExpressChat, ExpressProfile } from "../types/index.js";

export function createListenCommand(): Command {
  const cmd = new Command("listen");

  cmd
    .description("Open a persistent session and stream incoming messages/notifications")
    .option("--host <host>", "eXpress host")
    .option("--activity", "Also print raw activity events (before decryption)", false)
    .option("--avatar", "Show a preview image the first time each sender appears", false)
    .action(async (opts: { host?: string; activity?: boolean; avatar?: boolean }) => {
      let session: ExpressSession;
      try {
        session = new ExpressSession();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }

      const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
      const userApi = new UserApi(client);
      const uploadsApi = new UploadsApi(client);

      const names = new Map<string, string>();
      const label = (chatId: string) => names.get(chatId) ?? chatId.slice(0, 8);
      const ts = (iso: string) => (iso ? new Date(iso).toLocaleTimeString("ru-RU") : new Date().toLocaleTimeString("ru-RU"));

      const profileCache = new Map<string, Promise<ExpressProfile | null>>();
      const getProfile = (huid: string): Promise<ExpressProfile | null> => {
        let p = profileCache.get(huid);
        if (!p) {
          p = userApi.getProfilesByHuid([huid]).then((profiles) => profiles[0] ?? null).catch(() => {
            profileCache.delete(huid); // don't wedge this sender on a transient lookup failure
            return null;
          });
          profileCache.set(huid, p);
        }
        return p;
      };
      const senderLabel = async (huid: string): Promise<string> => {
        const profile = await getProfile(huid);
        return profile?.name ?? huid.slice(0, 8);
      };

      const resolveMentions = async (body: string): Promise<string> => {
        const huids = [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[1]))];
        if (huids.length === 0) return body;
        const toResolve = huids.filter((h) => h !== ALL_MENTION_HUID);
        const names = await Promise.all(toResolve.map((h) => senderLabel(h)));
        const nameMap = new Map<string, string>(toResolve.map((h, i) => [h, names[i]]));
        nameMap.set(ALL_MENTION_HUID, "all");
        return body.replace(MENTION_RE, (_match, huid: string) => `@${nameMap.get(huid) ?? huid.slice(0, 8)}`);
      };

      const avatarShown = new Set<string>();
      const showAvatarOnce = async (huid: string): Promise<void> => {
        if (avatarShown.has(huid)) return;
        avatarShown.add(huid);
        const profile = await getProfile(huid);
        // Full-res source (not the small `_preview` variant) + native terminal graphics
        // (iTerm2/Kitty/WezTerm) when available — the TUI forces block-art because it
        // can't mix native image escapes with Ink's layout, but a plain CLI stream has
        // no such constraint.
        const avatarUrl = profile?.custom_avatar ?? profile?.avatar ?? profile?.custom_avatar_preview ?? profile?.avatar_preview;
        if (!avatarUrl) return;
        try {
          const { data } = await uploadsApi.download(avatarUrl);
          const art = await terminalImage.buffer(Buffer.from(data), {
            width: 24,
            preserveAspectRatio: true,
            preferNativeRender: true,
          });
          console.log(art.replace(/\n$/, ""));
        } catch {
          // avatar preview is best-effort
        }
      };

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

      // Chain onto the previous message's handling so profile lookups racing at
      // different speeds can't reorder the printed stream relative to arrival.
      let messageQueue = Promise.resolve();
      session.on("message", (m: SessionMessage) => {
        messageQueue = messageQueue.then(() => handleMessage(m)).catch((err: Error) => console.error(chalk.red(`! ${err.message}`)));
      });

      async function handleMessage(m: SessionMessage): Promise<void> {
        if (opts.avatar) await showAvatarOnce(m.sender);
        const who = await senderLabel(m.sender);
        if (m.decrypted) {
          const body = await resolveMentions(m.body);
          console.log(`${chalk.dim(`[${ts(m.insertedAt)}]`)} ${chalk.cyan(label(m.chatId))} ${chalk.yellow(who)}: ${body}`);
        } else {
          console.log(`${chalk.dim(`[${ts(m.insertedAt)}]`)} ${chalk.cyan(label(m.chatId))} ${chalk.yellow(who)}: ${chalk.red(`[decrypt failed: ${m.error}]`)}`);
        }
      }

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
