/** Parse a "send later" timestamp: an ISO date-time, or a relative "+5m" / "+2h" / "+1d".
 *  The server keeps its own clock and drops past timestamps, so reject them up front —
 *  a silently-never-delivered message is worse than a clear error. */
export function parseSchedule(value: string): string {
  const raw = value.trim();
  let when: Date;
  const rel = /^\+(\d+)\s*([mhd])$/i.exec(raw);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
    when = new Date(Date.now() + ms);
  } else {
    when = new Date(raw);
  }
  if (Number.isNaN(when.getTime())) {
    throw new Error(`Invalid time "${value}": use an ISO timestamp or a relative "+5m", "+2h", "+1d".`);
  }
  if (when.getTime() <= Date.now()) {
    throw new Error(`"${value}" is in the past — a delayed message needs a future time.`);
  }
  return when.toISOString();
}
