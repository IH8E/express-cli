import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTextPayload, pickRecipientKeys, type KdcKey, type ReplyQuote } from "./messaging-ws.js";

const key = (id: string, kind: string, algo = "xsalsa20") => ({ id, kind, algo, body: "", user_huid: "u" }) as KdcKey;

test("pickRecipientKeys: a group's rest key is a recipient too (WISHLIST #17)", () => {
  const picked = pickRecipientKeys(["a", "b"], [key("a", "cts"), key("b", "rest")]);
  assert.deepEqual(picked.map((k) => k.id), ["a", "b"]);
});

test("pickRecipientKeys: a chat key KDC did not return fails loudly instead of invalid_keys", () => {
  assert.throws(() => pickRecipientKeys(["a", "b"], [key("a", "cts")]), /1 of 2 chat keys \(not returned by KDC\)/);
});

test("pickRecipientKeys: a key with another algo is not sealed with nacl.box", () => {
  assert.throws(() => pickRecipientKeys(["a"], [key("a", "cts", "ed25519")]), /\(cts\)/);
});

test("buildTextPayload: a reply carries the quote in payload.reply, a plain message carries none", () => {
  const quote: ReplyQuote = {
    sync_id: "s1", group_chat_id: "c1", reply_type: "group_chat", source_name: "Team",
    sender_conn_type: "cts", payload: { type: "text", body: "вопрос", from: "h2" },
  };
  const reply = JSON.parse(buildTextPayload("ответ", "h1", "c1", quote));
  assert.deepEqual(reply.reply, quote);
  assert.equal(reply.body, "ответ");
  assert.equal("reply" in JSON.parse(buildTextPayload("просто", "h1", "c1")), false);
});

test("pickRecipientKeys: no chat keys at all is an error, not a send with an empty keys[]", () => {
  assert.throws(() => pickRecipientKeys([], []), /no keys/);
});
