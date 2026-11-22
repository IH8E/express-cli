import { spawn } from "node:child_process";

/** The platform-specific command that hands a file to its default application.
 *  Exported so the mapping is testable without spawning a process. */
export function viewerCommand(platform: NodeJS.Platform, path: string): [string, string[]] {
  if (platform === "darwin") return ["open", [path]];
  if (platform === "win32") {
    // The empty "" keeps `start` from treating the path as the window title.
    return ["cmd", ["/c", "start", "", path]];
  }
  return ["xdg-open", [path]];
}

/** Open a file with the OS default viewer: Preview on macOS, the desktop handler on Linux,
 *  `start` on Windows. Detached and unref'd so the TUI keeps running while the viewer is up.
 *
 *  This is the honest answer to "show me the real picture": a terminal cell is two pixels, so
 *  block art keeps ~7% of a screenshot's detail, while the OS viewer shows the original. */
export function openInSystemViewer(path: string): void {
  const [cmd, args] = viewerCommand(process.platform, path);
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
}
