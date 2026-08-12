import { z } from "zod";

export const configSchema = z.object({
  host: z.string().min(1, "host is required — set EXPRESS_HOST or configure via `express config set host <host>`"),
  protocol: z.enum(["https", "http"]).default("https"),
  token: z.string().optional(),
  locale: z.string().default("ru"),
  platform: z.string().default("web"),
  platform_package_id: z.string().default("ru.alfabank"),
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
