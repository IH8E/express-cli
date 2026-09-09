import sodium from "libsodium-wrappers-sumo";

/** Matches the eXpress web client's file chunking size (`meta.chunk_size` on upload). */
export const FILE_CHUNK_SIZE = 2097152;

/**
 * Encrypt file bytes the way eXpress does for `file_encryption_algo: "stream"`:
 * libsodium secretstream (XChaCha20-Poly1305), framed as
 * [24-byte header][chunk 1 + 17-byte tag]...[last chunk + 17-byte tag, TAG_FINAL].
 */
export async function encryptFileStream(data: Buffer, key: Uint8Array): Promise<Buffer> {
  await sodium.ready;
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  const parts: Uint8Array[] = [header];

  for (let offset = 0; offset < data.length; offset += FILE_CHUNK_SIZE) {
    const chunk = data.subarray(offset, offset + FILE_CHUNK_SIZE);
    const isLast = offset + FILE_CHUNK_SIZE >= data.length;
    const tag = isLast
      ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
      : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    parts.push(sodium.crypto_secretstream_xchacha20poly1305_push(state, chunk, null, tag));
  }

  return Buffer.concat(parts);
}
