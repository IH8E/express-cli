import { Command } from "commander";
import { createAuthCommand } from "./auth.js";
import { createApiCommand } from "./api.js";
import { createConfigCommand } from "./config-cmd.js";
import { createStatusCommand } from "./status.js";
import { createContactsCommand } from "./contacts.js";
import { createSettingsCommand } from "./settings.js";
import { createChatsCommand } from "./chats.js";
import { createSendCommand } from "./send.js";
import { createAvatarCommand } from "./avatar.js";
import { createDownloadCommand } from "./download.js";
import { createMessagesCommand } from "./messages.js";
import { createListenCommand } from "./listen.js";
import { createTuiCommand } from "./tui.js";
import { createMcpCommand } from "./mcp.js";

export function createRootCommand(): Command {
  const program = new Command();

  program
    .name("express-cli")
    .description("CLI client for eXpress Chat")
    .version("0.1.3");

  program.addCommand(createAuthCommand());
  program.addCommand(createApiCommand());
  program.addCommand(createConfigCommand());
  program.addCommand(createStatusCommand());
  program.addCommand(createContactsCommand());
  program.addCommand(createSettingsCommand());
  program.addCommand(createChatsCommand());
  program.addCommand(createSendCommand());
  program.addCommand(createAvatarCommand());
  program.addCommand(createDownloadCommand());
  program.addCommand(createMessagesCommand());
  program.addCommand(createListenCommand());
  program.addCommand(createTuiCommand());
  program.addCommand(createMcpCommand());

  return program;
}
