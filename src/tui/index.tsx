// Must run before ANY import that pulls in `chalk` (terminal-image does), because chalk
// resolves its colour level once at import time and caches it.
//
// The TUI draws into a terminal by definition, but chalk disables colour whenever
// `NO_COLOR` is set or `TERM=dumb` — common in CI, plain SSH and harness shells. Without
// this, image half-block art renders in one flat colour: the shape is there, the picture
// is not. We only force it when stdout really is a terminal, so piping stays plain.
import { forceColourIfTerminal } from "./colour.js";

forceColourIfTerminal();

export async function runTui(): Promise<void> {
  // Imported lazily so the colour level above is set before chalk loads.
  const { render } = await import("ink");
  const { App } = await import("./app.js");
  const { waitUntilExit } = render(<App />);
  await waitUntilExit();
}
