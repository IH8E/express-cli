import { Command } from "commander";
import { runMcpServer } from "../mcp/server.js";

export function createMcpCommand(): Command {
  const cmd = new Command("mcp");

  cmd
    .description("Run as an MCP server (stdio): exposes chats/messages/contacts tools to MCP hosts")
    .action(async () => {
      try {
        await runMcpServer();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
