import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_MENTION_HUID, applyMentions, mentionTokensToHuids, type WireMention } from "./mentions.js";

const M1 = "11111111-1111-1111-1111-111111111111";
const M2 = "22222222-2222-2222-2222-222222222222";
const HUID = "2c765edc-cb80-5b86-939d-a19d97f2bdc9";

test("mentionTokensToHuids: a body token names the mention_id, the person is in payload.mentions", () => {
  const mentions: WireMention[] = [
    { mention_type: "user", mention_id: M1, mention_data: { user_huid: HUID, name: "Павленко Ян" } },
    { mention_type: "all", mention_id: M2, mention_data: { name: "all" } },
  ];
  assert.equal(
    mentionTokensToHuids(`@{mention:${M1}} привет, @{mention:${M2}}`, mentions),
    `@{mention:${HUID}} привет, @{mention:${ALL_MENTION_HUID}}`,
  );
});

test("mentionTokensToHuids: without payload.mentions the body is left as is", () => {
  assert.equal(mentionTokensToHuids(`@{mention:${M1}} x`), `@{mention:${M1}} x`);
});

test("applyMentions: placeholders place mentions, the rest lead; each gets its own mention_id", () => {
  const { body, mentions } = applyMentions("{1}, смотри у {0}", [
    { user_huid: HUID, name: "Павленко Ян" },
    { all: true },
  ]);
  assert.equal(body, `@{mention:${mentions[1].mention_id}}, смотри у @{mention:${mentions[0].mention_id}}`);
  assert.deepEqual(mentions[0].mention_data, { conn_type: "cts", user_huid: HUID, name: "Павленко Ян" });
  assert.equal(mentions[1].mention_type, "all");
  assert.notEqual(mentions[0].mention_id, HUID);

  const lead = applyMentions("здарова!", [{ user_huid: HUID, name: "Павленко Ян" }]);
  assert.equal(lead.body, `@{mention:${lead.mentions[0].mention_id}} здарова!`);
  // the round trip a reader does lands on the person
  assert.equal(mentionTokensToHuids(lead.body, lead.mentions), `@{mention:${HUID}} здарова!`);
});
