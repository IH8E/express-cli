import { signEd25519, generateNonce, loadApigwKeys, encryptToken, saveApigwKeys } from "./keys.js";
import { sha256 } from "@noble/hashes/sha2.js";


export interface ApigwSignedHeaders {
  Authorization: string;
  "Express-Proxy-Authorization": string;
  "Express-Request-Nonce": string;
  Digest?: string;
  Signature: string;
  "Content-Type"?: string;
}

export function buildSigningInput(
  method: string,
  path: string,
  created: number,
  nonce: string,
  rtsAccessToken: string,
  digest?: string,
): { signingString: string; signedHeaders: string } {
  return buildSigningInputInternal(method, path, created, nonce, rtsAccessToken, digest);
}

export function buildQrSigningInput(
  method: string,
  path: string,
  created: number,
  nonce: string,
  digest?: string,
): { signingString: string; signedHeaders: string } {
  return buildSigningInputInternal(method, path, created, nonce, undefined, digest);
}

function buildSigningInputInternal(
  method: string,
  path: string,
  created: number,
  nonce: string,
  rtsAccessToken: string | undefined,
  digest?: string,
): { signingString: string; signedHeaders: string } {
  const lines: string[] = [];
  const headerNames: string[] = [];

  lines.push(`(request-target): ${method.toLowerCase()} ${path}`);
  headerNames.push("(request-target)");

  lines.push(`(created): ${created}`);
  headerNames.push("(created)");

  if (rtsAccessToken) {
    lines.push(`(rts-access-token): ${rtsAccessToken}`);
    headerNames.push("(rts-access-token)");
  }

  lines.push(`express-request-nonce: ${nonce}`);
  headerNames.push("express-request-nonce");

  if (digest) {
    lines.push(`digest: SHA-256=${digest}`);
    headerNames.push("digest");
  }

  return {
    signingString: lines.join("\n"),
    signedHeaders: headerNames.join(" "),
  };
}

export function computeDigest(body: string): string {
  const hash = sha256(new TextEncoder().encode(body));
  return Buffer.from(hash).toString("base64");
}

export async function signApigwRequest(params: {
  method: string;
  url: string;
  baseUrl: string;
  body?: string;
  ctsToken: string;
  rtsToken?: string;
  etsAuthToken?: string;
}): Promise<ApigwSignedHeaders> {
  const keys = loadApigwKeys();
  if (!keys) {
    throw new Error("Apigw keys not initialized. Run 'express auth login' first.");
  }

  const urlObj = new URL(params.url.startsWith("http") ? params.url : `${params.baseUrl}${params.url}`);
  const path = urlObj.pathname + urlObj.search;
  const created = Math.floor(Date.now() / 1000);
  const nonce = generateNonce();

  let digest: string | undefined;
  if (params.body) {
    digest = computeDigest(params.body);
  }

  const tokenForSigning = params.etsAuthToken || params.rtsToken || params.ctsToken;
  const { signingString, signedHeaders } = buildSigningInput(
    params.method,
    path,
    created,
    nonce,
    tokenForSigning,
    digest,
  );

  if (process.env.EXPRESS_DEBUG) {
    console.log(`  [DEBUG] path: ${path}`);
    console.log(`  [DEBUG] signedHeaders: ${signedHeaders}`);
    console.log(`  [DEBUG] signingString:\n${signingString}`);
    console.log(`  [DEBUG] signingKey keyId: ${keys.signingKey.keyId}`);
    console.log(`  [DEBUG] encryptionKey keyId: ${keys.encryptionKey.keyId}`);
  }

  const signature = signEd25519(keys.signingKey.privateKey, new TextEncoder().encode(signingString));
  const signatureBase64 = Buffer.from(signature).toString("base64");

  let serverPublicKey = keys.serverPublicKey;
  try {
    const etsBaseUrl = params.baseUrl;
    const kdcStartRes = await fetch(`${etsBaseUrl}/api/v1/kdc/start`, {
      headers: {
        Accept: "application/json",
      },
    });
    if (kdcStartRes.ok) {
      const kdcStartData = await kdcStartRes.json() as { result?: string };
      if (kdcStartData.result) {
        serverPublicKey = new Uint8Array(Buffer.from(kdcStartData.result, "base64"));
        if (process.env.EXPRESS_DEBUG) {
          console.log(`  [DEBUG] ETS server public key (curve25519): ${kdcStartData.result}`);
        }
        keys.serverPublicKey = serverPublicKey;
        keys.serverPublicKeyId = "kdc-start-ets";
        saveApigwKeys(keys);
      }
    }
  } catch {
    // Fall back to cached key
  }

  const tokenToEncrypt = params.etsAuthToken || params.rtsToken || params.ctsToken;
  const encryptedToken = encryptToken(tokenToEncrypt, serverPublicKey, keys.encryptionKey.privateKey);

  if (process.env.EXPRESS_DEBUG) {
    console.log(`  [DEBUG] ctsToken length: ${params.ctsToken.length}`);
    console.log(`  [DEBUG] rtsToken: ${params.rtsToken ? `present (${params.rtsToken.length} chars)` : "not set"}`);
    console.log(`  [DEBUG] etsAuthToken: ${params.etsAuthToken ? `present (${params.etsAuthToken.length} chars)` : "not set"}`);
    console.log(`  [DEBUG] tokenToEncrypt: ${tokenToEncrypt.length} chars (source: ${params.etsAuthToken ? 'etsAuthToken' : params.rtsToken ? 'rtsToken' : 'ctsToken'})`);
    console.log(`  [DEBUG] serverPublicKey b64: ${Buffer.from(serverPublicKey).toString("base64")}`);
    console.log(`  [DEBUG] encryptionPrivateKey b64: ${Buffer.from(keys.encryptionKey.privateKey).toString("base64")}`);
    console.log(`  [DEBUG] encryptionPublicKey b64: ${Buffer.from(keys.encryptionKey.publicKey).toString("base64")}`);
    console.log(`  [DEBUG] encryptedToken length: ${encryptedToken.length}`);
  }

  return {
    Authorization: `keyId="${keys.encryptionKey.keyId}",token="${encryptedToken}"`,
    "Express-Proxy-Authorization": `Bearer ${params.ctsToken}`,
    "Express-Request-Nonce": nonce,
    ...(digest && { Digest: `SHA-256=${digest}` }),
    Signature: `keyId="${keys.signingKey.keyId}",algorithm="ed25519",headers="${signedHeaders}",signature="${signatureBase64}",created=${created}`,
    ...(params.body && { "Content-Type": "application/json" }),
  };
}

export interface QrSignedHeaders {
  "Express-Request-Nonce": string;
  Digest: string;
  Signature: string;
  "Content-Type": string;
}

export function signQrRequest(params: {
  method: string;
  url: string;
  body: string;
  registrationId: string;
  privateKey: Uint8Array;
}): QrSignedHeaders {
  const urlObj = new URL(params.url);
  const path = urlObj.pathname + urlObj.search;
  const created = Math.floor(Date.now() / 1000);
  const nonce = generateNonce();
  const digest = computeDigest(params.body);

  const { signingString, signedHeaders } = buildQrSigningInput(
    params.method,
    path,
    created,
    nonce,
    digest,
  );

  const signature = signEd25519(params.privateKey, new TextEncoder().encode(signingString));
  const signatureBase64 = Buffer.from(signature).toString("base64");

  if (process.env.EXPRESS_DEBUG) {
    console.log(`  [DEBUG QR] path: ${path}`);
    console.log(`  [DEBUG QR] signedHeaders: ${signedHeaders}`);
    console.log(`  [DEBUG QR] signingString:\n${signingString}`);
  }

  return {
    "Express-Request-Nonce": nonce,
    Digest: `SHA-256=${digest}`,
    Signature: `keyId="${params.registrationId}",algorithm="ed25519",headers="${signedHeaders}",signature="${signatureBase64}",created=${created}`,
    "Content-Type": "application/json",
  };
}
