import { loadConfig, getBaseUrl, getEtsBaseUrl, getWebOrigin } from "../config/index.js";
import { getAuthToken, getRtsAuthToken, setAuthToken, isTokenExpiringSoon, getEtsAuthToken } from "../config/store.js";
import { signApigwRequest } from "../auth/apigw-signer.js";
import { loadApigwKeys } from "../auth/keys.js";
import { refreshToken } from "../auth/token-refresh.js";
import type { Config, ApiResponse } from "../types/index.js";

export class ApiClient {
  private config: Config;
  private baseUrl: string;
  private etsBaseUrl: string;
  private webOrigin: string;

  constructor(cliOverrides: Partial<Config> = {}) {
    this.config = loadConfig(cliOverrides);
    this.baseUrl = getBaseUrl(this.config);
    this.etsBaseUrl = getEtsBaseUrl(this.config);
    this.webOrigin = getWebOrigin(this.config);
  }

  private getToken(): string {
    const token = this.config.token ?? getAuthToken();
    if (!token) {
      throw new Error("Not authenticated. Use `express auth import <token>` to login.");
    }
    return token;
  }

  private isApigwPath(path: string): boolean {
    return path.includes("/apigw/");
  }

  private resolveUrl(path: string): string {
    if (path.startsWith("http")) return path;
    if (this.isApigwPath(path)) {
      return `${this.etsBaseUrl}${path}`;
    }
    return `${this.baseUrl}${path}`;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
    retry = true,
  ): Promise<T> {
    if (retry && isTokenExpiringSoon()) {
      await refreshToken(this.config);
    }

    let token = this.getToken();
    const url = this.resolveUrl(path);

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(this.isApigwPath(path)
        ? await this.buildApigwHeaders(options.method ?? "GET", path, token, options.body as string | undefined)
        : { Authorization: `Bearer ${token}` }),
      Origin: this.webOrigin,
      ...((options.headers as Record<string, string>) ?? {}),
    };

    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url, {
      ...options,
      headers,
    });

    if (res.status === 401 && retry) {
      const text = await res.text().catch(() => "");
      const isExpired = text.includes("token_expired");
      if (isExpired) {
        const refreshed = await refreshToken(this.config);
        if (refreshed) {
          const newToken = this.getToken();
          const newHeaders: Record<string, string> = {
            Accept: "application/json",
            ...(this.isApigwPath(path)
              ? await this.buildApigwHeaders(options.method ?? "GET", path, newToken, options.body as string | undefined)
              : { Authorization: `Bearer ${newToken}` }),
            Origin: this.webOrigin,
            ...((options.headers as Record<string, string>) ?? {}),
          };
          if (options.body && !newHeaders["Content-Type"]) {
            newHeaders["Content-Type"] = "application/json";
          }
          const retryRes = await fetch(url, { ...options, headers: newHeaders });
          return this.handleResponse<T>(retryRes);
        }
      }
      throw new Error("Token expired and refresh failed. Please re-authenticate with `express auth qr`.");
    }

    return this.handleResponse<T>(res);
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    if (res.status === 204) {
      return undefined as T;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`API error ${res.status}: ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`);
    }

    const text = await res.text();
    if (!text) {
      return undefined as T;
    }

    const data = JSON.parse(text);
    if (data && typeof data === "object" && "result" in data) {
      return (data as ApiResponse<T>).result as T;
    }
    return data as T;
  }

  private async buildApigwHeaders(
    method: string,
    path: string,
    ctsToken: string,
    body?: string,
  ): Promise<Record<string, string>> {
    const rtsToken = getRtsAuthToken() ?? undefined;
    const etsAuthToken = getEtsAuthToken() ?? undefined;
    const etsBaseUrl = this.etsBaseUrl;
    const signed = await signApigwRequest({
      method,
      url: path.startsWith("http") ? path : `${etsBaseUrl}${path}`,
      baseUrl: etsBaseUrl,
      body,
      ctsToken,
      rtsToken,
      etsAuthToken,
    });
    return {
      Authorization: signed.Authorization,
      "Express-Proxy-Authorization": signed["Express-Proxy-Authorization"],
      "Express-Request-Nonce": signed["Express-Request-Nonce"],
      ...(signed.Digest && { Digest: signed.Digest }),
      Signature: signed.Signature,
    };
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const jsonBody = body ? JSON.stringify(body) : undefined;
    return this.request<T>(path, {
      method: "POST",
      body: jsonBody,
    });
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    const jsonBody = body ? JSON.stringify(body) : undefined;
    return this.request<T>(path, {
      method: "PUT",
      body: jsonBody,
    });
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }

  async rawRequest(path: string, options: RequestInit = {}): Promise<Response> {
    const token = this.getToken();
    const url = this.resolveUrl(path);

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(this.isApigwPath(path)
        ? await this.buildApigwHeaders(options.method ?? "GET", path, token, options.body as string | undefined)
        : { Authorization: `Bearer ${token}` }),
      Origin: this.webOrigin,
      ...((options.headers as Record<string, string>) ?? {}),
    };

    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    return fetch(url, { ...options, headers });
  }

  async downloadFile(url: string): Promise<Response> {
    const token = this.getToken();
    const fullUrl = url.startsWith("http") ? url : `${this.baseUrl}${url}`;

    return fetch(fullUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Referer: `${this.webOrigin}/`,
        Accept: "*/*",
      },
    });
  }

  isApigwReady(): boolean {
    return loadApigwKeys() !== null;
  }
}
