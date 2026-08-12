import Conf from "conf";
import type { Config } from "../types/index.js";

interface StoredApigwKeys {
  signingKey: { keyId: string; privateKey: string; publicKey: string };
  rtsKeyId?: string;
  encryptionKeyId?: string;
  encryptionToken?: string;
}

interface StoreSchema {
  config: Partial<Config>;
  authToken: string | null;
  refreshToken: string | null;
  rtsAuthToken: string | null;
  apigwKeys: string | null;
  tokenExpiresAt: number | null;
  etsAuthToken: string | null;
}

const store = new Conf<StoreSchema>({
  projectName: "express-cli",
  defaults: {
    config: {},
    authToken: null,
    refreshToken: null,
    rtsAuthToken: null,
    apigwKeys: null,
    tokenExpiresAt: null,
    etsAuthToken: null,
  },
});

export function getStoredConfig(): Partial<Config> {
  return store.get("config") ?? {};
}

export function setStoredConfig(partial: Partial<Config>): void {
  const current = getStoredConfig();
  store.set("config", { ...current, ...partial });
}

export function getAuthToken(): string | null {
  return store.get("authToken") ?? null;
}

export function setAuthToken(token: string | null): void {
  if (token === null) {
    store.delete("authToken");
  } else {
    store.set("authToken", token);
  }
}

export function getRtsAuthToken(): string | null {
  return store.get("rtsAuthToken") ?? null;
}

export function setRtsAuthToken(token: string | null): void {
  if (token === null) {
    store.delete("rtsAuthToken");
  } else {
    store.set("rtsAuthToken", token);
  }
}

export function getRefreshToken(): string | null {
  return store.get("refreshToken") ?? null;
}

export function setRefreshToken(token: string | null): void {
  if (token === null) {
    store.delete("refreshToken");
  } else {
    store.set("refreshToken", token);
  }
}

export function getTokenExpiresAt(): number | null {
  return store.get("tokenExpiresAt") ?? null;
}

export function setTokenExpiresAt(expiresAt: number | null): void {
  if (expiresAt === null) {
    store.delete("tokenExpiresAt");
  } else {
    store.set("tokenExpiresAt", expiresAt);
  }
}

export function calcTokenExpiresAt(expiresIn: number): number {
  return Date.now() + Math.floor(expiresIn / 2) * 1000;
}

export function isTokenExpiringSoon(): boolean {
  const expiresAt = getTokenExpiresAt();
  if (!expiresAt) return true;
  return Date.now() >= expiresAt;
}

export function getEtsAuthToken(): string | null {
  return store.get("etsAuthToken") ?? null;
}

export function setEtsAuthToken(token: string | null): void {
  if (token === null) {
    store.delete("etsAuthToken");
  } else {
    store.set("etsAuthToken", token);
  }
}

export function getApigwKeysRaw(): string | null {
  return store.get("apigwKeys") ?? null;
}

export function setApigwKeysRaw(data: string | null): void {
  if (data === null) {
    store.delete("apigwKeys");
  } else {
    store.set("apigwKeys", data);
  }
}

export function clearAll(): void {
  store.clear();
}

export { store };
