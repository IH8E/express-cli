import type { ApiClient } from "./client.js";
import { downloadAttachment, fetchAttachmentBytes, unboxStreamKey } from "./attachments.js";
import { decryptMessages, fetchKeyMap, getSenderPublicKey, unboxMessageKey } from "./decrypt.js";
import type { DecryptedMessage, HistoryMessage } from "./decrypt.js";
import { loadApigwKeys } from "../auth/keys.js";

/** Plaintext bytes of an image message's ORIGINAL file.
 *
 *  The inline `blur_preview_file` is deliberately blurred — fine as a placeholder, useless
 *  for reading text in a screenshot. The real file is the encrypted attachment next to it;
 *  the stream key is the message's own symmetric key (see FileAttachment), which is why this
 *  needs the raw history event rather than just the decrypted message.
 *
 *  Shared by the TUI (key `i`) and available to anything else that wants real pixels. */
export async function fetchImageBytes(params: {
  client: ApiClient;
  chatId: string;
  event: HistoryMessage;
  /** Already decrypted form of the same event, to avoid decrypting twice. */
  message?: DecryptedMessage;
}): Promise<{ bytes: Uint8Array; fileName: string; mimeType?: string }> {
  const { client, chatId, event } = params;

  const apigwKeys = loadApigwKeys();
  if (!apigwKeys) throw new Error("No apigw keys. Run 'express auth qr' first.");
  const ctsKey = apigwKeys.ctsKey ?? apigwKeys.encryptionKey;

  const message = params.message ?? (await decryptMessages([event], apigwKeys, client))[0];
  if (!message?.decrypted) throw new Error(`Cannot decrypt message: ${message?.error ?? "unknown error"}`);
  if (!message.attachment) throw new Error("This image has no downloadable file.");

  const keyMap = await fetchKeyMap([event], client);
  let streamKey: Uint8Array;
  if (message.attachment.keys?.length) {
    const senderPub = getSenderPublicKey(event, keyMap, apigwKeys);
    if (!senderPub) throw new Error("Cannot determine sender public key — stream key unboxing impossible.");
    streamKey = unboxStreamKey(message.attachment, ctsKey.privateKey, ctsKey.keyId, senderPub);
  } else {
    streamKey = unboxMessageKey(event, ctsKey.privateKey, ctsKey.keyId, keyMap, apigwKeys);
  }

  return fetchAttachmentBytes({ chatId, attachment: message.attachment, streamKey });
}

/** Download, decrypt and save an image message's original file to disk, returning its path.
 *  Used by the TUI to hand the file to the OS viewer — the terminal can only show ~7% of a
 *  screenshot's detail, so for "real" viewing the file goes to the system, not to the grid. */
export async function downloadImageFile(params: {
  client: ApiClient;
  chatId: string;
  event: HistoryMessage;
  message?: DecryptedMessage;
  outputPath?: string;
}): Promise<{ path: string; fileName: string }> {
  const { client, chatId, event } = params;

  const apigwKeys = loadApigwKeys();
  if (!apigwKeys) throw new Error("No apigw keys. Run 'express auth qr' first.");
  const ctsKey = apigwKeys.ctsKey ?? apigwKeys.encryptionKey;

  const message = params.message ?? (await decryptMessages([event], apigwKeys, client))[0];
  if (!message?.decrypted) throw new Error(`Cannot decrypt message: ${message?.error ?? "unknown error"}`);
  if (!message.attachment) throw new Error("This image has no downloadable file.");

  const keyMap = await fetchKeyMap([event], client);
  let streamKey: Uint8Array;
  if (message.attachment.keys?.length) {
    const senderPub = getSenderPublicKey(event, keyMap, apigwKeys);
    if (!senderPub) throw new Error("Cannot determine sender public key — stream key unboxing impossible.");
    streamKey = unboxStreamKey(message.attachment, ctsKey.privateKey, ctsKey.keyId, senderPub);
  } else {
    streamKey = unboxMessageKey(event, ctsKey.privateKey, ctsKey.keyId, keyMap, apigwKeys);
  }

  const saved = await downloadAttachment({ chatId, attachment: message.attachment, streamKey, outputPath: params.outputPath });
  return { path: saved.path, fileName: saved.fileName };
}
