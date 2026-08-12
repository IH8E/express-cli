import { Command } from "commander";
import { ApiClient } from "../api/client.js";
import { loadConfig } from "../config/index.js";
import { formatOutput, type OutputFormat } from "./output.js";

export function createApiCommand(): Command {
  const cmd = new Command("api");

  cmd
    .description("Make arbitrary API request")
    .argument("<path>", "API path (e.g. /api/v1/phonebook/profiles/self)")
    .option("-X, --method <method>", "HTTP method", "GET")
    .option("-d, --data <data>", "Request body (JSON)")
    .option("--host <host>", "eXpress host")
    .option("-o, --output <format>", "Output format", "json")
    .action(async (path: string, opts: { method: string; data?: string; host?: string; output: OutputFormat }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);

        let body: unknown;
        if (opts.data) {
          try {
            body = JSON.parse(opts.data);
          } catch {
            throw new Error("Invalid JSON in --data");
          }
        }

        const method = opts.method.toUpperCase();
        const res = await client.rawRequest(path, {
          method,
          body: body ? JSON.stringify(body) : undefined,
        });

        const text = await res.text();
        console.log(`Response: status=${res.status}, content-type=${res.headers.get("content-type")}, body=${text.length} chars`);
        if (!text) {
          return;
        }
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          console.log(`Response: status=${res.status}, non-JSON body (${text.length} chars): ${text.slice(0, 500)}`);
          return;
        }

        if (!res.ok) {
          console.error(`API error ${res.status}:`, JSON.stringify(data, null, 2));
          process.exit(1);
        }

        console.log(formatOutput(data, opts.output));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
