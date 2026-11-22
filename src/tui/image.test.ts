import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { renderImage, renderImageHiRes } from "./image.js";

/** A PNG with real structure — a flat square would hide any resampling difference. */
async function testImage(width = 400, height = 300): Promise<string> {
  const stripes = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const on = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      stripes[i] = on ? 240 : 20;
      stripes[i + 1] = on ? 200 : 40;
      stripes[i + 2] = on ? 60 : 120;
    }
  }
  const png = await sharp(stripes, { raw: { width, height, channels: 3 } }).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

const visibleWidth = (art: string) => art.split("\n")[0].replace(/\x1b\[[0-9;]*m/g, "").length;
const lineCount = (art: string) => art.split("\n").length;

test("renderImageHiRes honours a width beyond the 80-column default", async () => {
  // A wide box so height does not become the limiting side (fit: inside scales by the
  // tighter constraint, which is correct behaviour, not the bug this guards).
  const art = await renderImageHiRes(await testImage(400, 300), 140, 60);
  // Before the stdout widening terminal-image clamped to 80 and the detail was lost.
  assert.ok(visibleWidth(art) > 100, `expected >100 columns, got ${visibleWidth(art)}`);
});

test("renderImageHiRes never exceeds the requested width", async () => {
  const art = await renderImageHiRes(await testImage(), 60, 20);
  assert.ok(visibleWidth(art) <= 60, `got ${visibleWidth(art)} columns for a 60-column request`);
});

test("renderImageHiRes respects the requested height", async () => {
  const art = await renderImageHiRes(await testImage(), 60, 10);
  assert.ok(lineCount(art) <= 10, `got ${lineCount(art)} lines for a 10-line request`);
});

test("renderImageHiRes keeps the aspect ratio inside a tall box", async () => {
  // 4:3 source into a square box must not become square: height is the tighter side.
  const art = await renderImageHiRes(await testImage(400, 300), 40, 40);
  const w = visibleWidth(art);
  const h = lineCount(art);
  assert.ok(h < w, `a 4:3 image should stay wider than tall, got ${w}x${h}`);
  assert.ok(w <= 40 && h <= 40, `must fit the box, got ${w}x${h}`);
});

test("renderImageHiRes decodes a data URI as well as raw base64", async () => {
  const uri = await testImage();
  const raw = uri.slice(uri.indexOf(",") + 1);
  assert.equal(await renderImageHiRes(uri, 40, 12), await renderImageHiRes(raw, 40, 12));
});

test("renderImageHiRes produces half-block art", async () => {
  // Colour depends on chalk's level, which it caches at import time — asserting on ANSI
  // would make the test pass or fail with the ambient environment. Assert the structure we
  // actually control: the art is non-empty and built from the half-block glyph.
  const art = await renderImageHiRes(await testImage(), 40, 12);
  assert.ok(art.length > 0);
  assert.ok(art.includes("\u2584"), "art should be made of the lower-half block glyph");
});

test("renderImage restores stdout size after rendering", async () => {
  const { columns } = process.stdout;
  await renderImage(await testImage(), 40, 12);
  assert.equal(process.stdout.columns, columns, "the temporary width must not leak");
});

/** Flat vs busy source: the sigma picker must read the image, not return a constant. */
async function flatImage(): Promise<Buffer> {
  return sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 128, g: 128, b: 128 } } }).png().toBuffer();
}

test("adaptiveSharpenSigma is gentle on a flat image", async () => {
  const { adaptiveSharpenSigma } = await import("./image.js");
  assert.ok(await adaptiveSharpenSigma(await flatImage()) <= 0.6);
});

test("adaptiveSharpenSigma sharpens a busy image harder", async () => {
  const { adaptiveSharpenSigma } = await import("./image.js");
  const busy = await sharp(Buffer.from(await testImageRaw(400, 300))).png().toBuffer();
  assert.ok(await adaptiveSharpenSigma(busy) >= 1.1);
});

test("adaptiveSharpenSigma falls back instead of throwing on unreadable input", async () => {
  const { adaptiveSharpenSigma } = await import("./image.js");
  assert.equal(await adaptiveSharpenSigma(Buffer.from("not an image")), 0.8);
});

/** Raw checkerboard pixels — high grey deviation. */
async function testImageRaw(width: number, height: number): Promise<Buffer> {
  const px = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const on = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
      px[i] = px[i + 1] = px[i + 2] = on ? 250 : 5;
    }
  }
  return sharp(px, { raw: { width, height, channels: 3 } }).png().toBuffer();
}
