/** Validate a `--limit` value coming from the command line.
 *  `parseInt(...) || 20` used to mask typos (and pass -1 through to hang the request),
 *  so garbage is rejected loudly instead of silently becoming the default. */
export function parseLimit(value: string | undefined, opts: { fallback: number; max: number }): number {
  if (value === undefined || value === "") return opts.fallback;
  const raw = value.trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid --limit "${value}": expected a whole number between 1 and ${opts.max}.`);
  }
  const n = Number(raw);
  if (n < 1) throw new Error(`Invalid --limit "${value}": must be at least 1.`);
  if (n > opts.max) throw new Error(`Invalid --limit "${value}": at most ${opts.max}.`);
  return n;
}
