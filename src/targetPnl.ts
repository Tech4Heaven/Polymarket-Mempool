import { readdir, readFile } from "fs/promises";
import { dirname, join } from "path";
import { parseCopyTargetsTomlFile } from "./copyTargetsToml.js";
import { fetchPolymarketProfileLabel } from "./polymarketProfile.js";
import { tgCode, tgEsc } from "./telegram.js";
import { parseEnvFile } from "./walletBalances.js";

/**
 * Per-target realized-P&L reporting for the `/pnl` command. The command runs only on the listener bot
 * (Main), but every deployment keeps its own copy-targets.toml + logs/pnl-realized.jsonl in its own
 * folder — so we discover the sibling folders and read each selected bot's files directly.
 */

export type BotRef = { name: string; dir: string };

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
function money(x: number): string {
  return `${x >= 0 ? "+" : "-"}$${Math.abs(x).toFixed(2)}`;
}
function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Deployment folders (siblings of this one), each a bot. Deterministic order for stable button indices. */
export async function discoverBots(): Promise<BotRef[]> {
  const baseDir = process.env["WALLETS_ENV_DIR"]?.trim() || dirname(process.cwd());
  const out: BotRef[] = [];
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    for (const name of entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      const dir = join(baseDir, name);
      const env = await parseEnvFile(join(dir, ".env"));
      if (env["FUNDER_ADDRESS"] || env["BOT_NAME"]) {
        out.push({ name: env["BOT_NAME"]?.trim() || name, dir });
      }
    }
  } catch {
    // base dir unreadable → no bots
  }
  return out;
}

type ActiveTarget = { address: string; tomlUsername?: string };

/** Targets currently being copied by a bot: enabled AND not dry-run (defaults merged). */
async function activeTargets(dir: string): Promise<ActiveTarget[]> {
  try {
    const parsed = await parseCopyTargetsTomlFile(join(dir, "copy-targets.toml"));
    const dfDry = parsed.defaults?.dry_run;
    const dfEnabled = parsed.defaults?.enabled;
    const out: ActiveTarget[] = [];
    for (const row of parsed.targets) {
      const enabled = row.enabled ?? dfEnabled ?? true;
      const dry = row.dry_run ?? dfDry ?? false;
      if (!enabled || dry) {
        continue;
      }
      out.push({ address: row.address.toLowerCase(), tomlUsername: row.username?.trim() || undefined });
    }
    return out;
  } catch {
    return [];
  }
}

// address(lower) → resolved display name. Persists across /pnl calls so we don't refetch each time.
const nameCache = new Map<string, string>();

/** Display name: the toml `username` if set, else the Polymarket profile name, else the short address. */
async function resolveName(address: string, tomlUsername?: string): Promise<string> {
  if (tomlUsername) {
    return tomlUsername;
  }
  const cached = nameCache.get(address);
  if (cached !== undefined) {
    return cached;
  }
  const label = await fetchPolymarketProfileLabel(address);
  const name = label ?? shortAddr(address);
  nameCache.set(address, name);
  return name;
}

type Realized = { ts: number; target: string; pnl: number };

/** A bot's realized-P&L records, read straight from its own logs/pnl-realized.jsonl. */
async function readRealized(dir: string): Promise<Realized[]> {
  try {
    const txt = await readFile(join(dir, "logs", "pnl-realized.jsonl"), "utf8");
    const out: Realized[] = [];
    for (const line of txt.split("\n")) {
      const t = line.trim();
      if (!t) {
        continue;
      }
      try {
        const r = JSON.parse(t) as { ts?: number; target?: string; pnl?: number };
        if (typeof r.ts === "number" && typeof r.target === "string" && typeof r.pnl === "number") {
          out.push({ ts: r.ts, target: r.target.toLowerCase(), pnl: r.pnl });
        }
      } catch {
        // skip corrupt line
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Build the HTML report: for each selected bot, realized P&L (today + all-time) per ACTIVE target. */
export async function buildTargetPnlReport(bots: BotRef[]): Promise<string> {
  const today = utcDay(Date.now());
  const lines: string[] = ["📊 Realized P&L per active target", ""];
  let grandDay = 0;
  let grandAll = 0;

  for (const bot of bots) {
    const [targets, realized] = await Promise.all([activeTargets(bot.dir), readRealized(bot.dir)]);
    lines.push(`🤖 ${tgEsc(bot.name)}`);
    if (targets.length === 0) {
      lines.push("  (no active targets)", "");
      continue;
    }

    const dayByT = new Map<string, number>();
    const allByT = new Map<string, number>();
    for (const r of realized) {
      allByT.set(r.target, (allByT.get(r.target) ?? 0) + r.pnl);
      if (utcDay(r.ts) === today) {
        dayByT.set(r.target, (dayByT.get(r.target) ?? 0) + r.pnl);
      }
    }

    // Resolve display names (toml username → Polymarket profile → short address), concurrently + cached.
    const named = await Promise.all(
      targets.map(async (t) => ({
        address: t.address,
        name: await resolveName(t.address, t.tomlUsername),
        day: dayByT.get(t.address) ?? 0,
        all: allByT.get(t.address) ?? 0,
      }))
    );
    // Worst all-time first, so losing targets surface at the top.
    named.sort((a, b) => a.all - b.all);

    let botDay = 0;
    let botAll = 0;
    for (const { address, name, day, all } of named) {
      botDay += day;
      botAll += all;
      lines.push(`  ${tgEsc(name)} — today ${money(day)} · all-time ${money(all)}`);
      lines.push(`  ${tgCode(address)}`);
    }
    lines.push(`  Σ ${tgEsc(bot.name)} — today ${money(botDay)} · all-time ${money(botAll)}`, "");
    grandDay += botDay;
    grandAll += botAll;
  }

  if (bots.length > 1) {
    lines.push(`Σ selected — today ${money(grandDay)} · all-time ${money(grandAll)}`);
  }
  return lines.join("\n").trimEnd();
}
