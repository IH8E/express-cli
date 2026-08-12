import { ApiClient } from "./client.js";

export class UploadsApi {
  constructor(private client: ApiClient) {}

  async downloadAvatar(huid: string): Promise<{ data: ArrayBuffer; contentType: string | null } | null> {
    const profile = await this.client.get<{ custom_avatar?: string; avatar?: string }>(
      `/api/v1/phonebook/cts_profiles/query`,
    );
    return null;
  }

  async download(url: string): Promise<{ data: ArrayBuffer; contentType: string | null }> {
    const res = await this.client.downloadFile(url);
    if (!res.ok) {
      throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    }
    const data = await res.arrayBuffer();
    const contentType = res.headers.get("content-type");
    return { data, contentType };
  }
}
