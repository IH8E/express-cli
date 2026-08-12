import { Command } from "commander";
import chalk from "chalk";
import { UserApi } from "../api/user.js";
import { ChatsApi } from "../api/chats.js";
import { PhonebookApi } from "../api/phonebook.js";
import { ApiClient } from "../api/client.js";
import { formatProfileTable, formatOutput, type OutputFormat } from "./output.js";

export function createContactsCommand(): Command {
  const cmd = new Command("contacts");

  cmd.description("Contacts and phonebook");

  cmd
    .command("self")
    .description("Get own profile")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "table")
    .action(async (opts: { host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const api = new UserApi(client);
        const profile = await api.getSelfProfile();

        if (opts.output === "json") {
          console.log(formatOutput(profile, "json"));
        } else {
          console.log(formatProfileTable([profile]));
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("query <huids...>")
    .description("Query profiles by HUIDs")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "table")
    .action(async (huids: string[], opts: { host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const api = new UserApi(client);
        const profiles = await api.getProfilesByHuid(huids);

        if (opts.output === "json") {
          console.log(formatOutput(profiles, "json"));
        } else {
          console.log(formatProfileTable(profiles));
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("search <query>")
    .description("Search users by name/email/department (apigw or directory)")
    .option("-l, --limit <n>", "Max results", "20")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "table")
    .action(async (query: string, opts: { limit: string; host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const limit = parseInt(opts.limit, 10);
        const phonebook = new PhonebookApi(client);
        let profiles = await phonebook.searchUsers(query, limit);

        // Fallback: search across all chat members (works even when apigw phonebook is empty)
        if (profiles.length === 0) {
          try {
            const userApi = new UserApi(client);
            const chatsApi = new ChatsApi(client);
            const [allChats, self] = await Promise.all([chatsApi.listChats(), userApi.getSelfProfile()]);
            const myHuid = self.user_huid;
            const allMemberHuids = [...new Set(
              allChats.flatMap((c) => c.member_huids ?? []).filter((h) => h !== myHuid),
            )];
            if (allMemberHuids.length > 0) {
              const allProfiles = await userApi.getProfilesByHuid(allMemberHuids);
              const lowerQuery = query.toLowerCase();
              profiles = allProfiles
                .filter((p) =>
                  [p.name, p.email, p.ad_login, p.department, p.company_position]
                    .filter(Boolean).join(" ").toLowerCase().includes(lowerQuery),
                )
                .slice(0, limit);
            }
          } catch (err) {
            if (process.env.EXPRESS_DEBUG) {
              console.error(`  [DEBUG] Chat member search failed: ${(err as Error).message}`);
            }
          }
        }

        if (profiles.length === 0) {
          console.log(chalk.yellow("No users found."));
          return;
        }

        if (opts.output === "json") {
          console.log(formatOutput(profiles, "json"));
        } else {
          console.log(formatProfileTable(profiles));
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("list")
    .description("List all contacts (requires 'express auth login')")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (opts: { host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);

        if (!client.isApigwReady()) {
          console.error(chalk.yellow("Error: This command requires apigw auth. Run 'express auth login' first."));
          process.exit(1);
        }

        const api = new PhonebookApi(client);
        const contacts = await api.getContacts();
        if (!contacts || contacts.length === 0) {
          console.log(chalk.yellow("No contacts found. The apigw phonebook endpoint may not have synced contacts yet."));
          console.log(chalk.yellow("Use 'express contacts search <query>' to search via corporate directory."));
          return;
        }
        console.log(formatOutput(contacts, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("directory")
    .description("Corporate directory entries")
    .option("--since <iso-date>", "Since date (ISO 8601)")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (opts: { since?: string; host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const api = new PhonebookApi(client);
        const entries = await api.getCorporateDirectory(opts.since);
        console.log(formatOutput(entries, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
