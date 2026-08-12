import { ApiClient } from "./client.js";
import type { ExpressProfile, ExpressSelfProfileResponse, ExpressUserStatus } from "../types/index.js";
import { loadApigwKeys } from "../auth/keys.js";

export class UserApi {
  constructor(private client: ApiClient) {}

  async getSelfProfile(): Promise<ExpressProfile> {
    const data = await this.client.get<ExpressSelfProfileResponse>("/api/v1/phonebook/profiles/self");
    return data.profile;
  }

  async getProfilesByHuid(huids: string[]): Promise<ExpressProfile[]> {
    const data = await this.client.post<unknown>("/api/v1/phonebook/cts_profiles/query", { huids });
    if (!data) return [];
    const entries = Array.isArray(data) ? data : [];
    const profiles: ExpressProfile[] = [];
    for (const entry of entries) {
      const obj = entry as Record<string, unknown>;
      if (Array.isArray(obj.cts_profiles)) {
        profiles.push(...(obj.cts_profiles as ExpressProfile[]));
      }
    }
    return profiles;
  }

  async getUserStatuses(userHuids: string[], short = false): Promise<{ user_statuses: ExpressUserStatus[]; failed: string[] }> {
    const keys = loadApigwKeys();
    const keyId = (keys?.ctsKey ?? keys?.encryptionKey)?.keyId ?? "";
    return this.client.post("/api/v1/user_statuses/get", {
      user_huids: userHuids,
      short,
      key_id: keyId,
    });
  }

  async getUserStatusHistory(since?: string): Promise<ExpressUserStatus[]> {
    return this.client.post<ExpressUserStatus[]>("/api/v1/user_statuses/history", {
      since: since ?? null,
    });
  }
}
