import { Command } from "commander";
import { ApiClient } from "../api/client.js";
import { UserApi } from "../api/user.js";
import { UploadsApi } from "../api/uploads.js";
import { formatProfileTable, formatOutput, type OutputFormat } from "./output.js";
import { writeFileSync } from "node:fs";

export function createAvatarCommand(): Command {
  const cmd = new Command("avatar");

  cmd.description("Download user avatars");

  cmd
    .command("get <huid>")
    .description("Download avatar for a user by HUID")
    .option("-o, --output <path>", "Output file path (default: <huid>.png)")
    .option("--host <host>", "eXpress host")
    .action(async (huid: string, opts: { output?: string; host?: string }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const userApi = new UserApi(client);
        const uploadsApi = new UploadsApi(client);

        const profiles = await userApi.getProfilesByHuid([huid]);
        const profile = profiles?.[0];
        const avatarUrl = profile?.custom_avatar ?? profile?.avatar;

        if (!avatarUrl) {
          console.log("No avatar found for this user.");
          return;
        }

        const { data, contentType } = await uploadsApi.download(avatarUrl);
        const ext = contentType?.includes("jpeg") ? ".jpg" : contentType?.includes("png") ? ".png" : ".png";
        const outputPath = opts.output ?? `${huid}${ext}`;

        writeFileSync(outputPath, Buffer.from(data));
        console.log(`Avatar saved to ${outputPath}`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("self")
    .description("Download your own avatar")
    .option("-o, --output <path>", "Output file path (default: self_avatar.png)")
    .option("--host <host>", "eXpress host")
    .action(async (opts: { output?: string; host?: string }) => {
      try {
        const client = new ApiClient(opts.host ? { host: opts.host } : undefined);
        const userApi = new UserApi(client);
        const uploadsApi = new UploadsApi(client);

        const profile = await userApi.getSelfProfile();
        const avatarUrl = profile.custom_avatar ?? profile.avatar;

        if (!avatarUrl) {
          console.log("No avatar found for your profile.");
          return;
        }

        const { data, contentType } = await uploadsApi.download(avatarUrl);
        const ext = contentType?.includes("jpeg") ? ".jpg" : contentType?.includes("png") ? ".png" : ".png";
        const outputPath = opts.output ?? `self_avatar${ext}`;

        writeFileSync(outputPath, Buffer.from(data));
        console.log(`Avatar saved to ${outputPath}`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
