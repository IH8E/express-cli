import { generateSigningKeyPair, publicKeyToBase64, saveApigwKeys, loadApigwKeys, decryptRegistrationData, decryptRtsToken, extractRtsKeyIdFromToken, type ApigwKeys } from "./keys.js";
import { signQrRequest, signApigwRequest } from "./apigw-signer.js";
import { openQrInBrowser } from "./qr-browser.js";
import { setAuthToken, setRtsAuthToken, setRefreshToken, setTokenExpiresAt, calcTokenExpiresAt, setEtsAuthToken } from "../config/store.js";
import { loadConfig, getBaseUrl, getEtsBaseUrl, getWebOrigin } from "../config/loader.js";
import type { Config } from "../types/index.js";
import { randomUUID, randomBytes } from "node:crypto";
import qrcode from "qrcode-terminal";
import nacl from "tweetnacl";

interface QrRequestResponse {
  status?: string;
  reason?: string;
  result?: {
    registration_id?: string;
    registration_data?: string;
    cts_registration_token?: string;
    rts_registration_token?: string;
  };
  registration_id?: string;
  registration_data?: string;
  cts_registration_token?: string;
  rts_registration_token?: string;
}

interface RegisterConfirmResponse {
  status?: string;
  result?: {
    user_huid?: string;
    server_id?: string;
    expires_at?: string | null;
    auth_token?: string;
  };
  user_huid?: string;
  server_id?: string;
  auth_token?: string;
}

interface AdIntegrationConfirmResponse {
  status?: string;
  result?: {
    active?: boolean;
    user_huid?: string;
    server_id?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  access_token?: string;
  refresh_token?: string;
}

interface KdcKeysResponse {
  status?: string;
  result?: Array<{
    id: string;
    body: string;
    kind: string;
    user_huid: string;
  }>;
}

function extractResult<T>(data: T & { result?: T }): T {
  return (data.result ?? data) as T;
}

/** Returns the account's current cts key_id in KDC, or null if none exists. */
async function fetchCurrentAccountCtsKey(baseUrl: string, accessToken: string, userHuid: string, webOrigin: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/kdc/keys/?user_huids=${userHuid}`, {
      headers: { ...commonHeaders(webOrigin), Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json() as { result?: Array<{ id: string; kind: string }> };
    return data.result?.find((k) => k.kind === "cts")?.id ?? null;
  } catch {
    return null;
  }
}

function commonHeaders(webOrigin: string): Record<string, string> {
  return {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ru-RU,ru;q=0.9",
    "Connection": "keep-alive",
    "Origin": webOrigin,
    "Referer": `${webOrigin}/`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
  };
}

// ─── Exported types and phase functions ──────────────────────────────────────

export interface QrMaterial {
  registrationId: string;
  encryptionKey: Buffer;
  qrSigningKey: ReturnType<typeof generateSigningKeyPair>;
  udid: string;
  /** JSON encoded in the QR image the phone scans */
  qrPayload: string;
  /** POST body for the ETS long-poll request */
  qrBody: string;
  config: ReturnType<typeof loadConfig>;
}

export interface QrPollResult {
  ctsRegistrationToken: string;
  rtsRegistrationToken: string;
  registrationData: string;
}

/** Phase 1: generate all key material and QR payloads (synchronous). */
export function buildQrMaterial(cliOverrides: Partial<Config> = {}): QrMaterial {
  const config = loadConfig(cliOverrides);
  const qrSigningKey = generateSigningKeyPair();
  const registrationId = qrSigningKey.keyId;
  const registrationToken = Buffer.from(randomBytes(64)).toString("base64");
  const signPubKey = publicKeyToBase64(qrSigningKey.publicKey);
  const udid = randomUUID();
  const encryptionKey = randomBytes(32);

  const qrPayload = JSON.stringify({
    registration_id: registrationId,
    registration_token: registrationToken,
    registration_key: Buffer.from(encryptionKey).toString("base64"),
    version: 1,
  });

  const qrBody = JSON.stringify({
    registration_id: registrationId,
    registration_token: registrationToken,
    sign_pub_key: signPubKey,
    udid,
    app_version: config.app_version,
    device: "Chrome 149.0",
    device_software: "macOS 10.15.7",
    device_hostname: null,
    device_meta: {
      pushes: false,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      permissions: { notifications: false },
    },
    locale: config.locale,
    manufacturer: "Google",
    platform: "web",
    platform_package_id: "com.pyligrim.alphach",
  });

  return { registrationId, encryptionKey, qrSigningKey, udid, qrPayload, qrBody, config };
}

/** Phase 2: long-poll ETS until the phone scans the QR. */
export async function pollForQrScan(mat: QrMaterial): Promise<QrPollResult> {
  const etsBaseUrl = getEtsBaseUrl(mat.config);
  const webOrigin = getWebOrigin(mat.config);
  const etsUrl = `${etsBaseUrl}/api/v1/authentication/qr/mobile_to_web/request`;
  const qrHeaders = signQrRequest({
    method: "POST",
    url: etsUrl,
    body: mat.qrBody,
    registrationId: mat.registrationId,
    privateKey: mat.qrSigningKey.privateKey,
  });

  let res: Response;
  try {
    res = await fetch(etsUrl, {
      method: "POST",
      headers: { ...commonHeaders(webOrigin), ...qrHeaders },
      body: mat.qrBody,
    });
  } catch (err) {
    throw new Error(`QR request network error: ${(err as Error).message}`);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`QR request failed (${res.status}): ${text.slice(0, 500)}`);

  const data = JSON.parse(text) as QrRequestResponse;
  if (process.env.EXPRESS_DEBUG) process.stderr.write(`[qr] full response: ${text.slice(0, 1000)}\n`);

  const result = extractResult(data);
  const ctsRegistrationToken = result.cts_registration_token ?? "";
  const rtsRegistrationToken = result.rts_registration_token ?? "";
  const registrationData = result.registration_data ?? "";

  if (!ctsRegistrationToken && !rtsRegistrationToken) {
    throw new Error(`No tokens in QR response: ${text.slice(0, 500)}`);
  }

  return { ctsRegistrationToken, rtsRegistrationToken, registrationData };
}

/** Phase 3: complete registration steps 2–7. `log` defaults to console.log. */
export async function completeQrRegistration(
  mat: QrMaterial,
  poll: QrPollResult,
  log: (msg: string) => void = console.log,
): Promise<void> {
  const { config, registrationId, encryptionKey, qrSigningKey } = mat;
  const { ctsRegistrationToken, rtsRegistrationToken, registrationData } = poll;
  const etsBaseUrl = getEtsBaseUrl(config);
  const webOrigin = getWebOrigin(config);

  log("  QR scanned! Got tokens from server.");
  if (process.env.EXPRESS_DEBUG) {
    log(`  [DEBUG] registration_data length: ${registrationData.length}`);
    log(`  [DEBUG] registration_data raw: ${registrationData.slice(0, 100)}...`);
    log(`  [DEBUG] encryptionKey (registration_key) hex: ${Buffer.from(encryptionKey).toString("hex")}`);
  }

  let rtsPrivateKey: Uint8Array | null = null;
  let rtsPublicKeyId = "";
  let qrCtsPrivateKey: Uint8Array | null = null;
  let qrCtsKeyId = "";

  if (registrationData) {
    try {
      const raw = Uint8Array.from(Buffer.from(registrationData, "base64"));
      if (process.env.EXPRESS_DEBUG) {
        log(`  [DEBUG] registration_data decoded length: ${raw.length}`);
        log(`  [DEBUG] first 40 bytes hex: ${Buffer.from(raw.slice(0, 40)).toString("hex")}`);
        log(`  [DEBUG] encryptionKey hex: ${Buffer.from(encryptionKey).toString("hex")}`);
        log(`  [DEBUG] encryptionKey length: ${encryptionKey.length}`);
      }
      const decrypted = decryptRegistrationData(registrationData, encryptionKey);
      if (process.env.EXPRESS_DEBUG) {
        log("  Decrypted registration_data: " + JSON.stringify(decrypted).slice(0, 500));
      }

      if (decrypted && typeof decrypted === "object") {
        const data = decrypted as Record<string, unknown>;
        if (typeof data.rts_priv_key_body === "string") {
          rtsPrivateKey = new Uint8Array(Buffer.from(data.rts_priv_key_body as string, "base64"));
        }
        if (typeof data.rts_pub_key_id === "string") {
          rtsPublicKeyId = data.rts_pub_key_id as string;
        }
        if (typeof data.cts_priv_key_body === "string" && typeof data.cts_pub_key_id === "string") {
          qrCtsPrivateKey = new Uint8Array(Buffer.from(data.cts_priv_key_body as string, "base64"));
          qrCtsKeyId = data.cts_pub_key_id as string;
        }
      }
    } catch (err) {
      log(`  Warning: could not decrypt registration_data: ${(err as Error).message}`);
    }
  }

  log("\nStep 2: Confirming with ETS...");

  const confirmUrl = `${etsBaseUrl}/api/v1/authentication/register_confirm/qr`;
  const confirmBody = JSON.stringify({
    registration_id: registrationId,
    temp_token: rtsRegistrationToken,
  });

  const confirmHeaders = signQrRequest({
    method: "POST",
    url: confirmUrl,
    body: confirmBody,
    registrationId,
    privateKey: qrSigningKey.privateKey,
  });

  const confirmRes = await fetch(confirmUrl, {
    method: "POST",
    headers: { ...commonHeaders(webOrigin), ...confirmHeaders },
    body: confirmBody,
  });

  const confirmText = await confirmRes.text();
  if (!confirmRes.ok) throw new Error(`ETS register_confirm failed (${confirmRes.status}): ${confirmText.slice(0, 500)}`);

  const confirmData = extractResult(JSON.parse(confirmText) as RegisterConfirmResponse);
  const userHuid = confirmData.user_huid ?? "";
  const etsAuthToken = confirmData.auth_token ?? "";

  log(`  ETS confirmed. User: ${userHuid || "unknown"}`);
  if (etsAuthToken) {
    setEtsAuthToken(etsAuthToken);
    if (process.env.EXPRESS_DEBUG) log(`  [DEBUG] ETS auth_token saved (${etsAuthToken.length} chars)`);
  }

  if (!ctsRegistrationToken) throw new Error("No cts_registration_token — cannot confirm with CTS");

  log("\nStep 3: Confirming with CTS (AD integration)...");

  const ctsUrl = `${getBaseUrl(config)}/api/v1/ad_integration/register_confirm/qr`;
  const adConfirmBody = JSON.stringify({
    rts_registration_id: registrationId,
    temp_token: ctsRegistrationToken,
    ets: true,
  });

  const adConfirmHeaders = signQrRequest({
    method: "POST",
    url: ctsUrl,
    body: adConfirmBody,
    registrationId,
    privateKey: qrSigningKey.privateKey,
  });

  const adRes = await fetch(ctsUrl, {
    method: "POST",
    headers: { ...commonHeaders(webOrigin), ...adConfirmHeaders },
    body: adConfirmBody,
  });

  const adText = await adRes.text();
  if (!adRes.ok) throw new Error(`AD integration confirm failed (${adRes.status}): ${adText.slice(0, 500)}`);

  const adData = extractResult(JSON.parse(adText) as AdIntegrationConfirmResponse);
  const accessToken = adData.access_token;
  const refreshToken = adData.refresh_token;
  const expiresIn = adData.expires_in;
  const serverId = (adData as Record<string, unknown>).server_id as string ?? userHuid;
  const encryptedRtsToken = (adData as Record<string, unknown>).encrypted_rts_token as string | undefined;

  if (process.env.EXPRESS_DEBUG) {
    const adDataRaw = JSON.parse(adText);
    log(`  [DEBUG] AD confirm full result keys: ${JSON.stringify(Object.keys(adDataRaw.result || adDataRaw))}`);
    if (encryptedRtsToken) log(`  [DEBUG] encrypted_rts_token found: ${encryptedRtsToken.slice(0, 60)}...`);
    else log(`  [DEBUG] encrypted_rts_token NOT found in response`);
  }

  if (!accessToken) throw new Error(`No access_token in AD confirm response: ${adText.slice(0, 500)}`);

  setAuthToken(accessToken);
  if (refreshToken) setRefreshToken(refreshToken);
  if (typeof expiresIn === "number") {
    setTokenExpiresAt(calcTokenExpiresAt(expiresIn));
    log(`  Token expires in ${expiresIn}s (refresh after ${(expiresIn / 2 / 60).toFixed(0)} min)`);
  }

  log(`  CTS confirmed. Access token: ${accessToken.slice(0, 40)}...`);

  log("\nStep 4: Registering device token...");

  const tokenUrl = `${getBaseUrl(config)}/api/v1/ad_integration/token`;
  const tokenBody = JSON.stringify({
    app_version: config.app_version,
    device: "Chrome 149.0",
    device_software: "macOS 10.15.7",
    manufacturer: "Google",
    platform: "web",
    locale: config.locale,
    platform_package_id: "com.pyligrim.alphach",
    device_meta: {
      pushes: false,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      permissions: { notifications: false },
    },
    device_hostname: null,
  });

  const tokenRes = await fetch(tokenUrl, {
    method: "PUT",
    headers: { ...commonHeaders(webOrigin), Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: tokenBody,
  });

  if (!tokenRes.ok) {
    const tokenErrText = await tokenRes.text().catch(() => "");
    log(`  Warning: device token registration failed (${tokenRes.status}): ${tokenErrText.slice(0, 200)}`);
  } else {
    log("  Device token registered.");
  }

  log("\nStep 5: Registering signing key + fetching server key...");

  if (process.env.EXPRESS_DEBUG) {
    log(`  [DEBUG] serverId: ${serverId}`);
    log(`  [DEBUG] userHuid: ${userHuid}`);
  }

  const apigwSigningKey = generateSigningKeyPair();
  const apigwKeyPublicBase64 = publicKeyToBase64(apigwSigningKey.publicKey);

  const kdcSignUrl = `${getBaseUrl(config)}/api/v2/kdc/keys/${userHuid}`;
  const kdcSignBody = JSON.stringify({
    key: apigwKeyPublicBase64,
    kind: "ed25519",
    algo: "ed25519",
    id: apigwSigningKey.keyId,
  });

  const [kdcSignRes, etsKdcSignRes, etsKdcStartRes] = await Promise.all([
    fetch(kdcSignUrl, {
      method: "POST",
      headers: { ...commonHeaders(webOrigin), Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: kdcSignBody,
    }),
    fetch(`${etsBaseUrl}/api/v2/kdc/keys/${userHuid}`, {
      method: "POST",
      headers: { ...commonHeaders(webOrigin), Authorization: `Bearer ${etsAuthToken}`, "Content-Type": "application/json" },
      body: kdcSignBody,
    }),
    fetch(`${etsBaseUrl}/api/v1/kdc/start`, { headers: { ...commonHeaders(webOrigin) } }),
  ]);

  if (!kdcSignRes.ok) {
    const kdcErrText = await kdcSignRes.text().catch(() => "");
    log(`  Warning: CTS KDC signing key registration failed (${kdcSignRes.status}): ${kdcErrText.slice(0, 200)}`);
  } else {
    const kdcSignData = await kdcSignRes.json().catch(() => null);
    log(`  Signing key registered in CTS: ${apigwSigningKey.keyId}` + (kdcSignData ? " " + JSON.stringify(kdcSignData).slice(0, 200) : ""));
  }

  if (!etsKdcSignRes.ok) {
    const etsErrText = await etsKdcSignRes.text().catch(() => "");
    log(`  Warning: ETS KDC signing key registration failed (${etsKdcSignRes.status}): ${etsErrText.slice(0, 200)}`);
  } else {
    const etsSignData = await etsKdcSignRes.json().catch(() => null);
    log(`  Signing key registered in ETS: ${apigwSigningKey.keyId}` + (etsSignData ? " " + JSON.stringify(etsSignData).slice(0, 200) : ""));
  }

  let serverPublicKey = new Uint8Array(0);
  let serverPublicKeyId = "";

  if (etsKdcStartRes.ok) {
    const kdcStartText = await etsKdcStartRes.text();
    if (process.env.EXPRESS_DEBUG) log(`  [DEBUG] ETS KDC start response: ${kdcStartText.slice(0, 500)}`);
    try {
      const kdcStartData = JSON.parse(kdcStartText) as { result?: string; status?: string };
      const keyBody = kdcStartData.result ?? kdcStartText;
      serverPublicKey = new Uint8Array(Buffer.from(keyBody, "base64"));
      serverPublicKeyId = "kdc-start-ets";
      const rawB64 = Buffer.from(serverPublicKey).toString("base64");
      log(`  ETS server public key from /kdc/start: ${rawB64} (curve25519, used directly)`);
    } catch {
      try { serverPublicKey = new Uint8Array(Buffer.from(kdcStartText, "base64")); } catch {}
    }
  }

  if (!serverPublicKey.length) {
    if (process.env.EXPRESS_DEBUG && !etsKdcStartRes.ok) {
      log(`  [DEBUG] ETS KDC start status: ${etsKdcStartRes.status}`);
    }
    throw new Error("Could not fetch server public key from ETS /kdc/start");
  }

  if (rtsPrivateKey) {
    const rtsPubKeyB64 = Buffer.from(nacl.box.keyPair.fromSecretKey(rtsPrivateKey).publicKey).toString("base64");
    const rtsKeyBody = JSON.stringify({ key: rtsPubKeyB64, kind: "rts", algo: "xsalsa20", id: rtsPublicKeyId });
    const [ctsRtsRes, etsRtsRes] = await Promise.all([
      fetch(kdcSignUrl, {
        method: "POST",
        headers: { ...commonHeaders(webOrigin), Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: rtsKeyBody,
      }),
      fetch(`${etsBaseUrl}/api/v2/kdc/keys/${userHuid}`, {
        method: "POST",
        headers: { ...commonHeaders(webOrigin), Authorization: `Bearer ${etsAuthToken}`, "Content-Type": "application/json" },
        body: rtsKeyBody,
      }),
    ]);
    if (!ctsRtsRes.ok) {
      const errText = await ctsRtsRes.text().catch(() => "");
      log(`  Warning: CTS RTS key registration failed (${ctsRtsRes.status}): ${errText.slice(0, 200)}`);
    } else {
      log(`  RTS key registered in CTS: ${rtsPublicKeyId}`);
    }
    if (!etsRtsRes.ok) {
      const errText = await etsRtsRes.text().catch(() => "");
      log(`  Warning: ETS RTS key registration failed (${etsRtsRes.status}): ${errText.slice(0, 200)}`);
    } else {
      log(`  RTS key registered in ETS: ${rtsPublicKeyId}`);
    }
  }

  if (!rtsPrivateKey) {
    const fallbackKeyPair = nacl.box.keyPair();
    rtsPrivateKey = fallbackKeyPair.secretKey;
    rtsPublicKeyId = crypto.randomUUID();

    const encPubB64 = Buffer.from(fallbackKeyPair.publicKey).toString("base64");
    const rtsFallbackBody = JSON.stringify({ key: encPubB64, kind: "rts", algo: "xsalsa20", id: rtsPublicKeyId });
    const [ctsEncRes, etsEncRes] = await Promise.all([
      fetch(kdcSignUrl, {
        method: "POST",
        headers: { ...commonHeaders(webOrigin), Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: rtsFallbackBody,
      }),
      fetch(`${etsBaseUrl}/api/v2/kdc/keys/${userHuid}`, {
        method: "POST",
        headers: { ...commonHeaders(webOrigin), Authorization: `Bearer ${etsAuthToken}`, "Content-Type": "application/json" },
        body: rtsFallbackBody,
      }),
    ]);

    if (!ctsEncRes.ok) {
      const errText = await ctsEncRes.text().catch(() => "");
      log(`  Warning: CTS fallback RTS key registration failed (${ctsEncRes.status}): ${errText.slice(0, 200)}`);
    } else {
      log(`  Fallback encryption key registered in CTS: ${rtsPublicKeyId}`);
    }
    if (!etsEncRes.ok) {
      const errText = await etsEncRes.text().catch(() => "");
      log(`  Warning: ETS fallback RTS key registration failed (${etsEncRes.status}): ${errText.slice(0, 200)}`);
    } else {
      log(`  Fallback encryption key registered in ETS: ${rtsPublicKeyId}`);
    }
  }

  const rtsPublicKey = nacl.box.keyPair.fromSecretKey(rtsPrivateKey).publicKey;

  let rtsAuthToken = "";
  if (encryptedRtsToken && rtsPrivateKey && serverPublicKey.length) {
    try {
      rtsAuthToken = decryptRtsToken(encryptedRtsToken, serverPublicKey, rtsPrivateKey);
      setRtsAuthToken(rtsAuthToken);
      if (process.env.EXPRESS_DEBUG) log(`  [DEBUG] Decrypted RTS auth token: ${rtsAuthToken.slice(0, 60)}...`);
      log(`  RTS auth token decrypted from encrypted_rts_token`);
    } catch (err) {
      log(`  Warning: could not decrypt encrypted_rts_token: ${(err as Error).message}`);
    }
  }

  const rtsIdFromToken = extractRtsKeyIdFromToken(accessToken);
  if (rtsIdFromToken && process.env.EXPRESS_DEBUG) log(`  [DEBUG] rts_id from CTS token: ${rtsIdFromToken}`);

  const existingCts = loadApigwKeys()?.ctsKey;
  let ctsKey: ApigwKeys["ctsKey"];

  if (qrCtsPrivateKey && qrCtsKeyId) {
    ctsKey = {
      keyId: qrCtsKeyId,
      privateKey: qrCtsPrivateKey,
      publicKey: nacl.box.keyPair.fromSecretKey(qrCtsPrivateKey).publicKey,
    };
    log(`  Using CTS key from QR handshake: ${qrCtsKeyId.slice(0, 8)}... (shared account key)`);
  } else if (existingCts) {
    ctsKey = existingCts;
    log(`  Reusing existing CTS key: ${existingCts.keyId.slice(0, 8)}... (not re-registering)`);
  } else {
    const currentCts = await fetchCurrentAccountCtsKey(getBaseUrl(config), accessToken, userHuid, webOrigin);
    if (currentCts) {
      throw new Error(
        `Account already has a shared CTS key (${currentCts}) that this CLI doesn't hold.\n` +
        `Minting a new one would break your other devices (they can't fetch its private key).\n` +
        `Instead, extract the key from a logged-in web client (IndexedDB authState → encryptionKeys → user.privateKeys.cts) and run:\n` +
        `  express-cli auth import-cts <private_key_b64> ${currentCts}\n` +
        `Then re-run login, or just use 'auth refresh' for tokens.`,
      );
    }
    log("  No existing account CTS key found — minting a new one (first device).");
    const ctsKeyPair = nacl.box.keyPair();
    const ctsKeyId = crypto.randomUUID();
    const ctsKeyPubB64 = Buffer.from(ctsKeyPair.publicKey).toString("base64");
    const ctsKeyBody = JSON.stringify({ key: ctsKeyPubB64, kind: "cts", algo: "xsalsa20", id: ctsKeyId });

    const ctsCtsKeyRes = await fetch(kdcSignUrl, {
      method: "POST",
      headers: { ...commonHeaders(webOrigin), Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: ctsKeyBody,
    });

    if (!ctsCtsKeyRes.ok) {
      const errText = await ctsCtsKeyRes.text().catch(() => "");
      log(`  Warning: CTS encryption key registration failed (${ctsCtsKeyRes.status}): ${errText.slice(0, 200)}`);
    } else {
      log(`  CTS encryption key registered: ${ctsKeyId.slice(0, 8)}...`);
    }

    ctsKey = {
      keyId: ctsKeyId,
      privateKey: ctsKeyPair.secretKey,
      publicKey: ctsKeyPair.publicKey,
    };
  }

  const apigwKeys: ApigwKeys = {
    signingKey: apigwSigningKey,
    encryptionKey: {
      keyId: rtsPublicKeyId,
      privateKey: rtsPrivateKey,
      publicKey: rtsPublicKey,
    },
    ctsKey,
    serverPublicKey,
    serverPublicKeyId,
  };
  saveApigwKeys(apigwKeys);

  log("\nStep 6: Activating apigw via ETS...");

  const activationUrl = `${etsBaseUrl}/api/v1/apigw/api/v1/authentication/activation`;
  const activationBody = JSON.stringify({
    app_version: config.app_version,
    locale: config.locale,
    device_meta: {
      pushes: false,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      permissions: { notifications: false },
    },
    device_hostname: null,
  });

  const activationHeaders = await signApigwRequest({
    method: "PUT",
    url: activationUrl,
    baseUrl: etsBaseUrl,
    body: activationBody,
    ctsToken: accessToken,
    rtsToken: rtsAuthToken || undefined,
    etsAuthToken: etsAuthToken || undefined,
  });

  const activationRes = await fetch(activationUrl, {
    method: "PUT",
    headers: { ...commonHeaders(webOrigin), ...activationHeaders },
    body: activationBody,
  });

  if (!activationRes.ok) {
    const actErrText = await activationRes.text().catch(() => "");
    log(`  Warning: apigw activation failed (${activationRes.status}): ${actErrText.slice(0, 200)}`);
  } else {
    log("  Apigw activated.");
  }

  log(`\n  User HUID: ${userHuid || "unknown"}`);
  log(`  Signing key: ${apigwSigningKey.keyId.slice(0, 8)}...`);
  log(`  Encryption key: ${rtsPublicKeyId.slice(0, 8)}...`);
  log(`  Server key: ${serverPublicKeyId.slice(0, 8)}...`);

  log("\nQR login complete! You are now authenticated.");
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

export async function qrLogin(cliOverrides: Partial<Config> = {}): Promise<void> {
  const mat = buildQrMaterial(cliOverrides);

  console.log("Step 1/6: Scan this QR code with your eXpress app:\n");
  qrcode.generate(mat.qrPayload, { small: true }, (qr: string) => {
    console.log(qr);
  });
  console.log(`\n  registration_id: ${mat.registrationId}`);
  console.log("  Waiting for scan (server long-polling)...\n");
  openQrInBrowser(mat.qrPayload, mat.registrationId).catch(() => {});

  const pollResult = await pollForQrScan(mat);
  await completeQrRegistration(mat, pollResult);
}
