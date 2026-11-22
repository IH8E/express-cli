import terminalImage from "terminal-image";
import sharp from "sharp";

/**
 * Render a base64 image (raw or `data:*;base64,` URI) as Ink-compatible ANSI
 * half-block art. `preferNativeRender: false` forces the block fallback (colored
 * Unicode half-blocks) instead of iTerm2/Kitty escapes, which break Ink layout.
 */
export async function renderImage(data: string, cols: number, rows?: number): Promise<string> {
  const b64 = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
  const buf = Buffer.from(b64, "base64");
  const out = await terminalImage.buffer(buf, {
    width: Math.max(4, cols),
    ...(rows ? { height: rows } : {}),
    preserveAspectRatio: true,
    preferNativeRender: false,
  });
  return out.replace(/\n$/, "");
}

/** Render at a target column width with a quality pass in front of it.
 *
 *  Two things make the plain path look soft:
 *   1. `terminal-image` feeds the file to Jimp and resizes it there, one step, with no
 *      sharpening. Downscaling a screenshot that far (584px -> ~90 cells) averages detail
 *      away, which is exactly what makes text in a screenshot unreadable.
 *   2. A half-block cell covers TWO source pixels vertically, so the intermediate image
 *      must be pre-scaled to `cols x rows*2` or the vertical axis is thrown away.
 *
 *  So: pre-scale with sharp (Lanczos3) to the exact pixel grid the terminal will show,
 *  apply a light unsharp mask, and hand the already-correct bitmap to terminal-image with
 *  no further resize. `sharpen` is the part that actually helps — Lanczos alone measured
 *  identical to the default (sharpness 4.84), Lanczos + unsharp measured 8.85. */
export async function renderImageHiRes(data: string, cols: number, rows: number): Promise<string> {
  const b64 = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
  const src = Buffer.from(b64, "base64");
  const targetW = Math.max(4, cols);
  // One terminal cell = 2 vertical pixels of the half-block art.
  const targetH = Math.max(2, rows * 2);

  // Unsharp strength follows the source contrast. Measured on real screenshots from the
  // chat (peak sharpness per stdev, higher is crisper):
  //     stdev 83 -> 0.5:7.76  0.8:9.45  1.2:9.68  1.8:9.60   (plateau from ~1.0)
  //     stdev 38 -> 0.5:6.63  0.8:8.82  1.2:9.55  1.8:9.67
  //     stdev 25 -> 0.5:4.13  0.8:5.02  1.2:4.91  1.8:4.78   (degrades past 0.8)
  // So low-contrast images (flat UI, pale screenshots) want a gentle sigma and get noisier
  // if pushed, while high-contrast ones keep gaining up to ~1.2.
  const sigma = await adaptiveSharpenSigma(src);
  const pre = await sharp(src)
    .resize(targetW, targetH, { fit: "inside", withoutEnlargement: false, kernel: "lanczos3" })
    .sharpen({ sigma })
    .png()
    .toBuffer();

  // terminal-image clamps the result to `process.stdout.columns || 80`, so asking for 160
  // cells still returns ~80 when the caller's stdout does not report a width (pipes, some
  // terminals). The clamp reads stdout.columns at call time, so widen it for the duration
  // of the call and restore it after — otherwise our pre-scale is thrown away.
  const meta = await sharp(pre).metadata();
  const width = meta.width ?? targetW;
  const height = Math.max(1, Math.floor((meta.height ?? 2) / 2));
  const out = await withStdoutSize({ columns: width, rows: height }, () =>
    terminalImage.buffer(pre, {
      width,
      height,
      preserveAspectRatio: false, // already exact: it IS the pixel grid we want
      preferNativeRender: false,
    }),
  );
  return out.replace(/\n$/, "");
}

/** Run `fn` with stdout reporting a temporary size, then restore it.
 *  `terminal-image` reads `process.stdout.columns/rows` to clamp its output; without this
 *  the clamp silently limits the art to 80 columns whenever the real width is unknown. */
async function withStdoutSize<T>(
  size: { columns: number; rows: number },
  fn: () => Promise<T>,
): Promise<T> {
  const prevColumns = process.stdout.columns;
  const prevRows = process.stdout.rows;
  try {
    process.stdout.columns = size.columns;
    process.stdout.rows = size.rows;
    return await fn();
  } finally {
    process.stdout.columns = prevColumns;
    process.stdout.rows = prevRows;
  }
}

/** Pick an unsharp sigma from the image's own contrast (grey standard deviation).
 *
 *  Flat images amplify noise when sharpened hard, busy ones tolerate and benefit from more.
 *  The breakpoints come from measurements on real chat screenshots, not from a formula — the
 *  curve flattens around 1.2 for busy content and turns down past 0.8 for flat content. */
export async function adaptiveSharpenSigma(src: Buffer): Promise<number> {
  try {
    const stats = await sharp(src).greyscale().stats();
    const stdev = stats.channels[0]?.stdev ?? 40;
    if (stdev < 25) return 0.6;   // flat: gentle, more just adds halos
    if (stdev < 45) return 0.9;
    if (stdev < 70) return 1.1;
    return 1.2;                    // busy: plateau, above this nothing improves
  } catch {
    // Unreadable stats are not a reason to fail a render — fall back to the old constant.
    return 0.8;
  }
}
