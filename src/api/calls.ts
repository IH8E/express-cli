import { ApiClient } from "./client.js";

export class CallsApi {
  constructor(private client: ApiClient) {}

  async getMissedCallsCounter(): Promise<unknown> {
    return this.client.get("/api/v1/messaging/voex/missed_calls_counter");
  }

  async getCallFeatures(): Promise<unknown> {
    return this.client.get("/api/v1/call_settings/features");
  }
}
