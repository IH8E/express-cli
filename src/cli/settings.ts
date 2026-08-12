import { Command } from "commander";
import { SettingsApi } from "../api/settings.js";
import { ApiClient } from "../api/client.js";
import { formatOutput, type OutputFormat } from "./output.js";

export function createSettingsCommand(): Command {
  const cmd = new Command("settings");

  cmd.description("Server settings and meta");

  cmd
    .command("meta")
    .description("Get server metadata")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (opts: { host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const api = new SettingsApi(client);
        const meta = await api.getServerMeta();
        console.log(formatOutput(meta, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("get")
    .description("Get settings")
    .option("--since <iso-date>", "Since date (ISO 8601)")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (opts: { since?: string; host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const api = new SettingsApi(client);
        const settings = await api.getSettings(opts.since);
        console.log(formatOutput(settings, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
