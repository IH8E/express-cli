import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "node:crypto";
import { getApigwKeysRaw, setApigwKeysRaw } from "../config/store.js";
import nacl from "tweetnacl";

export interface SigningKeyPair {
  keyId: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface EncryptionKeyPair {
  keyId: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface ApigwKeys {
  signingKey: SigningKeyPair;
  encryptionKey: EncryptionKeyPair;
  ctsKey?: EncryptionKeyPair; // separate CTS key for E2E message encryption
  serverPublicKey: Uint8Array;
  serverPublicKeyId: string;
}

export function generateSigningKeyPair(): SigningKeyPair {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  const keyId = crypto.randomUUID();
  return { keyId, privateKey, publicKey };
}

export function generateEncryptionKeyPair(): EncryptionKeyPair {
  const keyPair = nacl.box.keyPair();
  const keyId = crypto.randomUUID();
  return {
    keyId,
    privateKey: keyPair.secretKey,
    publicKey: keyPair.publicKey,
  };
}

export function saveApigwKeys(keys: ApigwKeys): void {
  const data: Record<string, unknown> = {
    signingKey: {
      keyId: keys.signingKey.keyId,
      privateKey: Buffer.from(keys.signingKey.privateKey).toString("base64"),
      publicKey: Buffer.from(keys.signingKey.publicKey).toString("base64"),
    },
    encryptionKey: {
      keyId: keys.encryptionKey.keyId,
      privateKey: Buffer.from(keys.encryptionKey.privateKey).toString("base64"),
      publicKey: Buffer.from(keys.encryptionKey.publicKey).toString("base64"),
    },
    serverPublicKey: Buffer.from(keys.serverPublicKey).toString("base64"),
    serverPublicKeyId: keys.serverPublicKeyId,
  };
  if (keys.ctsKey) {
    data.ctsKey = {
      keyId: keys.ctsKey.keyId,
      privateKey: Buffer.from(keys.ctsKey.privateKey).toString("base64"),
      publicKey: Buffer.from(keys.ctsKey.publicKey).toString("base64"),
    };
  }
  setApigwKeysRaw(JSON.stringify(data));
}

export function loadApigwKeys(): ApigwKeys | null {
  const raw = getApigwKeysRaw();
  if (!raw) return null;

  try {
    const data = JSON.parse(raw) as {
      signingKey: { keyId: string; privateKey: string; publicKey: string };
      encryptionKey?: { keyId: string; privateKey: string; publicKey: string };
      ctsKey?: { keyId: string; privateKey: string; publicKey: string };
      serverPublicKey?: string;
      serverPublicKeyId?: string;
      rtsKeyId?: string;
      encryptionKeyId?: string;
      encryptionToken?: string;
    };

    if (!data.encryptionKey || !data.serverPublicKey) {
      return null;
    }

    return {
      signingKey: {
        keyId: data.signingKey.keyId,
        privateKey: new Uint8Array(Buffer.from(data.signingKey.privateKey, "base64")),
        publicKey: new Uint8Array(Buffer.from(data.signingKey.publicKey, "base64")),
      },
      encryptionKey: {
        keyId: data.encryptionKey.keyId,
        privateKey: new Uint8Array(Buffer.from(data.encryptionKey.privateKey, "base64")),
        publicKey: new Uint8Array(Buffer.from(data.encryptionKey.publicKey, "base64")),
      },
      ctsKey: data.ctsKey ? {
        keyId: data.ctsKey.keyId,
        privateKey: new Uint8Array(Buffer.from(data.ctsKey.privateKey, "base64")),
        publicKey: new Uint8Array(Buffer.from(data.ctsKey.publicKey, "base64")),
      } : undefined,
      serverPublicKey: new Uint8Array(Buffer.from(data.serverPublicKey, "base64")),
      serverPublicKeyId: data.serverPublicKeyId ?? data.rtsKeyId ?? data.encryptionKeyId ?? "",
    };
  } catch {
    return null;
  }
}

export function getOrCreateApigwKeys(): ApigwKeys {
  const existing = loadApigwKeys();
  if (existing) return existing;

  const keys: ApigwKeys = {
    signingKey: generateSigningKeyPair(),
    encryptionKey: generateEncryptionKeyPair(),
    serverPublicKey: new Uint8Array(0),
    serverPublicKeyId: "",
  };
  saveApigwKeys(keys);
  return keys;
}

export function signEd25519(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, privateKey);
}

export function encryptToken(token: string, serverPublicKey: Uint8Array, rtsPrivateKey: Uint8Array): string {
  const message = new TextEncoder().encode(token);
  const nonce = randomBytes(nacl.box.nonceLength);
  const encrypted = nacl.box(message, nonce, serverPublicKey, rtsPrivateKey);
  if (!encrypted) {
    throw new Error("crypto_box encryption failed");
  }
  const combined = new Uint8Array(nonce.length + encrypted.length);
  combined.set(nonce, 0);
  combined.set(encrypted, nonce.length);
  return Buffer.from(combined).toString("base64");
}

export function generateNonce(): string {
  return Buffer.from(randomBytes(32)).toString("base64");
}

export function publicKeyToBase64(publicKey: Uint8Array): string {
  return Buffer.from(publicKey).toString("base64");
}

export function clearApigwKeys(): void {
  setApigwKeysRaw(null);
}

/**
 * Import an existing CTS (E2E) keypair so the CLI shares the account's key with
 * the official devices instead of minting its own. Public key is derived from
 * the private key; keyId must be the KDC-published id (e.g. from the web client).
 */
export function importCtsKey(privateKeyB64: string, keyId: string): EncryptionKeyPair {
  const existing = loadApigwKeys();
  if (!existing) {
    throw new Error("No apigw keys yet. Run 'express auth login' or 'express auth qr' first.");
  }
  const privateKey = new Uint8Array(Buffer.from(privateKeyB64, "base64"));
  if (privateKey.length !== nacl.box.secretKeyLength) {
    throw new Error(`Invalid private key length: ${privateKey.length} bytes (expected ${nacl.box.secretKeyLength})`);
  }
  const publicKey = nacl.box.keyPair.fromSecretKey(privateKey).publicKey;
  const ctsKey: EncryptionKeyPair = { keyId, privateKey, publicKey };
  saveApigwKeys({ ...existing, ctsKey });
  return ctsKey;
}

export function decryptRegistrationData(registrationDataB64: string, encryptionKey: Uint8Array): unknown {
  const raw = Uint8Array.from(Buffer.from(registrationDataB64, "base64"));
  const nonce = raw.slice(0, nacl.secretbox.nonceLength);
  const ciphertext = raw.slice(nacl.secretbox.nonceLength);
  const plaintext = nacl.secretbox.open(ciphertext, nonce, encryptionKey);
  if (!plaintext) {
    throw new Error("Failed to decrypt registration_data");
  }
  const json = new TextDecoder().decode(plaintext);
  return JSON.parse(json);
}

export function decryptRtsToken(encryptedRtsTokenB64: string, serverPublicKey: Uint8Array, rtsPrivateKey: Uint8Array): string {
  const raw = Uint8Array.from(Buffer.from(encryptedRtsTokenB64, "base64"));
  const nonce = raw.slice(0, nacl.box.nonceLength);
  const ciphertext = raw.slice(nacl.box.nonceLength);
  const plaintext = nacl.box.open(ciphertext, nonce, serverPublicKey, rtsPrivateKey);
  if (!plaintext) {
    throw new Error("Failed to decrypt encrypted_rts_token");
  }
  return new TextDecoder().decode(plaintext);
}

export function extractRtsKeyIdFromToken(token: string): string {
  const parts = token.split(".");
  if (parts.length < 2) return "";
  const bytes = Buffer.from(parts[1], "base64");
  const text = bytes.toString("latin1");
  const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const uuids: string[] = [];
  let match;
  while ((match = uuidRegex.exec(text)) !== null) {
    uuids.push(match[0]);
  }
  return uuids.length >= 4 ? uuids[3] : "";
}
