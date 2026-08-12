import { Command } from "commander";
import { runTui } from "../tui/index.js";

export function createTuiCommand(): Command {
  const cmd = new Command("tui");

  cmd
    .description("Interactive terminal UI: chat list + live message thread")
    .option("--host <host>", "eXpress host")
    .action(async () => {
      try {
        await runTui();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
