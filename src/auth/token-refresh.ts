import { getAuthToken, getRefreshToken, setAuthToken, setRefreshToken, setTokenExpiresAt, calcTokenExpiresAt } from "../config/store.js";
import { getBaseUrl, getWebOrigin } from "../config/loader.js";
import { loadConfig } from "../config/index.js";
import type { Config } from "../types/index.js";

interface RefreshResponse {
  status?: string;
  result?: {
    cts_access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  cts_access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

let refreshPromise: Promise<boolean> | null = null;

export async function refreshToken(cliOverrides: Partial<Config> = {}): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = doRefresh(cliOverrides);
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

async function doRefresh(cliOverrides: Partial<Config> = {}): Promise<boolean> {
  const currentToken = getAuthToken();
  const rt = getRefreshToken();

  if (!currentToken || !rt) return false;

  const config = loadConfig(cliOverrides);
  const baseUrl = getBaseUrl(config);
  const webOrigin = getWebOrigin(config);

  try {
      const res = await fetch(`${baseUrl}/api/v1/ad_integration/token/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        Origin: webOrigin,
        Pragma: "no-cache",
        Referer: `${webOrigin}/`,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        Authorization: `Bearer ${currentToken}`,
      },
      body: JSON.stringify({ refresh_token: rt }),
    });

    if (!res.ok) {
      return false;
    }

    const text = await res.text();
    const data = JSON.parse(text) as RefreshResponse;
    const result = data.result ?? data;

    const newAccessToken = result.cts_access_token;
    const newRefreshToken = result.refresh_token;
    const expiresIn = result.expires_in;

    if (!newAccessToken) return false;

    setAuthToken(newAccessToken);
    if (newRefreshToken) setRefreshToken(newRefreshToken);
    if (typeof expiresIn === "number") {
      setTokenExpiresAt(calcTokenExpiresAt(expiresIn));
    }

    return true;
  } catch {
    return false;
  }
}
