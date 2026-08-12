import { ApiClient } from "./client.js";
import type { ServerMeta } from "../types/index.js";

export class SettingsApi {
  constructor(private client: ApiClient) {}

  async getServerMeta(): Promise<ServerMeta> {
    return this.client.get<ServerMeta>("/api/v1/settings/server/meta/");
  }

  async getSettings(since?: string): Promise<unknown> {
    const params = since ? `?since=${encodeURIComponent(since)}` : "";
    return this.client.get(`/api/v2/settings/${params}`);
  }

  async getRoles(deviceHash: string): Promise<unknown> {
    return this.client.get(`/api/v1/roles/rules?device_hash=${encodeURIComponent(deviceHash)}`);
  }
}
