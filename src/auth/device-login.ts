import { generateSigningKeyPair, generateEncryptionKeyPair, loadApigwKeys, saveApigwKeys, clearApigwKeys, publicKeyToBase64, type ApigwKeys, type SigningKeyPair, type EncryptionKeyPair } from "./keys.js";
import { signApigwRequest } from "./apigw-signer.js";
import { setAuthToken, getAuthToken, getApigwKeysRaw, setApigwKeysRaw } from "../config/store.js";
import { loadConfig, getBaseUrl, getEtsBaseUrl, getWebOrigin } from "../config/loader.js";
import type { Config } from "../types/index.js";
import nacl from "tweetnacl";
import { randomUUID } from "node:crypto";

/** Returns the account's current cts key_id in KDC, or null if none exists. */
async function fetchCurrentAccountCtsKey(baseUrl: string, token: string, userHuid: string, webOrigin: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/kdc/keys/?user_huids=${userHuid}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, Origin: webOrigin },
    });
    if (!res.ok) return null;
    const data = await res.json() as { result?: Array<{ id: string; kind: string }> };
    return data.result?.find((k) => k.kind === "cts")?.id ?? null;
  } catch {
    return null;
  }
}

interface ActivationResponse {
  result?: {
    access_token?: string;
    refresh_token?: string;
    user_huid?: string;
  };
  access_token?: string;
  refresh_token?: string;
  user_huid?: string;
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

export async function deviceLogin(cliOverrides: Partial<Config> = {}): Promise<void> {
  const config = loadConfig(cliOverrides);
  const baseUrl = getBaseUrl(config);
  const etsBaseUrl = getEtsBaseUrl(config);
  const webOrigin = getWebOrigin(config);
  const currentToken = config.token ?? getAuthToken();

  if (!currentToken) {
    throw new Error("No Bearer token. Run 'express auth import <token>' first, then 'express auth login'.");
  }

  console.log("Step 1/5: Registering device with AD integration...");

  const adBody = JSON.stringify({
    app_version: config.app_version,
    device: "Chrome 149.0",
    device_software: "macOS 10.15.7",
    manufacturer: "Google",
    platform: config.platform,
    locale: config.locale,
    platform_package_id: config.platform_package_id,
    device_meta: {
      pushes: false,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      permissions: { notifications: true },
    },
    device_hostname: null,
  });

  const adRes = await fetch(`${baseUrl}/api/v1/ad_integration/token`, {
    method: "PUT",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${currentToken}`,
      "Origin": webOrigin,
      "Referer": `${webOrigin}/`,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
    },
    body: adBody,
  });

  const adText = await adRes.text();

  if (!adRes.ok) {
    throw new Error(`AD integration failed (${adRes.status}): ${adText.slice(0, 500)}`);
  }

  console.log(`  AD integration: ${adText.slice(0, 200)}`);

  console.log("Step 2/5: Fetching user profile and server public key...");

  const selfProfileRes = await fetch(`${baseUrl}/api/v1/phonebook/profiles/self`, {
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Authorization": `Bearer ${currentToken}`,
      "Origin": webOrigin,
      "Referer": `${webOrigin}/`,
    },
  });
  let userHuid = "";
  let serverId = "";
  if (selfProfileRes.ok) {
    const selfData = await selfProfileRes.json() as { profile?: { user_huid?: string; server_id?: string } };
    userHuid = selfData.profile?.user_huid ?? "";
    serverId = selfData.profile?.server_id ?? userHuid;
    console.log(`  User HUID: ${userHuid || "unknown"}`);
  }

  let serverPublicKey = new Uint8Array(0);
  let serverPublicKeyId = "";

  const existingKeys = loadApigwKeys();
  if (existingKeys?.serverPublicKey?.length) {
    serverPublicKey = existingKeys.serverPublicKey;
    serverPublicKeyId = existingKeys.serverPublicKeyId;
    console.log(`  Server public key (cached): ${serverPublicKeyId || "unknown"}`);
  }

  if (!serverPublicKey.length) {
    try {
      const kdcStartRes = await fetch(`${etsBaseUrl}/api/v1/kdc/start`, {
        headers: { Accept: "application/json" },
      });
      if (kdcStartRes.ok) {
        const kdcStartData = await kdcStartRes.json() as { result?: string };
        if (kdcStartData.result) {
          serverPublicKey = new Uint8Array(Buffer.from(kdcStartData.result, "base64"));
          serverPublicKeyId = "kdc-start-ets";
          console.log(`  Server public key (from ets): ${serverPublicKeyId}`);
        }
      }
    } catch {}
  }

  if (!serverPublicKey.length && serverId) {
    const kdcFetchUrl = `${baseUrl}/api/v1/kdc/keys/?ids=${serverId}`;
    const kdcFetchRes = await fetch(kdcFetchUrl, {
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${currentToken}`,
      },
    });

    if (kdcFetchRes.ok) {
      const kdcFetchData = JSON.parse(await kdcFetchRes.text()) as KdcKeysResponse;
      const kdcKeys = kdcFetchData.result ?? kdcFetchData as unknown as Array<{ id: string; body: string; kind: string; user_huid: string }>;
      const serverKey = Array.isArray(kdcKeys)
        ? kdcKeys.find((k) => (k.kind === "rest" || k.kind === "rts") && k.user_huid === serverId)
        : null;
      if (!serverKey && Array.isArray(kdcKeys) && kdcKeys.length > 0) {
        const first = kdcKeys[0];
        serverPublicKey = new Uint8Array(Buffer.from(first.body, "base64"));
        serverPublicKeyId = first.id;
      } else if (serverKey) {
        serverPublicKey = new Uint8Array(Buffer.from(serverKey.body, "base64"));
        serverPublicKeyId = serverKey.id;
      }
      console.log(`  Server public key (from KDC): ${serverPublicKeyId || "not found"}`);
    }
  }

  if (!serverPublicKey.length) {
    throw new Error("Could not fetch server public key from KDC");
  }

  console.log("Step 3/5: Registering keys with KDC...");

  let apigwSigningKey: SigningKeyPair;
  let apigwEncryptionKey: EncryptionKeyPair;

  if (existingKeys?.signingKey && existingKeys?.encryptionKey) {
    apigwSigningKey = existingKeys.signingKey;
    apigwEncryptionKey = existingKeys.encryptionKey;
    console.log(`  Reusing existing signing key: ${apigwSigningKey.keyId}`);
    console.log(`  Reusing existing encryption key: ${apigwEncryptionKey.keyId}`);
  } else {
    apigwSigningKey = generateSigningKeyPair();
    apigwEncryptionKey = generateEncryptionKeyPair();

    const apigwKeyPublicBase64 = publicKeyToBase64(apigwSigningKey.publicKey);
    console.log(`  Signing key: id=${apigwSigningKey.keyId} pub=${apigwKeyPublicBase64}`);

    const kdcUrl = `${baseUrl}/api/v2/kdc/keys/${userHuid}`;
    const kdcBody = JSON.stringify({
      key: apigwKeyPublicBase64,
      kind: "ed25519",
      algo: "ed25519",
      id: apigwSigningKey.keyId,
    });

    const [kdcRes, etsKdcRes] = await Promise.all([
      fetch(kdcUrl, {
        method: "POST",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Authorization": `Bearer ${currentToken}`,
          "Content-Type": "application/json",
          "Origin": webOrigin,
          "Referer": `${webOrigin}/`,
        },
        body: kdcBody,
      }),
      fetch(`${etsBaseUrl}/api/v2/kdc/keys/${userHuid}`, {
        method: "POST",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Authorization": `Bearer ${currentToken}`,
          "Content-Type": "application/json",
          "Origin": webOrigin,
          "Referer": `${webOrigin}/`,
        },
        body: kdcBody,
      }),
    ]);

    if (!kdcRes.ok) {
      const kdcErrText = await kdcRes.text().catch(() => "");
      console.log(`  Warning: CTS KDC signing key registration failed (${kdcRes.status}): ${kdcErrText.slice(0, 200)}`);
    } else {
      console.log(`  Signing key registered in CTS: ${apigwSigningKey.keyId}`);
    }

    if (!etsKdcRes.ok) {
      const etsErrText = await etsKdcRes.text().catch(() => "");
      console.log(`  Warning: ETS KDC signing key registration failed (${etsKdcRes.status}): ${etsErrText.slice(0, 200)}`);
    } else {
      console.log(`  Signing key registered in ETS: ${apigwSigningKey.keyId}`);
    }

    const encryptionKeyPublicBase64 = publicKeyToBase64(apigwEncryptionKey.publicKey);

    const kdcEncBody = JSON.stringify({
      key: encryptionKeyPublicBase64,
      kind: "rts",
      algo: "xsalsa20",
      id: apigwEncryptionKey.keyId,
    });

    const kdcEncRes = await fetch(kdcUrl, {
      method: "POST",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Authorization": `Bearer ${currentToken}`,
        "Content-Type": "application/json",
        "Origin": webOrigin,
        "Referer": `${webOrigin}/`,
      },
      body: kdcEncBody,
    });

    const etsKdcEncRes = await fetch(`${etsBaseUrl}/api/v2/kdc/keys/${userHuid}`, {
      method: "POST",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Authorization": `Bearer ${currentToken}`,
        "Content-Type": "application/json",
        "Origin": webOrigin,
        "Referer": `${webOrigin}/`,
      },
      body: kdcEncBody,
    });

    if (!kdcEncRes.ok) {
      const kdcErrText = await kdcEncRes.text().catch(() => "");
      console.log(`  Warning: CTS KDC encryption key registration failed (${kdcEncRes.status}): ${kdcErrText.slice(0, 200)}`);
    } else {
      console.log(`  Encryption key registered in CTS: ${apigwEncryptionKey.keyId}`);
    }

    if (!etsKdcEncRes.ok) {
      const etsErrText = await etsKdcEncRes.text().catch(() => "");
      console.log(`  Warning: ETS KDC encryption key registration failed (${etsKdcEncRes.status}): ${etsErrText.slice(0, 200)}`);
    } else {
      console.log(`  Encryption key registered in ETS: ${apigwEncryptionKey.keyId}`);
    }
  }

  let ctsKey: EncryptionKeyPair | undefined = existingKeys?.ctsKey;
  if (!ctsKey) {
    // Guard: never mint a cts key if the account already has one in KDC — the CLI
    // can't upload the private-key backup, so a new key would break other devices.
    const currentCts = await fetchCurrentAccountCtsKey(baseUrl, currentToken, userHuid, webOrigin);
    if (currentCts) {
      throw new Error(
        `Account already has a shared CTS key (${currentCts}) that this CLI doesn't hold.\n` +
        `Minting a new one would break your other devices. Import the shared key instead:\n` +
        `  express auth import-cts <private_key_b64> ${currentCts}\n` +
        `(extract it from a logged-in web client: IndexedDB authState → encryptionKeys → user.privateKeys.cts)`,
      );
    }
    const ctsKeyPair = nacl.box.keyPair();
    const ctsKeyId = crypto.randomUUID();
    ctsKey = {
      keyId: ctsKeyId,
      privateKey: ctsKeyPair.secretKey,
      publicKey: ctsKeyPair.publicKey,
    };

    const ctsKeyPubB64 = Buffer.from(ctsKeyPair.publicKey).toString("base64");
    const ctsKeyBody = JSON.stringify({ key: ctsKeyPubB64, kind: "cts", algo: "xsalsa20", id: ctsKeyId });

    const [ctsCtsRes, etsCtsRes] = await Promise.all([
      fetch(`${baseUrl}/api/v2/kdc/keys/${userHuid}`, {
        method: "POST",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Authorization": `Bearer ${currentToken}`,
          "Content-Type": "application/json",
          "Origin": webOrigin,
          "Referer": `${webOrigin}/`,
        },
        body: ctsKeyBody,
      }),
      fetch(`${etsBaseUrl}/api/v2/kdc/keys/${userHuid}`, {
        method: "POST",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Authorization": `Bearer ${currentToken}`,
          "Content-Type": "application/json",
          "Origin": webOrigin,
          "Referer": `${webOrigin}/`,
        },
        body: ctsKeyBody,
      }),
    ]);

    if (!ctsCtsRes.ok) {
      const errText = await ctsCtsRes.text().catch(() => "");
      console.log(`  Warning: CTS encryption key registration failed (${ctsCtsRes.status}): ${errText.slice(0, 200)}`);
    } else {
      console.log(`  CTS encryption key registered in CTS: ${ctsKeyId.slice(0, 8)}...`);
    }
    if (!etsCtsRes.ok) {
      const errText = await etsCtsRes.text().catch(() => "");
      console.log(`  Warning: CTS encryption key registration in ETS failed (${etsCtsRes.status}): ${errText.slice(0, 200)}`);
    } else {
      console.log(`  CTS encryption key registered in ETS: ${ctsKeyId.slice(0, 8)}...`);
    }
  }

  const apigwKeys: ApigwKeys = {
    signingKey: apigwSigningKey,
    encryptionKey: apigwEncryptionKey,
    serverPublicKey,
    serverPublicKeyId,
    ctsKey,
  };
  const previousKeysRaw = getApigwKeysRaw();
  saveApigwKeys(apigwKeys);

  console.log("Step 4/5: Activating device...");

  const activationBody = JSON.stringify({
    app_version: config.app_version,
    locale: config.locale,
    device_meta: {
      pushes: false,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      permissions: { notifications: true },
    },
    device_hostname: null,
  });

  const activationUrl = `${etsBaseUrl}/api/v1/apigw/api/v1/authentication/activation`;
  const activationHeaders = await signApigwRequest({
    method: "PUT",
    url: activationUrl,
    baseUrl: etsBaseUrl,
    body: activationBody,
    ctsToken: currentToken,
  });

  const actRes = await fetch(activationUrl, {
    method: "PUT",
    headers: {
      "Accept": "application/json, text/plain, */*",
      ...activationHeaders,
      "Origin": webOrigin,
      "Referer": `${webOrigin}/`,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
    },
    body: activationBody,
  });

  const actText = await actRes.text();

  if (!actRes.ok) {
    if (previousKeysRaw) {
      setApigwKeysRaw(previousKeysRaw);
      console.log("  (Rolled back to previous apigw keys)");
    } else {
      clearApigwKeys();
    }
    throw new Error(`Device activation failed (${actRes.status}): ${actText.slice(0, 500)}`);
  }

  console.log(`  Activation response: ${actText.slice(0, 300)}`);

  let actData: ActivationResponse;
  try {
    actData = JSON.parse(actText) as ActivationResponse;
  } catch {
    console.log("  (non-JSON activation response, continuing)");
    actData = {};
  }

  const actResult = extractResult(actData);
  const newAccessToken = actResult.access_token;

  if (newAccessToken) {
    setAuthToken(newAccessToken);
    console.log("  Device activated. Token refreshed.");
  } else {
    console.log("  Device activated (using existing token).");
  }

  const effectiveToken = newAccessToken ?? currentToken;
  const udid = randomUUID();

  const pushBody = JSON.stringify({
    phone: null,
    token: null,
    platform: "web_chrome",
    user_huid: userHuid,
    locale: config.locale,
    udid,
    encryption_key: "",
    auth_key: "",
    platform_package_id: config.platform_package_id,
  });

  console.log("Step 5/5: Registering push token...");

  const pushHeaders = await signApigwRequest({
    method: "PUT",
    url: `${etsBaseUrl}/api/v1/apigw/api/v1/push_service/protected/token`,
    baseUrl: etsBaseUrl,
    body: pushBody,
    ctsToken: effectiveToken,
  });

  const pushRes = await fetch(`${etsBaseUrl}/api/v1/apigw/api/v1/push_service/protected/token`, {
    method: "PUT",
    headers: {
      "Accept": "application/json, text/plain, */*",
      ...pushHeaders,
      "Origin": webOrigin,
      "Referer": `${webOrigin}/`,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    },
    body: pushBody,
  });

  const pushText = await pushRes.text();
  console.log(`  Push token: ${pushRes.status} — ${pushText.slice(0, 200)}`);

  console.log("Login complete! Apigw endpoints are now available.");
}
