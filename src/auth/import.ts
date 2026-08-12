import { setAuthToken, setStoredConfig, getAuthToken } from "../config/index.js";
import { getBaseUrl, loadConfig } from "../config/loader.js";
import type { Config } from "../types/index.js";

export async function importToken(token: string, cliOverrides: Partial<Config> = {}): Promise<void> {
  const config = loadConfig(cliOverrides);
  const baseUrl = getBaseUrl(config);

  const url = `${baseUrl}/api/v1/phonebook/profiles/self`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Token validation failed: ${res.status} ${res.statusText}`);
  }

  const body = await res.json() as { result?: { profile?: { name?: string; user_huid?: string } }; profile?: { name?: string; user_huid?: string } };
  setAuthToken(token);

  const profile = body.profile ?? body.result?.profile;
  if (profile?.name) {
    console.log(`Authenticated as: ${profile.name} (${profile.user_huid ?? "unknown huid"})`);
  } else {
    console.log("Token imported and validated successfully.");
  }
}

export function logout(): void {
  setAuthToken(null);
  console.log("Logged out. Token removed.");
}

export function status(): void {
  const token = getAuthToken();
  if (!token) {
    console.log("Not authenticated. Use `express auth import <token>` to login.");
    return;
  }
  console.log(`Authenticated. Token: ${token.slice(0, 20)}...`);
}
