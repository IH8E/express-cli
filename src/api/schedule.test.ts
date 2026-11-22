import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the `conf` store before anything imports it.
process.env.EXPRESS_CLI_CONFIG_DIR = mkdtempSync(join(tmpdir(), "express-cli-schedule-test-"));
process.env.EXPRESS_HOST = "test.invalid";

const { parseSchedule } = await import("./schedule.js");

test("parseSchedule: relative minutes/hours/days resolve to the future", () => {
  const now = Date.now();
  for (const [spec, maxMs] of [["+5m", 5 * 60_000], ["+2h", 2 * 3_600_000], ["+1d", 86_400_000]] as const) {
    const iso = parseSchedule(spec);
    const delta = Date.parse(iso) - now;
    assert.ok(delta > 0, `${spec} must be in the future`);
    assert.ok(delta <= maxMs + 2_000, `${spec} must land near its window, got ${delta}ms`);
  }
});

test("parseSchedule: accepts an ISO timestamp and normalises it", () => {
  const iso = parseSchedule("2099-01-02T03:04:05Z");
  assert.equal(iso, "2099-01-02T03:04:05.000Z");
});

test("parseSchedule: rejects a past timestamp instead of sending never", () => {
  assert.throws(() => parseSchedule("2020-01-01T00:00:00Z"), /is in the past/);
});

test("parseSchedule: rejects garbage and a zero offset", () => {
  assert.throws(() => parseSchedule("не-дата"), /Invalid time/);
  assert.throws(() => parseSchedule("+0m"), /is in the past/);
});

test("parseSchedule: tolerates surrounding whitespace", () => {
  assert.ok(Date.parse(parseSchedule("  +10m  ")) > Date.now());
});
