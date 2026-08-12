import { Command } from "commander";
import { importToken, logout, status, deviceLogin, qrLogin, loadApigwKeys, clearApigwKeys, importCtsKey } from "../auth/index.js";
import { getTokenExpiresAt, getRefreshToken, isTokenExpiringSoon } from "../config/store.js";
import { refreshToken } from "../auth/token-refresh.js";

export function createAuthCommand(): Command {
  const cmd = new Command("auth");

  cmd.description("Authentication management");

  cmd
    .command("import <token>")
    .description("Import Bearer token from browser")
    .option("--host <host>", "eXpress host")
    .action(async (token: string, opts: { host?: string }) => {
      try {
        await importToken(token, opts.host ? { host: opts.host } : {});
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("login")
    .description("Full device login (ed25519 signing for apigw endpoints)")
    .option("--host <host>", "eXpress host")
    .action(async (opts: { host?: string }) => {
      try {
        await deviceLogin(opts.host ? { host: opts.host } : {});
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("qr")
    .description("QR-code login (scan with eXpress mobile app)")
    .option("--host <host>", "eXpress host")
    .action(async (opts: { host?: string }) => {
      try {
        await qrLogin(opts.host ? { host: opts.host } : {});
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("import-cts <private_key_b64> <key_id>")
    .description("Import the account's shared CTS (E2E) key so the CLI decrypts like your phone/desktop. Get both values from the web client's IndexedDB (authState → encryptionKeys → user.privateKeys.cts: body + publicKeyId).")
    .action((privateKeyB64: string, keyId: string) => {
      try {
        const ctsKey = importCtsKey(privateKeyB64, keyId);
        const pub = Buffer.from(ctsKey.publicKey).toString("base64");
        console.log(`CTS key imported: ${keyId}`);
        console.log(`  derived public key: ${pub}`);
        console.log("  Verify this matches the KDC 'body' for this key_id. Do NOT run 'auth login/qr' with a different device now — it would re-register a new key and break sync.");
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command("logout")
    .description("Remove stored authentication token and apigw keys")
    .action(() => {
      clearApigwKeys();
      logout();
    });

  cmd
    .command("status")
    .description("Show current authentication status")
    .action(() => {
      status();
      const expiresAt = getTokenExpiresAt();
      const hasRefresh = !!getRefreshToken();
      if (expiresAt) {
        const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
        const expired = remaining === 0;
        console.log(`Token: ${expired ? "EXPIRED" : `expires in ${remaining}s (~${(remaining / 60).toFixed(0)} min)`}`);
        console.log(`Refresh: ${hasRefresh ? "available" : "not available"}`);
      } else {
        console.log("Token: expiry unknown");
        console.log(`Refresh: ${hasRefresh ? "available" : "not available"}`);
      }
      const keys = loadApigwKeys();
      if (keys) {
        console.log(`Apigw: enabled (signing: ${keys.signingKey.keyId.slice(0, 8)}..., encryption: ${keys.encryptionKey.keyId.slice(0, 8)}..., server: ${keys.serverPublicKeyId.slice(0, 8)}...)`);
      } else {
        console.log("Apigw: not configured. Run 'express auth login' or 'express auth qr' to enable.");
      }
    });

  cmd
    .command("refresh")
    .description("Refresh access token using refresh token")
    .action(async () => {
      try {
        const refreshed = await refreshToken();
        if (refreshed) {
          const expiresAt = getTokenExpiresAt();
          const remaining = expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : 0;
          console.log(`Token refreshed successfully (expires in ${remaining}s)`);
        } else {
          console.error("Failed to refresh token. Re-authenticate with `express auth qr`.");
          process.exit(1);
        }
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  return cmd;
}
