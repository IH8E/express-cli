import { execFile } from "node:child_process";
import QRCode from "qrcode";

/** Open QR code in the system browser via data URL. Falls back silently if it fails. */
export async function openQrInBrowser(payload: string, registrationId: string): Promise<void> {
  let pngDataUrl: string;
  try {
    pngDataUrl = await QRCode.toDataURL(payload, { scale: 8, margin: 2 });
  } catch {
    return;
  }

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>eXpress QR</title>` +
    `<style>body{font-family:sans-serif;background:#fff;display:flex;flex-direction:column;` +
    `align-items:center;justify-content:center;min-height:100vh;margin:0}` +
    `h2{color:#1a1a1a;margin-bottom:16px}` +
    `img{width:280px;height:280px;image-rendering:pixelated;border:1px solid #eee;border-radius:8px}` +
    `p{color:#999;font-size:11px;margin-top:12px;font-family:monospace}</style></head>` +
    `<body><h2>Scan with eXpress</h2><img src="${pngDataUrl}" alt="QR"><p>${registrationId}</p></body></html>`;

  const htmlDataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  try {
    const opener = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start"
      : "xdg-open";
    execFile(opener, [htmlDataUrl]);
  } catch {
    // silently ignore — ASCII fallback is always shown in the terminal
  }
}
