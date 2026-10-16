import nacl from "tweetnacl";
import sodium from "libsodium-wrappers-sumo";
import { loadApigwKeys } from "../auth/keys.js";
import { ApiClient } from "./client.js";

export interface HistoryMessage {
  sync_id: string;
  payload: string;
  key: { algo: string; key: string; key_id: string };
  sender: string;
  sender_key_id: string;
  group_chat_id: string;
  inserted_at: string;
  event_type: string;
  meta?: { thread_started?: boolean; activities?: { reaction_counters?: string | null; user_reactions?: unknown } };
}

export interface ImageAttachment {
  fileName: string;
  mimeType?: string;
  /** Inline base64 data-URI (blur_preview_file) — renderable without download/decryption. */
  previewDataUri?: string;
  width?: number;
  height?: number;
}

/** Encrypted-file attachment (image or document). The file lives at `file`
 * (`/uploads/files/{chat_id}/{id}`) as a libsodium secretstream
 * (crypto_secretstream_xchacha20poly1305); the stream key is the message's own
 * symmetric key (verified on live messages), or — if the payload carries
 * `keys[]` — the key boxed for our key_id there. */
export interface FileAttachment {
  fileName: string;
  mimeType?: string;
  /** Download path `/uploads/files/{chat_id}/{id}` (older payloads: bare file id). */
  file: string;
  keys?: Array<{ key_id: string; key: string; algo: string }>;
  chunkSize?: number;
  fileSize?: number;
  fileHash?: string;
}

/** The message this one replies to (payload.reply). */
export interface ReplyRef {
  sync_id: string;
  sender: string;
  body: string;
}

export interface DecryptedMessage {
  sync_id: string;
  body: string;
  sender: string;
  inserted_at: string;
  decrypted: boolean;
  error?: string;
  type?: string;
  image?: ImageAttachment;
  /** Full encrypted-file descriptor (present on image/file messages). */
  attachment?: FileAttachment;
  /** True when a discussion (thread) starts at this message (meta.thread_started). */
  thread_started?: boolean;
  /** Reactions summary from meta.activities, e.g. "✅:1;👀:1". */
  reactions?: string;
  reply?: ReplyRef;
}

type KdcKeyMap = Map<string, { id: string; body: string; user_huid: string }>;
type ApigwKeys = NonNullable<ReturnType<typeof loadApigwKeys>>;

/** Unbox the message's symmetric key (nacl.box nonce||ct addressed to our key_id).
 * Also the stream key of the message's file attachment. */
export function unboxMessageKey(
  msg: HistoryMessage,
  ctsPrivateKey: Uint8Array,
  myKeyId: string,
  keyMap: KdcKeyMap,
  apigwKeys: ApigwKeys,
): Uint8Array {
  const encKey = msg.key;
  if (encKey.key_id !== myKeyId) {
    throw new Error(`key not for us (key_id=${encKey.key_id}, myKeyId=${myKeyId})`);
  }

  const keyRaw = Uint8Array.from(Buffer.from(encKey.key, "base64"));
  const nonce = keyRaw.slice(0, nacl.box.nonceLength);
  const ciphertext = keyRaw.slice(nacl.box.nonceLength);

  const senderPubKey = getSenderPublicKey(msg, keyMap, apigwKeys);
  if (!senderPubKey) throw new Error("cannot determine sender public key");

  const symmetricKey = nacl.box.open(ciphertext, nonce, senderPubKey, ctsPrivateKey);
  if (!symmetricKey) throw new Error("nacl.box.open failed — wrong key pair");
  return symmetricKey;
}

/**
 * Decrypt a single history/message_new event.
 * E2E: nacl.box.open(encrypted symmetric key) → XChaCha20-Poly1305 IETF body,
 * with AAD `${group_chat_id}:${sync_id}` (must match the sender).
 */
function decryptMessage(
  msg: HistoryMessage,
  ctsPrivateKey: Uint8Array,
  myKeyId: string,
  keyMap: KdcKeyMap,
  apigwKeys: ApigwKeys,
): DecryptedPayload {
  const symmetricKey = unboxMessageKey(msg, ctsPrivateKey, myKeyId, keyMap, apigwKeys);

  const payloadRaw = Uint8Array.from(Buffer.from(msg.payload, "base64"));
  const msgNonce = payloadRaw.slice(0, sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const msgCiphertext = payloadRaw.slice(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);

  const aad = new Uint8Array(Buffer.from(`${msg.group_chat_id}:${msg.sync_id}`));
  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, msgCiphertext, aad, msgNonce, symmetricKey);

  return JSON.parse(new TextDecoder().decode(plaintext)) as DecryptedPayload;
}

/** Shape of the decrypted wire payload (text, image or file message). */
interface DecryptedPayload {
  type?: string;
  body?: string;
  payload?: {
    file_name?: string;
    file_mime_type?: string;
    blur_preview_file?: string;
    file_preview_width?: number;
    file_preview_height?: number;
    /** Encrypted-file fields (image/file attachments). */
    file?: string;
    file_size?: number;
    file_hash?: string;
    chunk_size?: number;
    file_encryption_algo?: string;
    keys?: Array<{ key_id: string; key: string; algo: string }>;
  };
  reply?: { sync_id?: string; payload?: { from?: string; body?: string } };
}

function toDecrypted(msg: HistoryMessage, payload: DecryptedPayload): DecryptedMessage {
  const base: DecryptedMessage = {
    sync_id: msg.sync_id,
    body: "",
    sender: msg.sender ?? "",
    inserted_at: msg.inserted_at,
    decrypted: true,
    type: payload.type,
    thread_started: msg.meta?.thread_started === true ? true : undefined,
    reactions: msg.meta?.activities?.reaction_counters ?? undefined,
  };
  const p = payload.payload;
  const isImage = !!p && (payload.type === "image" || (!!p.file && (p.file_mime_type ?? "").startsWith("image/")));
  const image: ImageAttachment | undefined = isImage ? {
    fileName: p.file_name ?? "image",
    mimeType: p.file_mime_type,
    previewDataUri: p.blur_preview_file,
    width: p.file_preview_width,
    height: p.file_preview_height,
  } : undefined;
  const attachment: FileAttachment | undefined = p?.file ? {
    fileName: p.file_name ?? "file",
    mimeType: p.file_mime_type,
    file: p.file,
    keys: p.keys,
    chunkSize: p.chunk_size,
    fileSize: p.file_size,
    fileHash: p.file_hash,
  } : undefined;
  const r = payload.reply;
  const reply: ReplyRef | undefined = r?.sync_id
    ? { sync_id: r.sync_id, sender: r.payload?.from ?? "", body: r.payload?.body ?? "" }
    : undefined;
  return { ...base, body: payload.body ?? "", image, attachment, reply };
}

export function getSenderPublicKey(
  msg: HistoryMessage,
  keyMap: KdcKeyMap,
  apigwKeys: ApigwKeys,
): Uint8Array | null {
  const senderKeyId = msg.sender_key_id;
  if (!senderKeyId) return null;

  if (senderKeyId === apigwKeys.ctsKey?.keyId) return apigwKeys.ctsKey.publicKey;
  if (senderKeyId === apigwKeys.encryptionKey?.keyId) return apigwKeys.encryptionKey.publicKey;

  const kdcKey = keyMap.get(senderKeyId);
  if (kdcKey) return new Uint8Array(Buffer.from(kdcKey.body, "base64"));
  return null;
}

/** Sender/recipient public keys from KDC for a batch of events. */
export async function fetchKeyMap(events: HistoryMessage[], client: ApiClient): Promise<KdcKeyMap> {
  const keyIds = [...new Set([
    ...events.map((m) => m.sender_key_id).filter(Boolean),
    ...events.map((m) => m.key.key_id),
  ])];
  const kdcKeys = await client.get<Array<{ id: string; body: string; user_huid: string }>>(
    `/api/v1/kdc/keys/?ids=${keyIds.join(",")}`,
  ) ?? [];
  return new Map(kdcKeys.map((k) => [k.id, k]));
}

/**
 * Fetch the sender public keys from KDC and decrypt a batch of message events.
 * Shared by `messages list` and the live session layer.
 */
export async function decryptMessages(
  events: HistoryMessage[],
  apigwKeys: ApigwKeys,
  client: ApiClient = new ApiClient(),
): Promise<DecryptedMessage[]> {
  await sodium.ready;
  const ctsKey = apigwKeys.ctsKey ?? apigwKeys.encryptionKey;
  const messages = events.filter((e) => e.event_type === "message_new" && e.payload && e.key);
  if (messages.length === 0) return [];

  const keyMap = await fetchKeyMap(messages, client);

  return messages.map((msg) => {
    try {
      return toDecrypted(msg, decryptMessage(msg, ctsKey.privateKey, ctsKey.keyId, keyMap, apigwKeys));
    } catch (err) {
      return { sync_id: msg.sync_id, body: "", sender: msg.sender ?? "", inserted_at: msg.inserted_at, decrypted: false, error: (err as Error).message };
    }
  });
}
