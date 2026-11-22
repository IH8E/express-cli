import { test } from "node:test";
import assert from "node:assert/strict";
import { openInSystemViewer, viewerCommand } from "./open-file.js";

test("macOS uses `open`", () => {
  assert.deepEqual(viewerCommand("darwin", "/tmp/a.png"), ["open", ["/tmp/a.png"]]);
});

test("Linux uses `xdg-open`", () => {
  assert.deepEqual(viewerCommand("linux", "/tmp/a.png"), ["xdg-open", ["/tmp/a.png"]]);
});

test("Windows uses `cmd /c start` with an empty title argument", () => {
  assert.deepEqual(viewerCommand("win32", "C:\\a.png"), ["cmd", ["/c", "start", "", "C:\\a.png"]]);
});

test("openInSystemViewer returns without throwing and does not block", () => {
  const before = Date.now();
  openInSystemViewer("/nonexistent/definitely-missing.png");
  assert.ok(Date.now() - before < 500, "spawning must be detached, not awaited");
});
