import nacl from "tweetnacl";
import sodium from "libsodium-wrappers-sumo";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAuthToken } from "../config/store.js";
import { loadConfig, getBaseUrl } from "../config/index.js";
import type { FileAttachment } from "./decrypt.js";

export interface DownloadedAttachment {
  path: string;
  fileName: string;
  mimeType?: string;
  size: number;
}

/** Web client default when the payload has no chunk_size. */
const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024;

/**
 * Decrypt an encrypted-file blob: libsodium secretstream
 * (crypto_secretstream_xchacha20poly1305) — 24-byte header, then chunks of
 * `chunkSize` plaintext bytes (+ABYTES each), the last one FINAL-tagged.
 * pull() needs the exact ciphertext length of each chunk.
 */
export function decryptFileStream(file: Uint8Array, streamKey: Uint8Array, chunkSize = DEFAULT_CHUNK_SIZE): Uint8Array {
  const HDR = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
  const ABY = sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
  if (file.length < HDR) throw new Error("file too short for secretstream header");
  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(file.slice(0, HDR), streamKey);
  const parts: Uint8Array[] = [];
  let off = HDR;
  while (off < file.length) {
    const end = Math.min(off + chunkSize + ABY, file.length);
    const res = sodium.crypto_secretstream_xchacha20poly1305_pull(state, file.slice(off, end), null);
    if (!res) throw new Error(`secretstream pull failed at offset ${off}`);
    parts.push(res.message);
    off = end;
    if (res.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) break;
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

/** Unbox a stream key from the payload's own `keys[]` (nacl.box nonce||ct, sealed with
 * the sender's public key). Only for payloads that carry `keys[]`; live messages use
 * the message key instead (see FileAttachment). */
export function unboxStreamKey(
  attachment: FileAttachment,
  ctsPrivateKey: Uint8Array,
  myKeyId: string,
  senderPublicKey: Uint8Array,
): Uint8Array {
  const enc = attachment.keys?.find((k) => k.key_id === myKeyId);
  if (!enc) throw new Error(`attachment has no key for our key_id ${myKeyId}`);
  const raw = Uint8Array.from(Buffer.from(enc.key, "base64"));
  const nonce = raw.slice(0, nacl.box.nonceLength);
  const ct = raw.slice(nacl.box.nonceLength);
  const key = nacl.box.open(ct, nonce, senderPublicKey, ctsPrivateKey);
  if (!key) throw new Error(`attachment key unbox failed (key_id=${enc.key_id})`);
  return key;
}

/** Download, decrypt and hash-check an attachment, saving it to `outputPath` (or a temp file). */
export async function downloadAttachment(params: {
  chatId: string;
  attachment: FileAttachment;
  streamKey: Uint8Array;
  outputPath?: string;
}): Promise<DownloadedAttachment> {
  const { chatId, attachment, streamKey, outputPath } = params;

  const token = getAuthToken();
  if (!token) throw new Error("Not authenticated. Run 'express auth qr' first.");
  const path = attachment.file.startsWith("/") ? attachment.file : `/uploads/files/${chatId}/${attachment.file}`;
  const res = await fetch(`${getBaseUrl(loadConfig())}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "*/*" },
  });
  if (!res.ok) throw new Error(`File download failed: ${res.status} ${res.statusText}`);
  const encrypted = new Uint8Array(await res.arrayBuffer());

  await sodium.ready;
  const plaintext = decryptFileStream(encrypted, streamKey, attachment.chunkSize);
  // file_hash = base64(BLAKE2b-256(plaintext)), verified on live messages
  if (attachment.fileHash && Buffer.from(sodium.crypto_generichash(32, plaintext, null)).toString("base64") !== attachment.fileHash) {
    throw new Error("Attachment hash mismatch — file corrupted or wrong key.");
  }

  const fileName = attachment.fileName || "file";
  const target = outputPath ?? join(
    mkdtempSync(join(tmpdir(), "express-attach-")),
    fileName.replace(/[/\\]/g, "_").replace(/^\.+$/, "file"),
  );
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, plaintext);
  return { path: target, fileName, mimeType: attachment.mimeType, size: plaintext.length };
}
