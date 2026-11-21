import { test } from "node:test";
import assert from "node:assert/strict";
import sodium from "libsodium-wrappers-sumo";
import nacl from "tweetnacl";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the `conf` store before anything imports it.
process.env.EXPRESS_CLI_CONFIG_DIR = mkdtempSync(join(tmpdir(), "express-cli-rts-test-"));
process.env.EXPRESS_HOST = "test.invalid";

const { decryptWithKey, getSenderPublicKey, unboxMessageKey } = await import("./decrypt.js");
const { buildTextPayload } = await import("./messaging-ws.js");
import type { ApigwKeys } from "../auth/keys.js";
import type { HistoryMessage } from "./decrypt.js";

const CHAT = "dddddddd-1111-5111-8111-111111111111";
const SYNC = "eeeeeeee-1111-5111-8111-111111111111";
const HUID = "ffffffff-1111-5111-8111-111111111111";
const RTS_ID = "aaaaaaa1-1111-5111-8111-111111111111";

/** Seal `body` for `recipientPubKey` the way the wire does: a symmetric key boxed per
 *  recipient, the body encrypted with XChaCha20 (AAD = chat:sync). */
async function sealMessage(plaintext: string, recipientPubKey: Uint8Array) {
  await sodium.ready;
  const symKey = sodium.randombytes_buf(32);
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const boxed = sodium.crypto_box_easy(symKey, nonce, recipientPubKey, senderKeys.secretKey);

  const bodyNonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const aad = new Uint8Array(Buffer.from(`${CHAT}:${SYNC}`));
  const cipher = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    new TextEncoder().encode(plaintext), aad, null, bodyNonce, symKey,
  );

  return {
    boxed: Buffer.concat([Buffer.from(nonce), Buffer.from(boxed)]).toString("base64"),
    body: Buffer.concat([Buffer.from(bodyNonce), Buffer.from(cipher)]).toString("base64"),
  };
}

const senderKeys = nacl.box.keyPair();
const recipientKeys = nacl.box.keyPair();

/** An RTS-only account: the message key is the rts (encryptionKey) key, and there is no ctsKey. */
function rtsAccount(): ApigwKeys {
  return {
    signingKey: { keyId: "sign-1", privateKey: new Uint8Array(64), publicKey: new Uint8Array(32) },
    encryptionKey: { keyId: RTS_ID, privateKey: recipientKeys.secretKey, publicKey: recipientKeys.publicKey },
    serverPublicKey: new Uint8Array(32),
    serverPublicKeyId: "kdc-start-ets",
  };
}

test("unboxMessageKey decrypts an RTS account's message via encryptionKey (no ctsKey)", async () => {
  const plaintext = buildTextPayload("публичный тест", "sender-huid", CHAT);
  const { boxed, body } = await sealMessage(plaintext, recipientKeys.publicKey);
  const msg = {
    sync_id: SYNC,
    group_chat_id: CHAT,
    payload: body,
    sender: "sender-huid",
    sender_key_id: "sender-key-id",
    inserted_at: new Date().toISOString(),
    key: { key: boxed, key_id: RTS_ID, algo: "xsalsa20:xchacha20_aead_ietf" },
  } as unknown as HistoryMessage;

  const keys = rtsAccount();
  const keyMap = new Map([["sender-key-id", { body: Buffer.from(senderKeys.publicKey).toString("base64") }]]) as never;
  const sym = unboxMessageKey(msg, keys.encryptionKey.privateKey, RTS_ID, keyMap, keys);
  const payload = decryptWithKey(msg, sym);
  assert.equal(payload.body, "публичный тест");
});

test("a stray ctsKey would shadow the rts key — the reason login must not mint one", async () => {
  const plaintext = buildTextPayload("публичный тест", "sender-huid", CHAT);
  const { boxed, body } = await sealMessage(plaintext, recipientKeys.publicKey);
  const msg = {
    sync_id: SYNC,
    group_chat_id: CHAT,
    payload: body,
    sender: "sender-huid",
    sender_key_id: "sender-key-id",
    inserted_at: new Date().toISOString(),
    key: { key: boxed, key_id: RTS_ID, algo: "xsalsa20:xchacha20_aead_ietf" },
  } as unknown as HistoryMessage;

  const stray = nacl.box.keyPair();
  const keys = rtsAccount();
  keys.ctsKey = { keyId: "stray-cts", privateKey: stray.secretKey, publicKey: stray.publicKey };

  const keyMap = new Map([["sender-key-id", { body: Buffer.from(senderKeys.publicKey).toString("base64") }]]) as never;
  // decrypt.ts picks ctsKey ?? encryptionKey — with a stray cts key the key_id no longer matches.
  assert.throws(
    () => unboxMessageKey(msg, keys.ctsKey!.privateKey, keys.ctsKey!.keyId, keyMap, keys),
    /key not for us/,
  );
});

test("getSenderPublicKey falls back to encryptionKey for RTS senders", async () => {
  const keys = rtsAccount();
  const msg = { sender_key_id: RTS_ID } as unknown as HistoryMessage;
  const pub = getSenderPublicKey(msg, new Map() as never, keys);
  assert.deepEqual(Array.from(pub!), Array.from(recipientKeys.publicKey));
});

test("buildTextPayload still emits the wire shape the server expects", () => {
  const raw = buildTextPayload("привет", HUID, CHAT);
  const p = JSON.parse(raw);
  assert.equal(p.body, "привет");
  assert.equal(p.group_chat_id, CHAT);
  assert.equal(p.from, HUID);
  assert.equal(p.type, "text");
});
