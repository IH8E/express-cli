/** True when the TUI should force truecolor on itself.
 *
 *  `chalk` (used by terminal-image and our own output) disables colour whenever `NO_COLOR`
 *  is set or `TERM=dumb` — common in CI, plain SSH and harness shells. Image half-block art
 *  then renders in one flat colour: the shape is there, the picture is not.
 *
 *  Only a real terminal is worth forcing: piping to a file must stay plain, and an explicit
 *  user opt-in is left alone. `FORCE_COLOR=0` counts as "not decided" — chalk reads it as
 *  "no colour", which is exactly the state this function exists to repair. */
export function shouldForceColour(env: { FORCE_COLOR?: string }, isTTY: boolean | undefined): boolean {
  if (isTTY === false) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return false;
  return true;
}

/** Apply the rule above to the current process (call before anything imports chalk). */
export function forceColourIfTerminal(): void {
  if (shouldForceColour(process.env, process.stdout.isTTY)) {
    process.env.FORCE_COLOR = "3"; // truecolor
  }
}
