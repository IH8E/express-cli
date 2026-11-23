import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the `conf` store so these assertions never touch a real login.
process.env.EXPRESS_CLI_CONFIG_DIR = mkdtempSync(join(tmpdir(), "express-cli-loader-test-"));

const { getEtsBaseUrl, getWebOrigin } = await import("./loader.js");
const { configSchema } = await import("../types/index.js");

const cfg = (overrides: Record<string, unknown> = {}) =>
  configSchema.parse({ host: "cts1.example.com", ...overrides });

test("getWebOrigin derives the web origin from a multi-label CTS host", () => {
  assert.equal(getWebOrigin(cfg()), "https://example.com");
});

test("getEtsBaseUrl derives ets.<domain> from the CTS host", () => {
  assert.equal(getEtsBaseUrl(cfg()), "https://ets.example.com");
});

test("getWebOrigin honours an explicit web_origin, with or without scheme", () => {
  assert.equal(getWebOrigin(cfg({ web_origin: "https://corp.express" })), "https://corp.express");
  assert.equal(getWebOrigin(cfg({ web_origin: "corp.express" })), "https://corp.express");
});

test("getEtsBaseUrl honours an explicit ets_host and keeps http", () => {
  assert.equal(getEtsBaseUrl(cfg({ ets_host: "http://localhost:8080" })), "http://localhost:8080");
  assert.equal(getEtsBaseUrl(cfg({ ets_host: "ru.public.express" })), "https://ru.public.express");
});

test("QR defaults stay the self-hosted ones so existing logins keep working", () => {
  const c = cfg();
  assert.equal(c.qr_platform_package_id, "com.pyligrim.alphach");
  assert.equal(c.qr_register_ets, true);
});

test("platform_package_id has no default — device login omits it unless configured", () => {
  assert.equal(cfg().platform_package_id, undefined);
  assert.equal(cfg({ platform_package_id: "ru.example.corp" }).platform_package_id, "ru.example.corp");
});
