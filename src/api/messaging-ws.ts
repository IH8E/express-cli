import WebSocket from "ws";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import nacl from "tweetnacl";
import sodium from "libsodium-wrappers-sumo";
import sharp from "sharp";
import type { ApiClient } from "./client.js";
import { UserApi } from "./user.js";
import { FileServiceApi, detectImageMimeType, type FileUploadKey } from "./file-service.js";
import { encryptFileStream, FILE_CHUNK_SIZE } from "./file-crypto.js";
import { loadApigwKeys, signEd25519 } from "../auth/keys.js";
import { getAuthToken } from "../config/store.js";
import { loadConfig, getBaseUrl, getWebOrigin } from "../config/index.js";

/**
 * Build the wire plaintext for a text message. Shape reverse-engineered from the
 * eXpress web client (`encryptMessagePayload` in app.js): a flat snake_case
 * object with `body` (plain text) — the client generates the markdown AST from
 * `body` on receipt, so no bodyAstTree on the wire. A bare `{body}` makes
 * recipients show "Can't decrypt".
 */
function buildTextPayload(text: string, fromHuid: string, chatId: string): string {
  return JSON.stringify({
    type: "text",
    msg_id: randomUUID(),
    from: fromHuid,
    timestamp: new Date().toISOString(),
    group_chat_id: chatId,
    lat: 0,
    lng: 0,
    link_meta_disabled: false,
    stealth_forwarding: false,
    body: text,
  });
}

/** Build the wire plaintext for an image message (shape reverse-engineered from a captured HAR). */
function buildImagePayload(params: {
  fromHuid: string;
  chatId: string;
  caption: string;
  fileName: string;
  fileSize: number;
  fileHash: string;
  mimeType: string;
  contentPath: string;
  previewPath: string;
  previewWidth: number;
  previewHeight: number;
  blurPreviewDataUri: string;
  fileId: string;
}): string {
  return JSON.stringify({
    type: "image",
    msg_id: randomUUID(),
    from: params.fromHuid,
    timestamp: new Date().toISOString(),
    group_chat_id: params.chatId,
    lat: 0,
    lng: 0,
    stealth_forwarding: false,
    payload: {
      file: params.contentPath,
      file_name: params.fileName,
      file_size: params.fileSize,
      file_hash: params.fileHash,
      file_mime_type: params.mimeType,
      chunk_size: FILE_CHUNK_SIZE,
      file_encryption_algo: "stream",
      file_preview: params.previewPath,
      file_preview_width: params.previewWidth,
      file_preview_height: params.previewHeight,
      blur_preview_file: params.blurPreviewDataUri,
      file_id: params.fileId,
    },
    body: params.caption,
  });
}

/** AEAD additional data — must match the client: `${groupChatId}:${syncId}`. */
function payloadAad(chatId: string, syncId: string): Uint8Array {
  return new Uint8Array(Buffer.from(`${chatId}:${syncId}`));
}

interface KdcKey {
  id: string;
  body: string; // base64 Curve25519 public key
  algo: string;
  kind: string;
  user_huid: string;
}

interface EncryptedKey {
  key_id: string;
  key: string; // base64 nonce+ciphertext
  algo: string;
}

/** Seal a symmetric key for each recipient via nacl.box (Curve25519 + XSalsa20-Poly1305). */
function wrapKeyForRecipients(
  symmetricKey: Uint8Array,
  publicKeys: KdcKey[],
  ctsKey: { privateKey: Uint8Array },
): EncryptedKey[] {
  return publicKeys.map((kdcKey) => {
    const recipientPubKey = new Uint8Array(Buffer.from(kdcKey.body, "base64"));
    const nonce = randomBytes(nacl.box.nonceLength);
    const ciphertext = nacl.box(symmetricKey, nonce, recipientPubKey, ctsKey.privateKey);
    if (!ciphertext) throw new Error(`Failed to encrypt key for ${kdcKey.id}`);
    const combined = Buffer.concat([nonce, Buffer.from(ciphertext)]);
    return { key_id: kdcKey.id, key: combined.toString("base64"), algo: "xsalsa20:xchacha20_aead_ietf" };
  });
}

export async function sendMessageViaWebSocket(params: {
  client: ApiClient;
  chatId: string;
  body: string;
  timeoutMs?: number;
}): Promise<{ sync_id: string }> {
  const { client, chatId, body, timeoutMs = 20000 } = params;

  await sodium.ready;

  const apigwKeys = loadApigwKeys();
  if (!apigwKeys) throw new Error("No apigw keys. Run 'express auth login' first.");

  const config = loadConfig();
  const host = new URL(getBaseUrl(config)).hostname;
  const webOrigin = getWebOrigin(config);
  const ctsToken = getAuthToken();
  const ctsKey = apigwKeys.ctsKey ?? apigwKeys.encryptionKey;
  const encKeyId = ctsKey.keyId;

  // Step 1: get participant key_ids via WebSocket chat_info.
  // The server rejects message_new with `invalid_keys` unless keys[] matches this
  // set exactly — no extra/superseded key_ids allowed, so encrypt for these only.
  const participantKeyIds = await getChatKeyIds(host, webOrigin, ctsToken, encKeyId, chatId);

  // Step 2: fetch public keys from KDC (only cts keys are usable for E2E)
  const kdcKeys = await client.get<KdcKey[]>(
    `/api/v1/kdc/keys/?ids=${participantKeyIds.join(",")}`,
  ) ?? [];
  const publicKeys = kdcKeys.filter((k) => k.kind === "cts");

  // Step 3: generate symmetric key + sync_id (sync_id is part of the body AAD)
  const symmetricKey = randomBytes(32);
  const syncId = randomUUID();

  // Step 4: encrypt symmetric key for each participant
  const encryptedKeys = wrapKeyForRecipients(symmetricKey, publicKeys, ctsKey);

  // Step 5: encrypt message body with XChaCha20-Poly1305 IETF.
  // AAD = `${group_chat_id}:${sync_id}` — recipients authenticate against it, so
  // it must match or they get "Can't decrypt".
  const selfHuid = (await new UserApi(client).getSelfProfile()).user_huid;
  const plaintext = new Uint8Array(Buffer.from(buildTextPayload(body, selfHuid, chatId)));
  const msgNonce = randomBytes(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext, payloadAad(chatId, syncId), null,
    new Uint8Array(msgNonce),
    new Uint8Array(symmetricKey),
  );
  const encryptedPayload = Buffer.concat([msgNonce, Buffer.from(ciphertext)]).toString("base64");

  // Step 6: send via WebSocket (no signature required for DMs)
  // Sign the base64 payload string with ed25519 (browser requires this to decrypt)
  const signingKey = apigwKeys.signingKey;
  const signBytes = signEd25519(
    signingKey.privateKey,
    new Uint8Array(Buffer.from(encryptedPayload, "utf8")),
  );
  const signature = {
    sign: Buffer.from(signBytes).toString("base64"),
    sign_key_id: signingKey.keyId,
    sign_algo: "ed25519",
  };

  return sendMessageNew({
    host,
    webOrigin,
    ctsToken,
    encKeyId,
    chatId,
    syncId,
    encryptedKeys,
    encryptedPayload,
    signature,
    timeoutMs,
  });
}

/**
 * Generate the thumbnail eXpress expects for both the uploaded `preview` shape and the
 * inline `blur_preview_file`. These are reused as ONE buffer on purpose: our uploads sit
 * in `antimalware: scan_planned` indefinitely (server-side, not something the CLI
 * controls), and the client keeps rendering `blur_preview_file` — never `preview` —
 * for as long as that scan is pending. A separate tiny/low-quality blur placeholder
 * (meant to be shown for a fraction of a second) ends up being the only thing anyone
 * ever sees, so it needs to look like a real thumbnail, not a blur-up stub.
 */
async function buildPreview(
  imageBytes: Buffer,
): Promise<{ data: Buffer; width: number; height: number; blurData: Buffer }> {
  const data = await sharp(imageBytes)
    .resize({ width: 300, height: 300, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  const blurData = data;
  const { width, height } = await sharp(data).metadata();
  return { data, width: width ?? 0, height: height ?? 0, blurData };
}

export async function sendImageViaWebSocket(params: {
  client: ApiClient;
  chatId: string;
  filePath: string;
  caption?: string;
  timeoutMs?: number;
}): Promise<{ sync_id: string }> {
  const { client, chatId, filePath, caption = "", timeoutMs = 30000 } = params;

  const fileName = basename(filePath);
  const mimeType = detectImageMimeType(fileName);
  if (!mimeType) {
    throw new Error(
      `Unsupported file type for '${fileName}'. Only images are currently supported: .png, .jpg, .jpeg, .gif, .webp`,
    );
  }

  await sodium.ready;

  const apigwKeys = loadApigwKeys();
  if (!apigwKeys) throw new Error("No apigw keys. Run 'express auth login' first.");

  const config = loadConfig();
  const host = new URL(getBaseUrl(config)).hostname;
  const webOrigin = getWebOrigin(config);
  const ctsToken = getAuthToken();
  const ctsKey = apigwKeys.ctsKey ?? apigwKeys.encryptionKey;
  const encKeyId = ctsKey.keyId;

  // Step 1-2: same participant discovery as text messages — recipients must match exactly.
  const participantKeyIds = await getChatKeyIds(host, webOrigin, ctsToken, encKeyId, chatId);
  const kdcKeys = await client.get<KdcKey[]>(
    `/api/v1/kdc/keys/?ids=${participantKeyIds.join(",")}`,
  ) ?? [];
  const publicKeys = kdcKeys.filter((k) => k.kind === "cts");

  const originalBytes = await readFile(filePath);
  const fileHash = createHash("sha256").update(originalBytes).digest("base64");
  const preview = await buildPreview(originalBytes);
  const blurPreviewDataUri = `data:image/jpeg;base64,${preview.blurData.toString("base64")}`;

  // Step 3: the file content is encrypted under its OWN symmetric key, separate from the message envelope key.
  const fileKey = randomBytes(32);
  const fileKeys: FileUploadKey[] = wrapKeyForRecipients(fileKey, publicKeys, ctsKey);
  const syncId = randomUUID();

  const encryptedContent = await encryptFileStream(originalBytes, fileKey);
  const encryptedPreview = await encryptFileStream(preview.data, fileKey);

  const uploaded = await new FileServiceApi(client).uploadWithPreview(
    {
      subject: "groupchat_file",
      subject_id: chatId,
      visible: true,
      file_name: fileName,
      mime_type: mimeType,
      meta: {
        sync_id: syncId,
        kind: "media",
        chunk_size: FILE_CHUNK_SIZE,
        file_encryption_algo: "stream",
        sender_key_id: encKeyId,
        keys: fileKeys,
        file_hash: fileHash,
      },
    },
    encryptedContent,
    { data: encryptedPreview, mimeType: "image/jpeg" },
  );

  // Step 4: build + encrypt the chat message that references the uploaded file (mirrors sendMessageViaWebSocket).
  const selfHuid = (await new UserApi(client).getSelfProfile()).user_huid;
  const plaintext = new Uint8Array(Buffer.from(buildImagePayload({
    fromHuid: selfHuid,
    chatId,
    caption,
    fileName,
    fileSize: originalBytes.length,
    fileHash,
    mimeType,
    contentPath: uploaded.content,
    previewPath: uploaded.content_shapes.preview ?? "",
    previewWidth: preview.width,
    previewHeight: preview.height,
    blurPreviewDataUri,
    fileId: uploaded.id,
  })));

  const msgKey = randomBytes(32);
  const encryptedKeys = wrapKeyForRecipients(msgKey, publicKeys, ctsKey);

  const msgNonce = randomBytes(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext, payloadAad(chatId, syncId), null,
    new Uint8Array(msgNonce),
    new Uint8Array(msgKey),
  );
  const encryptedPayload = Buffer.concat([msgNonce, Buffer.from(ciphertext)]).toString("base64");

  const signingKey = apigwKeys.signingKey;
  const signBytes = signEd25519(
    signingKey.privateKey,
    new Uint8Array(Buffer.from(encryptedPayload, "utf8")),
  );
  const signature = {
    sign: Buffer.from(signBytes).toString("base64"),
    sign_key_id: signingKey.keyId,
    sign_algo: "ed25519",
  };

  return sendMessageNew({
    host, webOrigin, ctsToken, encKeyId, chatId, syncId, encryptedKeys, encryptedPayload, signature, timeoutMs,
  });
}

async function getChatKeyIds(
  host: string,
  webOrigin: string,
  ctsToken: string,
  encKeyId: string,
  chatId: string,
): Promise<string[]> {
  const wsUrl = `wss://${host}/socket/user/websocket?vsn=1.0.0&auto_join=true&key_id=${encKeyId}&version=6&background=false&voex_unencrypted=true&instance_id=${randomUUID()}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      done(() => reject(new Error("Timeout getting chat key_ids")));
    }, 10000);

    const ws = new WebSocket(wsUrl, {
      headers: { Origin: webOrigin, "User-Agent": "Mozilla/5.0" },
    });

    let ref = 0;
    const authRef = ref++;
    let chatInfoRef: number;

    const send = (msg: object) => ws.send(JSON.stringify(msg));

    ws.addEventListener("open", () => {
      send({ topic: "phoenix", event: "authenticate", payload: { token: ctsToken }, ref: authRef });
    });

    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string) as {
        ref: number; event: string; topic: string;
        payload: { status: string; response: Record<string, unknown> };
      };

      if (msg.ref === authRef && msg.event === "phx_reply" && msg.payload?.status === "ok") {
        chatInfoRef = ref++;
        send({ topic: "system", event: "chat_info", payload: { group_chat_id: chatId, request_version: 6 }, ref: chatInfoRef });
        return;
      }

      if (msg.ref === chatInfoRef && msg.event === "phx_reply") {
        clearTimeout(timer);
        ws.close();
        const chatInfo = (msg.payload?.response?.chat_info ?? msg.payload?.response) as Record<string, unknown>;
        const keys = (chatInfo?.keys as string[]) ?? [];
        done(() => resolve(keys));
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(timer);
      done(() => reject(new Error(`WS error: ${String(err)}`)));
    });

    ws.addEventListener("close", () => {
      clearTimeout(timer);
      done(() => reject(new Error("WS closed before chat_info")));
    });
  });
}

async function sendMessageNew(params: {
  host: string;
  webOrigin: string;
  ctsToken: string;
  encKeyId: string;
  chatId: string;
  syncId: string;
  encryptedKeys: EncryptedKey[];
  encryptedPayload: string;
  signature: { sign: string; sign_key_id: string; sign_algo: string };
  timeoutMs: number;
}): Promise<{ sync_id: string }> {
  const { host, webOrigin, ctsToken, encKeyId, chatId, syncId, encryptedKeys, encryptedPayload, signature, timeoutMs } = params;
  const wsUrl = `wss://${host}/socket/user/websocket?vsn=1.0.0&auto_join=true&key_id=${encKeyId}&version=6&background=false&voex_unencrypted=true&instance_id=${randomUUID()}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      done(() => reject(new Error("Timeout sending message")));
    }, timeoutMs);

    const ws = new WebSocket(wsUrl, {
      headers: { Origin: webOrigin, "User-Agent": "Mozilla/5.0" },
    });

    let ref = 0;
    const authRef = ref++;
    let msgRef: number;

    const send = (msg: object) => ws.send(JSON.stringify(msg));

    ws.addEventListener("open", () => {
      send({ topic: "phoenix", event: "authenticate", payload: { token: ctsToken }, ref: authRef });
    });

    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string) as {
        ref: number; event: string; topic: string;
        payload: { status: string; response: Record<string, unknown> };
      };

      if (msg.ref === authRef && msg.event === "phx_reply" && msg.payload?.status === "ok") {
        msgRef = ref++;
        send({
          topic: `groupchat:${chatId}`,
          event: "message_new",
          payload: {
            keys: encryptedKeys,
            group_chat_id: chatId,
            sync_id: syncId,
            payload: encryptedPayload,
            signature,
          },
          ref: msgRef,
        });
        return;
      }

      if (msg.ref === msgRef && msg.event === "phx_reply") {
        clearTimeout(timer);
        ws.close();
        if (msg.payload?.status === "ok") {
          done(() => resolve({ sync_id: syncId }));
        } else {
          done(() => reject(new Error(`message_new failed: ${JSON.stringify(msg.payload?.response)}`)));
        }
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(timer);
      done(() => reject(new Error(`WS error: ${String(err)}`)));
    });

    ws.addEventListener("close", () => {
      clearTimeout(timer);
      done(() => reject(new Error("WS closed before message_new reply")));
    });
  });
}
