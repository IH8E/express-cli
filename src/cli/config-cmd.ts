import { Command } from "commander";
import { getStoredConfig, setStoredConfig, clearAll } from "../config/index.js";
import { formatOutput, type OutputFormat } from "./output.js";

export function createConfigCommand(): Command {
  const cmd = new Command("config");

  cmd.description("Configuration management");

  cmd
    .command("get [key]")
    .description("Get config value(s)")
    .option("-o, --output <format>", "Output format", "json")
    .action((key?: string, opts?: { output: OutputFormat }) => {
      const config = getStoredConfig();
      const data = key ? { [key]: (config as Record<string, unknown>)[key] } : config;
      console.log(formatOutput(data, opts?.output ?? "json"));
    });

  cmd
    .command("set <key> <value>")
    .description("Set config value")
    .action((key: string, value: string) => {
      const current = getStoredConfig();
      let parsed: unknown = value;
      try {
        parsed = JSON.parse(value);
      } catch {}
      setStoredConfig({ ...current, [key]: parsed });
      console.log(`Set ${key} = ${JSON.stringify(parsed)}`);
    });

  cmd
    .command("list")
    .description("List all config values")
    .option("-o, --output <format>", "Output format", "json")
    .action((opts: { output: OutputFormat }) => {
      console.log(formatOutput(getStoredConfig(), opts.output));
    });

  cmd
    .command("reset")
    .description("Reset all configuration and tokens")
    .action(() => {
      clearAll();
      console.log("All configuration and tokens cleared.");
    });

  return cmd;
}
