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
    // Corporate CTS exposes v1 (cts_profiles[]); public RTS-only deployments expose v3
    // (profiles[] with cts_public_profile / rts_profile). v1 404s on the latter, so a
    // failure or an empty result both fall through to v3.
    try {
      const data = await this.client.post<unknown>("/api/v1/phonebook/cts_profiles/query", { huids });
      if (data) {
        const profiles: ExpressProfile[] = [];
        for (const entry of Array.isArray(data) ? data : []) {
          const obj = entry as Record<string, unknown>;
          if (Array.isArray(obj.cts_profiles)) {
            profiles.push(...(obj.cts_profiles as ExpressProfile[]));
          }
        }
        if (profiles.length) return profiles;
      }
    } catch {
      // v1 absent on this deployment — fall back to v3
    }
    return this.getProfilesByHuidV3(huids);
  }

  /** v3 profile shape: `{profiles: [{user_huid, cts_public_profile, rts_profile}]}`
   * (ApiClient already unwraps the `result` envelope). */
  private async getProfilesByHuidV3(huids: string[]): Promise<ExpressProfile[]> {
    let data: unknown;
    try {
      data = await this.client.post<unknown>("/api/v3/phonebook/profiles/query", { huids });
    } catch {
      return [];
    }
    const entries = (data as { profiles?: unknown[] } | null)?.profiles;
    if (!Array.isArray(entries)) return [];
    const profiles: ExpressProfile[] = [];
    for (const entry of entries) {
      const obj = entry as Record<string, unknown>;
      const cts = obj.cts_public_profile as Record<string, unknown> | null | undefined;
      const rts = obj.rts_profile as Record<string, unknown> | null | undefined;
      const source = cts ?? rts;
      if (!source) continue;
      profiles.push({
        active: source.active !== false,
        name: typeof source.name === "string" ? source.name : "",
        description: null,
        kind: typeof obj.user_kind === "string" ? obj.user_kind : "cts_user",
        manager: null,
        email: null,
        user_huid: typeof obj.user_huid === "string" ? obj.user_huid : "",
        ad_login: null,
        avatar: typeof source.avatar === "string" ? source.avatar : null,
        company: null,
        company_position: null,
        department: null,
        office: null,
        phone: null,
        avatar_preview: typeof source.avatar_preview === "string" ? source.avatar_preview : null,
      } as ExpressProfile);
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
