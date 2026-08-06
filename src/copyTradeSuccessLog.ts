import { appendFile, mkdir } from "fs/promises";
import { dirname, isAbsolute, resolve } from "path";

/**
 * Appends one line (skip / dry-run / posted). Uses `filePathOverride` when set (absolute path from per-target config);
 * else `COPY_TRADE_LOG_PATH` if set; else `copy-trades.log` in cwd.
 */
export async function appendCopyTradeSuccessLine(line: string, filePathOverride?: string): Promise<void> {
  const envRaw = process.env["COPY_TRADE_LOG_PATH"]?.trim();
  const pick = filePathOverride?.trim() || envRaw;
  const filePath = pick
    ? isAbsolute(pick)
      ? pick
      : resolve(process.cwd(), pick)
    : resolve(process.cwd(), "copy-trades.log");
  try {
    await mkdir(dirname(filePath), { recursive: true });
  } catch {
    /* ignore */
  }
  const ts = new Date().toISOString();
  try {
    await appendFile(filePath, `[${ts}] ${line}\n`, "utf8");
  } catch (e) {
    console.error(`copy-trades log append failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
