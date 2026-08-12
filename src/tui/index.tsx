import { render } from "ink";
import { App } from "./app.js";

export async function runTui(): Promise<void> {
  const { waitUntilExit } = render(<App />);
  await waitUntilExit();
}
