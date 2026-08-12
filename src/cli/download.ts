import { Command } from "commander";
import { ApiClient } from "../api/client.js";
import { UploadsApi } from "../api/uploads.js";
import { writeFileSync } from "node:fs";

export function createDownloadCommand(): Command {
  const cmd = new Command("download");

  cmd
    .description("Download a file from eXpress uploads")
    .argument("<url>", "Full URL or path (e.g. /uploads/files/...)")
    .option("-o, --output <path>", "Output file path (default: auto from URL)")
    .option("--host <host>", "eXpress host")
    .action(async (url: string, opts: { output?: string; host?: string }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const uploadsApi = new UploadsApi(client);

        const { data, contentType } = await uploadsApi.download(url);
        const urlPath = new URL(url.startsWith("http") ? url : `https://x${url}`).pathname;
        const baseName = urlPath.split("/").pop() ?? "download";
        const outputPath = opts.output ?? baseName;

        writeFileSync(outputPath, Buffer.from(data));
        console.log(`Downloaded to ${outputPath} (${contentType ?? "unknown"}, ${data.byteLength} bytes)`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
