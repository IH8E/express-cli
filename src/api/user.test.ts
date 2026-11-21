import { test } from "node:test";
import assert from "node:assert/strict";
import { UserApi } from "./user.js";

/** Stub ApiClient: records calls, answers per path. */
function stubClient(answers: Record<string, () => Promise<unknown>>) {
  const calls: string[] = [];
  const client = {
    post: async (path: string) => {
      calls.push(path);
      const answer = answers[path];
      if (!answer) throw new Error(`API error 404: Not Found`);
      return answer();
    },
  };
  return { client: client as never, calls };
}

const HUID = "cccccccc-1111-5111-8111-111111111111";

test("getProfilesByHuid uses v1 cts_profiles on corporate CTS", async () => {
  const { client, calls } = stubClient({
    "/api/v1/phonebook/cts_profiles/query": async () => [
      { server_name: "cts1", cts_profiles: [{ name: "Иванов Иван Иванович", user_huid: HUID, active: true }] },
    ],
  });
  const profiles = await new UserApi(client).getProfilesByHuid([HUID]);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, "Иванов Иван Иванович");
  assert.deepEqual(calls, ["/api/v1/phonebook/cts_profiles/query"], "v3 must not be called when v1 answers");
});

test("getProfilesByHuid falls back to v3 when v1 is absent (public RTS deploy)", async () => {
  const { client, calls } = stubClient({
    "/api/v3/phonebook/profiles/query": async () => ({
      profiles: [
        {
          user_huid: HUID,
          user_kind: "cts_user",
          cts_public_profile: { active: true, name: "Иванов Иван Иванович", user_huid: HUID },
          rts_profile: null,
        },
      ],
    }),
  });
  const profiles = await new UserApi(client).getProfilesByHuid([HUID]);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, "Иванов Иван Иванович");
  assert.equal(profiles[0].user_huid, HUID);
  assert.ok(calls.includes("/api/v3/phonebook/profiles/query"));
});

test("v3 fallback reads rts_profile for self-registered RTS users", async () => {
  const { client } = stubClient({
    "/api/v3/phonebook/profiles/query": async () => ({
      profiles: [
        {
          user_huid: HUID,
          user_kind: "user",
          cts_public_profile: null,
          rts_profile: { name: "Алексей Комиссаров", avatar: "https://x/a.jpg", avatar_preview: "https://x/p.jpg" },
        },
      ],
    }),
  });
  const [profile] = await new UserApi(client).getProfilesByHuid([HUID]);
  assert.equal(profile.name, "Алексей Комиссаров");
  assert.equal(profile.avatar, "https://x/a.jpg");
  assert.equal(profile.avatar_preview, "https://x/p.jpg");
});

test("v3 fallback skips entries with neither profile", async () => {
  const { client } = stubClient({
    "/api/v3/phonebook/profiles/query": async () => ({
      profiles: [{ user_huid: HUID, cts_public_profile: null, rts_profile: null }],
    }),
  });
  assert.deepEqual(await new UserApi(client).getProfilesByHuid([HUID]), []);
});

test("unknown huids resolve to an empty list, not a throw", async () => {
  const { client } = stubClient({
    "/api/v3/phonebook/profiles/query": async () => ({ profiles: [] }),
  });
  assert.deepEqual(await new UserApi(client).getProfilesByHuid(["garbage"]), []);
});

test("chats_find falls back to a huid when the phonebook route is absent (public deploy)", async () => {
  const { PhonebookApi } = await import("./phonebook.js");
  const client = {
    get: async () => { throw new Error(`API error 404:  — {"errors":{"detail":"Page not found"}}`); },
  } as never;
  // A 404 means "this deployment has no phonebook", not a failure worth surfacing.
  assert.deepEqual(await new PhonebookApi(client).searchUsers("Салимурзаев", 5), []);
});

test("searchUsers does not swallow unrelated transport errors", async () => {
  const { PhonebookApi } = await import("./phonebook.js");
  const client = {
    get: async () => { throw new Error("fetch failed: ECONNREFUSED"); },
  } as never;
  await assert.rejects(() => new PhonebookApi(client).searchUsers("x", 5), /ECONNREFUSED/);
});
