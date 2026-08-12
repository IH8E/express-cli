import chalk from "chalk";
import Table from "cli-table3";
import type { ExpressProfile, ExpressUserStatus } from "../types/index.js";

export type OutputFormat = "table" | "json";

export function formatOutput(data: unknown, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(data, null, 2);
  }
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  return JSON.stringify(data, null, 2);
}

export function formatProfileTable(profiles: ExpressProfile[]): string {
  const table = new Table({
    head: ["Name", "Email", "AD Login", "Department", "Position", "HUID"],
    style: { head: ["cyan"] },
  });

  for (const p of profiles) {
    table.push([
      p.name ?? "-",
      p.email ?? "-",
      p.ad_login ?? "-",
      p.department ?? "-",
      p.company_position ?? "-",
      p.user_huid ? p.user_huid.slice(0, 8) + "..." : "-",
    ]);
  }

  return table.toString();
}

export function formatStatusTable(statuses: ExpressUserStatus[]): string {
  const table = new Table({
    head: ["HUID", "Status", "Last Seen"],
    style: { head: ["cyan"] },
  });

  const statusColors: Record<string, typeof chalk.green> = {
    online: chalk.green,
    offline: chalk.gray,
    away: chalk.yellow,
    dnd: chalk.red,
    invisible: chalk.gray,
  };

  for (const s of statuses) {
    const color = statusColors[s.status] ?? chalk.white;
    table.push([
      s.huid ? s.huid.slice(0, 8) + "..." : "-",
      color(s.status),
      s.last_seen ?? "-",
    ]);
  }

  return table.toString();
}
