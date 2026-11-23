import { z } from "zod";

export const configSchema = z.object({
  host: z.string().min(1, "host is required — set EXPRESS_HOST or configure via `express config set host <host>`"),
  protocol: z.enum(["https", "http"]).default("https"),
  token: z.string().optional(),
  locale: z.string().default("ru"),
  platform: z.string().default("web"),
  /** Device package id for `auth login`. Unset = field is omitted (the server accepts that). */
  platform_package_id: z.string().optional(),
  /** ETS base URL or host. Default: `ets.<domain>` derived from `host`. */
  ets_host: z.string().optional(),
  /** Origin/Referer sent to the web API. Default: `https://<domain>` derived from `host`. */
  web_origin: z.string().optional(),
  /** Device package id used only by QR login (device-login keeps `platform_package_id`). */
  qr_platform_package_id: z.string().default("com.pyligrim.alphach"),
  /** Whether QR login registers the device as an ETS client (self-hosted) or a public RTS client. */
  qr_register_ets: z.boolean().default(true),
  app_version: z.string().default("3.66.47"),
  output: z.enum(["table", "json"]).default("table"),
});

export type Config = z.infer<typeof configSchema>;

export const envSchema = z.object({
  EXPRESS_HOST: z.string().optional(),
  EXPRESS_TOKEN: z.string().optional(),
  EXPRESS_LOCALE: z.string().optional(),
  EXPRESS_OUTPUT: z.enum(["table", "json"]).optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;
