import { ApiClient } from "./client.js";
import type { ExpressProfile } from "../types/index.js";

interface DirectoryEntry {
  position: number;
  entry_type: "user" | "bot" | "chat";
  entry_id: string;
  is_info_updated: boolean;
  deleted: boolean;
}

interface DirectoryResponse {
  entries: DirectoryEntry[];
}

interface CtsProfileEntry {
  cts_profiles?: ExpressProfile[];
}

interface CtsProfilesResponse {
  result?: CtsProfileEntry[];
}

interface ApigwContact {
  huid?: string;
  name?: string;
  email?: string;
  ad_login?: string;
  department?: string;
  company_position?: string;
  phone?: string;
  ip_phone?: string;
  [key: string]: unknown;
}

export class PhonebookApi {
  constructor(private client: ApiClient) {}

  async getContacts(): Promise<ApigwContact[]> {
    const data = await this.client.get<unknown>("/api/v1/apigw/api/v1/phonebook/contacts");
    if (!data) return [];
    if (Array.isArray(data)) return data as ApigwContact[];
    if (typeof data === "object" && data !== null) {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.contacts)) return obj.contacts as ApigwContact[];
      if (Array.isArray(obj.users)) return obj.users as ApigwContact[];
      if (Array.isArray(obj.result)) return obj.result as ApigwContact[];
    }
    return [];
  }

  async getContactChanges(since: string, udid = "latest_mobile"): Promise<unknown> {
    return this.client.get(
      `/api/v1/apigw/api/v4/phonebook/user_contacts_changes?since=${encodeURIComponent(since)}&udid=${udid}`,
    );
  }

  async getEncryptedEntries(since: string, udid = "latest_mobile"): Promise<unknown> {
    return this.client.get(
      `/api/v1/apigw/api/v4/phonebook/encrypted_entries?since=${encodeURIComponent(since)}&udid=${udid}`,
    );
  }

  async getCorporateDirectory(since?: string): Promise<unknown> {
    const params = since ? `?since=${encodeURIComponent(since)}` : "";
    const data = await this.client.get<unknown>(`/api/v1/corporate_directory/entries${params}`);
    if (!data) return { entries: [] };
    if (typeof data === "object" && data !== null && "entries" in data) return data;
    return data;
  }

  async searchUsers(query: string, limit = 20): Promise<ExpressProfile[]> {
    return this.searchUsersPhonebook(query, limit);
  }

  async searchUsersPhonebook(query: string, limit: number): Promise<ExpressProfile[]> {
    const data = await this.client.get<unknown>(
      `/api/v3/phonebook/search?query=${encodeURIComponent(query)}&active=true&disable_fuzzy_search=false`,
    );
    if (!data || typeof data !== "object") return [];
    const obj = data as Record<string, unknown>;
    const result = obj.result as Record<string, unknown> | undefined;
    const phonebook = (result?.phonebook ?? []) as Array<{ name?: string; contacts?: Array<{ user_huid?: string }> }>;
    const huids = [
      ...new Set(
        phonebook
          .flatMap((entry) => entry.contacts ?? [])
          .map((c) => c.user_huid)
          .filter(Boolean) as string[],
      ),
    ].slice(0, limit);
    if (huids.length === 0) return [];
    const raw = await this.client.rawRequest("/api/v1/phonebook/cts_profiles/query", {
      method: "POST",
      body: JSON.stringify({ huids }),
    });
    const profileData = (await raw.json()) as { result?: Array<{ cts_profiles?: ExpressProfile[] }> };
    const entries = profileData.result ?? [];
    const profiles: ExpressProfile[] = [];
    for (const entry of entries) {
      profiles.push(...(entry.cts_profiles ?? []));
    }
    return profiles.slice(0, limit);
  }

  private async searchUsersApigw(query: string, limit: number, contacts: ApigwContact[]): Promise<ExpressProfile[]> {
    const lowerQuery = query.toLowerCase();
    const matched = contacts.filter((c) => {
      const searchable = [c.name, c.email, c.ad_login, c.department, c.company_position, c.phone, c.ip_phone]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchable.includes(lowerQuery);
    }).slice(0, limit);

    if (matched.length > 0) {
      const huids = matched.map((c) => c.huid).filter(Boolean) as string[];
      if (huids.length > 0) {
        const raw = await this.client.rawRequest("/api/v1/phonebook/cts_profiles/query", {
          method: "POST",
          body: JSON.stringify({ huids }),
        });
        const data = (await raw.json()) as CtsProfilesResponse;
        const entries = data.result ?? (Array.isArray(data) ? data : []);
        const profiles: ExpressProfile[] = [];
        for (const entry of entries) {
          profiles.push(...(entry.cts_profiles ?? []));
        }
        return profiles.slice(0, limit);
      }
    }

    return [];
  }

  private async searchUsersDirectory(query: string, limit: number): Promise<ExpressProfile[]> {
    const dirData = await this.getCorporateDirectory() as DirectoryResponse;
    const entries = dirData?.entries ?? [];
    const userIds = entries
      .filter((e) => e.entry_type === "user" && !e.deleted)
      .map((e) => e.entry_id);

    if (userIds.length === 0) {
      return [];
    }

    const batchSize = 100;
    const allProfiles: ExpressProfile[] = [];
    const lowerQuery = query.toLowerCase();

    for (let i = 0; i < userIds.length && allProfiles.length < limit; i += batchSize) {
      const batch = userIds.slice(i, i + batchSize);
      const raw = await this.client.rawRequest("/api/v1/phonebook/cts_profiles/query", {
        method: "POST",
        body: JSON.stringify({ huids: batch }),
      });
      const data = (await raw.json()) as CtsProfilesResponse;
      const entries = data.result ?? (Array.isArray(data) ? data : []);

      for (const entry of entries) {
        for (const p of entry.cts_profiles ?? []) {
          const searchable = [
            p.name,
            p.email,
            p.ad_login,
            p.department,
            p.company_position,
            p.phone,
            p.ip_phone,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

          if (searchable.includes(lowerQuery)) {
            allProfiles.push(p);
            if (allProfiles.length >= limit) return allProfiles;
          }
        }
      }
    }

    return allProfiles;
  }
}
