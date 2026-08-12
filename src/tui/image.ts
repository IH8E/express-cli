import terminalImage from "terminal-image";

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
