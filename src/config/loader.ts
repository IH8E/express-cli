import { configSchema, type Config } from "../types/index.js";
import { getStoredConfig, getAuthToken } from "./store.js";

export function loadConfig(cliOverrides: Partial<Config> = {}): Config {
  const stored = getStoredConfig();
  const env: Partial<Config> = {};

  if (process.env.EXPRESS_HOST) env.host = process.env.EXPRESS_HOST;
  if (process.env.EXPRESS_TOKEN) env.token = process.env.EXPRESS_TOKEN;
  if (process.env.EXPRESS_LOCALE) env.locale = process.env.EXPRESS_LOCALE;
  if (process.env.EXPRESS_OUTPUT) env.output = process.env.EXPRESS_OUTPUT as "table" | "json";

  const merged = {
    ...stored,
    ...env,
    ...cliOverrides,
  };

  if (!merged.token) {
    const storedToken = getAuthToken();
    if (storedToken) merged.token = storedToken;
  }

  return configSchema.parse(merged);
}

export function getBaseUrl(config: Config): string {
  return `${config.protocol}://${config.host}`;
}

function getDomain(ctsHost: string): string {
  const parts = ctsHost.split('.');
  return parts.length > 2 ? parts.slice(1).join('.') : ctsHost;
}

export function getEtsBaseUrl(config: Config): string {
  return `https://ets.${getDomain(config.host)}`;
}

export function getWebOrigin(config: Config): string {
  return `https://${getDomain(config.host)}`;
}
