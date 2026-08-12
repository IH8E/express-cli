import { generateSigningKeyPair, publicKeyToBase64, saveApigwKeys, loadApigwKeys, decryptRegistrationData, decryptRtsToken, extractRtsKeyIdFromToken, type ApigwKeys } from "./keys.js";
import { signQrRequest, signApigwRequest } from "./apigw-signer.js";
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

export async function qrLogin(cliOverrides: Partial<Config> = {}): Promise<void> {
  const config = loadConfig(cliOverrides);
  const etsBaseUrl = getEtsBaseUrl(config);
  const webOrigin = getWebOrigin(config);

  const qrSigningKey = generateSigningKeyPair();
  const registrationId = qrSigningKey.keyId;
  const registrationToken = Buffer.from(randomBytes(64)).toString("base64");
  const signPubKey = publicKeyToBase64(qrSigningKey.publicKey);
  const udid = randomUUID();
  const encryptionKey = randomBytes(32);

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

  const qrPayload = JSON.stringify({
    registration_id: registrationId,
    registration_token: registrationToken,
    registration_key: Buffer.from(encryptionKey).toString("base64"),
    version: 1,
  });

  console.log("Step 1/7: Scan this QR code with your eXpress app:\n");
  qrcode.generate(qrPayload, { small: true }, (qr: string) => {
    console.log(qr);
  });
  console.log(`\n  registration_id: ${registrationId}`);
  console.log("  Waiting for scan (server long-polling)...\n");

  const etsUrl = `${etsBaseUrl}/api/v1/authentication/qr/mobile_to_web/request`;
  const qrHeaders = signQrRequest({
    method: "POST",
    url: etsUrl,
    body: qrBody,
    registrationId,
    privateKey: qrSigningKey.privateKey,
  });

  let qrRes: Response;
  try {
    qrRes = await fetch(etsUrl, {
      method: "POST",
      headers: { ...commonHeaders(webOrigin), ...qrHeaders },
      body: qrBody,
    });
  } catch (err) {
    throw new Error(`QR request network error: ${(err as Error).message}`);
  }

  const qrText = await qrRes.text();

  if (!qrRes.ok) {
    console.log(`  Response (${qrRes.status}): ${qrText.slice(0, 500)}`);
    throw new Error(`QR request failed (${qrRes.status}): ${qrText.slice(0, 500)}`);
  }

  let qrData: QrRequestResponse;
  try {
    qrData = JSON.parse(qrText) as QrRequestResponse;
  } catch {
    throw new Error(`Invalid QR response: ${qrText.slice(0, 500)}`);
  }

  if (process.env.EXPRESS_DEBUG) {
    console.log(`  [DEBUG] QR full response: ${qrText.slice(0, 1000)}`);
  }

  const qrResult = extractResult(qrData);
  const ctsRegistrationToken = qrResult.cts_registration_token ?? "";
  const rtsRegistrationToken = qrResult.rts_registration_token ?? "";
  const registrationData = qrResult.registration_data ?? "";

  console.log("  QR scanned! Got tokens from server.");
  if (process.env.EXPRESS_DEBUG) {
    console.log(`  [DEBUG] registration_data length: ${registrationData.length}`);
    console.log(`  [DEBUG] registration_data raw: ${registrationData.slice(0, 100)}...`);
    console.log(`  [DEBUG] encryptionKey (registration_key) hex: ${Buffer.from(encryptionKey).toString("hex")}`);
  }

  if (!ctsRegistrationToken && !rtsRegistrationToken) {
    throw new Error(`No tokens in QR response: ${qrText.slice(0, 500)}`);
  }

  let rtsPrivateKey: Uint8Array | null = null;
  let rtsPublicKeyId = "";
  // CTS (E2E) key transferred from the phone via the QR handshake — this is the
  // shared account key, so QR login alone yields a working E2E key (no import).
  let qrCtsPrivateKey: Uint8Array | null = null;
  let qrCtsKeyId = "";

  if (registrationData) {
    try {
      const raw = Uint8Array.from(Buffer.from(registrationData, "base64"));
      if (process.env.EXPRESS_DEBUG) {
        console.log(`  [DEBUG] registration_data decoded length: ${raw.length}`);
        console.log(`  [DEBUG] first 40 bytes hex: ${Buffer.from(raw.slice(0, 40)).toString("hex")}`);
        console.log(`  [DEBUG] encryptionKey hex: ${Buffer.from(encryptionKey).toString("hex")}`);
        console.log(`  [DEBUG] encryptionKey length: ${encryptionKey.length}`);
      }
      const decrypted = decryptRegistrationData(registrationData, encryptionKey);
      if (process.env.EXPRESS_DEBUG) {
        console.log("  Decrypted registration_data:", JSON.stringify(decrypted).slice(0, 500));
      }

      if (decrypted && typeof decrypted === "object") {
        const data = decrypted as Record<string, unknown>;
        if (typeof data.rts_priv_key_body === "string") {
          rtsPrivateKey = new Uint8Array(Buffer.from(data.rts_priv_key_body as string, "base64"));
        }
        if (typeof data.rts_pub_key_id === "string") {
          rtsPublicKeyId = data.rts_pub_key_id as string;
        }
        // CTS/E2E key from the phone — key_id matches the account's current cts key
        if (typeof data.cts_priv_key_body === "string" && typeof data.cts_pub_key_id === "string") {
          qrCtsPrivateKey = new Uint8Array(Buffer.from(data.cts_priv_key_body as string, "base64"));
          qrCtsKeyId = data.cts_pub_key_id as string;
        }
      }
    } catch (err) {
      console.log(`  Warning: could not decrypt registration_data: ${(err as Error).message}`);
    }
  }

  console.log("\nStep 2/7: Confirming with ETS...");

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

  if (!confirmRes.ok) {
    throw new Error(`ETS register_confirm failed (${confirmRes.status}): ${confirmText.slice(0, 500)}`);
  }

  const confirmData = extractResult(JSON.parse(confirmText) as RegisterConfirmResponse);
  const userHuid = confirmData.user_huid ?? "";
  const etsAuthToken = confirmData.auth_token ?? "";

  console.log(`  ETS confirmed. User: ${userHuid || "unknown"}`);
  if (etsAuthToken) {
    setEtsAuthToken(etsAuthToken);
    if (process.env.EXPRESS_DEBUG) {
      console.log(`  [DEBUG] ETS auth_token saved (${etsAuthToken.length} chars)`);
    }
  }

  if (!ctsRegistrationToken) {
    throw new Error("No cts_registration_token — cannot confirm with CTS");
  }

  console.log("\nStep 3/7: Confirming with CTS (AD integration)...");

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

  if (!adRes.ok) {
    throw new Error(`AD integration confirm failed (${adRes.status}): ${adText.slice(0, 500)}`);
  }

  const adData = extractResult(JSON.parse(adText) as AdIntegrationConfirmResponse);
  const accessToken = adData.access_token;
  const refreshToken = adData.refresh_token;
  const expiresIn = adData.expires_in;
  const serverId = adData.server_id ?? userHuid;
  const encryptedRtsToken = (adData as Record<string, unknown>).encrypted_rts_token as string | undefined;

  if (process.env.EXPRESS_DEBUG) {
    const adDataRaw = JSON.parse(adText);
    console.log(`  [DEBUG] AD confirm full result keys: ${JSON.stringify(Object.keys(adDataRaw.result || adDataRaw))}`);
    if (encryptedRtsToken) {
      console.log(`  [DEBUG] encrypted_rts_token found: ${encryptedRtsToken.slice(0, 60)}...`);
    } else {
      console.log(`  [DEBUG] encrypted_rts_token NOT found in response`);
    }
  }

  if (!accessToken) {
    throw new Error(`No access_token in AD confirm response: ${adText.slice(0, 500)}`);
  }

  setAuthToken(accessToken);
  if (refreshToken) {
    setRefreshToken(refreshToken);
  }
  if (typeof expiresIn === "number") {
    setTokenExpiresAt(calcTokenExpiresAt(expiresIn));
    console.log(`  Token expires in ${expiresIn}s (refresh after ${(expiresIn / 2 / 60).toFixed(0)} min)`);
  }

  console.log(`  CTS confirmed. Access token: ${accessToken.slice(0, 40)}...`);

  console.log("\nStep 4/7: Registering device token...");

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
    headers: {
      ...commonHeaders(webOrigin),
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: tokenBody,
  });

  if (!tokenRes.ok) {
    const tokenErrText = await tokenRes.text().catch(() => "");
    console.log(`  Warning: device token registration failed (${tokenRes.status}): ${tokenErrText.slice(0, 200)}`);
  } else {
    console.log("  Device token registered.");
  }

  console.log("\nStep 5/7: Registering signing key + fetching server key...");

  if (process.env.EXPRESS_DEBUG) {
    console.log(`  [DEBUG] serverId: ${serverId}`);
    console.log(`  [DEBUG] userHuid: ${userHuid}`);
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
      headers: {
        ...commonHeaders(webOrigin),
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: kdcSignBody,
    }),
    fetch(`${etsBaseUrl}/api/v2/kdc/keys/${userHuid}`, {
      method: "POST",
      headers: {
        ...commonHeaders(webOrigin),
        Authorization: `Bearer ${etsAuthToken}`,
        "Content-Type": "application/json",
      },
      body: kdcSignBody,
    }),
    fetch(`${etsBaseUrl}/api/v1/kdc/start`, {
      headers: {
        ...commonHeaders(webOrigin),
      },
    }),
  ]);

  if (!kdcSignRes.ok) {
    const kdcErrText = await kdcSignRes.text().catch(() => "");
    console.log(`  Warning: CTS KDC signing key registration failed (${kdcSignRes.status}): ${kdcErrText.slice(0, 200)}`);
  } else {
    const kdcSignData = await kdcSignRes.json().catch(() => null);
    console.log(`  Signing key registered in CTS: ${apigwSigningKey.keyId}`, kdcSignData ? JSON.stringify(kdcSignData).slice(0, 200) : "");
  }

  if (!etsKdcSignRes.ok) {
    const etsErrText = await etsKdcSignRes.text().catch(() => "");
    console.log(`  Warning: ETS KDC signing key registration failed (${etsKdcSignRes.status}): ${etsErrText.slice(0, 200)}`);
  } else {
    const etsSignData = await etsKdcSignRes.json().catch(() => null);
    console.log(`  Signing key registered in ETS: ${apigwSigningKey.keyId}`, etsSignData ? JSON.stringify(etsSignData).slice(0, 200) : "");
  }

  let serverPublicKey = new Uint8Array(0);
  let serverPublicKeyId = "";

  if (etsKdcStartRes.ok) {
    const kdcStartText = await etsKdcStartRes.text();
    if (process.env.EXPRESS_DEBUG) {
      console.log(`  [DEBUG] ETS KDC start response: ${kdcStartText.slice(0, 500)}`);
    }
    try {
      const kdcStartData = JSON.parse(kdcStartText) as { result?: string; status?: string };
      const keyBody = kdcStartData.result ?? kdcStartText;
      serverPublicKey = new Uint8Array(Buffer.from(keyBody, "base64"));
      serverPublicKeyId = "kdc-start-ets";
      const rawB64 = Buffer.from(serverPublicKey).toString("base64");
      console.log(`  ETS server public key from /kdc/start: ${rawB64} (curve25519, used directly)`);
    } catch {
      try { serverPublicKey = new Uint8Array(Buffer.from(kdcStartText, "base64")); } catch {}
    }
  }

  if (!serverPublicKey.length) {
    if (process.env.EXPRESS_DEBUG && !etsKdcStartRes.ok) {
      console.log(`  [DEBUG] ETS KDC start status: ${etsKdcStartRes.status}`);
      try { console.log(`  [DEBUG] ETS KDC start body: ${(await etsKdcStartRes.text()).slice(0, 500)}`); } catch {}
    }
    throw new Error("Could not fetch server public key from ETS /kdc/start");
  }

  if (rtsPrivateKey) {
    const rtsPubKeyB64 = Buffer.from(nacl.box.keyPair.fromSecretKey(rtsPrivateKey).publicKey).toString("base64");
    const rtsKeyBody = JSON.stringify({ key: rtsPubKeyB64, kind: "rts", algo: "xsalsa20", id: rtsPublicKeyId });
    const [ctsRtsRes, etsRtsRes] = await Promise.all([
      fetch(kdcSignUrl, {
        method: "POST",
        headers: {
          ...commonHeaders(webOrigin),
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: rtsKeyBody,
      }),
      fetch(`${etsBaseUrl}/api/v2/kdc/keys/${userHuid}`, {
        method: "POST",
        headers: {
          ...commonHeaders(webOrigin),
          Authorization: `Bearer ${etsAuthToken}`,
          "Content-Type": "application/json",
        },
        body: rtsKeyBody,
      }),
    ]);
    if (!ctsRtsRes.ok) {
      const errText = await ctsRtsRes.text().catch(() => "");
      console.log(`  Warning: CTS RTS key registration failed (${ctsRtsRes.status}): ${errText.slice(0, 200)}`);
    } else {
      console.log(`  RTS key registered in CTS: ${rtsPublicKeyId}`);
    }
    if (!etsRtsRes.ok) {
      const errText = await etsRtsRes.text().catch(() => "");
      console.log(`  Warning: ETS RTS key registration failed (${etsRtsRes.status}): ${errText.slice(0, 200)}`);
    } else {
      console.log(`  RTS key registered in ETS: ${rtsPublicKeyId}`);
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
        headers: {
          ...commonHeaders(webOrigin),
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: rtsFallbackBody,
      }),
      fetch(`${etsBaseUrl}/api/v2/kdc/keys/${userHuid}`, {
        method: "POST",
        headers: {
          ...commonHeaders(webOrigin),
          Authorization: `Bearer ${etsAuthToken}`,
          "Content-Type": "application/json",
        },
        body: rtsFallbackBody,
      }),
    ]);

    if (!ctsEncRes.ok) {
      const errText = await ctsEncRes.text().catch(() => "");
      console.log(`  Warning: CTS fallback RTS key registration failed (${ctsEncRes.status}): ${errText.slice(0, 200)}`);
    } else {
      console.log(`  Fallback encryption key registered in CTS: ${rtsPublicKeyId}`);
    }
    if (!etsEncRes.ok) {
      const errText = await etsEncRes.text().catch(() => "");
      console.log(`  Warning: ETS fallback RTS key registration failed (${etsEncRes.status}): ${errText.slice(0, 200)}`);
    } else {
      console.log(`  Fallback encryption key registered in ETS: ${rtsPublicKeyId}`);
    }
  }

  const rtsPublicKey = nacl.box.keyPair.fromSecretKey(rtsPrivateKey).publicKey;

  let rtsAuthToken = "";
  if (encryptedRtsToken && rtsPrivateKey && serverPublicKey.length) {
    try {
      rtsAuthToken = decryptRtsToken(encryptedRtsToken, serverPublicKey, rtsPrivateKey);
      setRtsAuthToken(rtsAuthToken);
      if (process.env.EXPRESS_DEBUG) {
        console.log(`  [DEBUG] Decrypted RTS auth token: ${rtsAuthToken.slice(0, 60)}...`);
      }
      console.log(`  RTS auth token decrypted from encrypted_rts_token`);
    } catch (err) {
      console.log(`  Warning: could not decrypt encrypted_rts_token: ${(err as Error).message}`);
    }
  }

  const rtsIdFromToken = extractRtsKeyIdFromToken(accessToken);
  if (rtsIdFromToken && process.env.EXPRESS_DEBUG) {
    console.log(`  [DEBUG] rts_id from CTS token: ${rtsIdFromToken}`);
  }

  // CTS encryption key for E2E messages. eXpress keeps ONE active cts key per
  // user (shared across devices via the QR handshake / key backup). Priority:
  //  1. the cts key the phone sent through registration_data (the shared account
  //     key) — this makes QR login self-sufficient, no import needed;
  //  2. the stored ctsKey (already-shared key from a prior import/login);
  //  3. mint a new one — only when the account genuinely has no cts key yet.
  const existingCts = loadApigwKeys()?.ctsKey;
  let ctsKey: ApigwKeys["ctsKey"];

  if (qrCtsPrivateKey && qrCtsKeyId) {
    ctsKey = {
      keyId: qrCtsKeyId,
      privateKey: qrCtsPrivateKey,
      publicKey: nacl.box.keyPair.fromSecretKey(qrCtsPrivateKey).publicKey,
    };
    console.log(`  Using CTS key from QR handshake: ${qrCtsKeyId.slice(0, 8)}... (shared account key)`);
  } else if (existingCts) {
    ctsKey = existingCts;
    console.log(`  Reusing existing CTS key: ${existingCts.keyId.slice(0, 8)}... (not re-registering)`);
  } else {
    // Guard: if the account already has a current cts key in KDC, DO NOT mint a
    // new one — it would supersede the shared key and, since the CLI can't upload
    // the private-key backup, permanently break your phone/desktop/web.
    const currentCts = await fetchCurrentAccountCtsKey(getBaseUrl(config), accessToken, userHuid, webOrigin);
    if (currentCts) {
      throw new Error(
        `Account already has a shared CTS key (${currentCts}) that this CLI doesn't hold.\n` +
        `Minting a new one would break your other devices (they can't fetch its private key).\n` +
        `Instead, extract the key from a logged-in web client (IndexedDB authState → encryptionKeys → user.privateKeys.cts) and run:\n` +
        `  express auth import-cts <private_key_b64> ${currentCts}\n` +
        `Then re-run login, or just use 'auth refresh' for tokens.`,
      );
    }
    console.log("  No existing account CTS key found — minting a new one (first device).");
    const ctsKeyPair = nacl.box.keyPair();
    const ctsKeyId = crypto.randomUUID();
    const ctsKeyPubB64 = Buffer.from(ctsKeyPair.publicKey).toString("base64");
    const ctsKeyBody = JSON.stringify({ key: ctsKeyPubB64, kind: "cts", algo: "xsalsa20", id: ctsKeyId });

    const ctsCtsKeyRes = await fetch(kdcSignUrl, {
      method: "POST",
      headers: {
        ...commonHeaders(webOrigin),
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: ctsKeyBody,
    });

    if (!ctsCtsKeyRes.ok) {
      const errText = await ctsCtsKeyRes.text().catch(() => "");
      console.log(`  Warning: CTS encryption key registration failed (${ctsCtsKeyRes.status}): ${errText.slice(0, 200)}`);
    } else {
      console.log(`  CTS encryption key registered: ${ctsKeyId.slice(0, 8)}...`);
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

  console.log("\nStep 6/7: Activating apigw via ETS...");

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
    console.log(`  Warning: apigw activation failed (${activationRes.status}): ${actErrText.slice(0, 200)}`);
  } else {
    console.log("  Apigw activated.");
  }

  console.log(`\n  User HUID: ${userHuid || "unknown"}`);
  console.log(`  Signing key: ${apigwSigningKey.keyId.slice(0, 8)}...`);
  console.log(`  Encryption key: ${rtsPublicKeyId.slice(0, 8)}...`);
  console.log(`  Server key: ${serverPublicKeyId.slice(0, 8)}...`);

  console.log("\nQR login complete! You are now authenticated.");
}
