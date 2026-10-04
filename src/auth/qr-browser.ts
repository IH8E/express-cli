import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import QRCode from "qrcode";

/**
 * Render the QR into an HTML page, write it to a temp file, and try to open it
 * in the system browser. Returns the `file://` URL of the page (so callers can
 * print it as a manual fallback), or null if the page could not be created.
 */
export async function openQrInBrowser(payload: string, registrationId: string): Promise<string | null> {
  let pngDataUrl: string;
  try {
    pngDataUrl = await QRCode.toDataURL(payload, { scale: 8, margin: 2 });
  } catch {
    return null;
  }

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>eXpress QR</title>` +
    `<style>body{font-family:sans-serif;background:#fff;display:flex;flex-direction:column;` +
    `align-items:center;justify-content:center;min-height:100vh;margin:0}` +
    `h2{color:#1a1a1a;margin-bottom:16px}` +
    `img{width:280px;height:280px;image-rendering:pixelated;border:1px solid #eee;border-radius:8px}` +
    `p{color:#999;font-size:11px;margin-top:12px;font-family:monospace}</style></head>` +
    `<body><h2>Scan with eXpress</h2><img src="${pngDataUrl}" alt="QR"><p>${registrationId}</p></body></html>`;

  // Write to a temp file so it (a) can be opened by the OS opener more reliably
  // than a data: URL and (b) yields a printable file:// link for manual fallback.
  let fileUrl: string;
  try {
    const filePath = join(tmpdir(), `express-qr-${registrationId}.html`);
    writeFileSync(filePath, html, { encoding: "utf8", mode: 0o600 });
    fileUrl = pathToFileURL(filePath).href;
  } catch {
    return null;
  }

  try {
    const opener = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start"
      : "xdg-open";
    execFile(opener, [fileUrl]);
  } catch {
    // silently ignore — the file:// URL is printed by the caller as a fallback
  }

  return fileUrl;
}
