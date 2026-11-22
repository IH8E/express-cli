import { Command } from "commander";
import { UserApi } from "../api/user.js";
import { ApiClient } from "../api/client.js";
import { getPresence } from "../api/presence.js";
import { formatStatusTable, formatOutput, type OutputFormat } from "./output.js";

export function createStatusCommand(): Command {
  const cmd = new Command("status");

  cmd.description("Get user statuses");

  cmd
    .command("self")
    .description("Get own status")
    .option("-s, --short", "Short format", false)
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "table")
    .action(async (opts: { short: boolean; host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const api = new UserApi(client);
        const profile = await api.getSelfProfile();
        const result = await api.getUserStatuses([profile.user_huid], opts.short);
        if (opts.output === "json") {
          console.log(formatOutput(result, "json"));
        } else {
          console.log(formatStatusTable(result.user_statuses));
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("get <huids...>")
    .description("Get statuses for users by HUID")
    .option("-s, --short", "Short format", false)
    .option("--live", "Read presence over WebSocket (the REST route often answers empty)", false)
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "table")
    .action(async (huids: string[], opts: { short: boolean; live: boolean; host?: string; output: OutputFormat }) => {
      try {
        if (opts.live) {
          const live = await getPresence({ userHuids: huids });
          const asStatuses = live.map((s) => ({
            huid: s.user_huid,
            status: s.status as never,
            last_seen: s.status_changed,
            status_text: s.in_call ? "in call" : undefined,
          }));
          console.log(opts.output === "json"
            ? formatOutput({ user_statuses: asStatuses, failed: huids.filter((h) => !live.some((s) => s.user_huid === h)) }, "json")
            : formatStatusTable(asStatuses));
          return;
        }
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const api = new UserApi(client);
        const result = await api.getUserStatuses(huids, opts.short);

        if (opts.output === "json") {
          console.log(formatOutput(result, "json"));
        } else {
          console.log(formatStatusTable(result.user_statuses));
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("history")
    .description("Get status history")
    .option("--since <iso-date>", "Since date (ISO 8601)")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (opts: { since?: string; host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const api = new UserApi(client);
        const history = await api.getUserStatusHistory(opts.since);
        console.log(formatOutput(history, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
