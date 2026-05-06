import { appendFile } from "fs/promises";
import { resolve } from "path";

/** Default `copy-trades.log` in cwd; override with `COPY_TRADE_LOG_PATH` (relative or absolute). Appends posted trades and skips. */
export async function appendCopyTradeSuccessLine(line: string): Promise<void> {
  const raw = process.env["COPY_TRADE_LOG_PATH"]?.trim();
  const filePath = raw
    ? resolve(process.cwd(), raw)
    : resolve(process.cwd(), "copy-trades.log");
  const ts = new Date().toISOString();
  try {
    await appendFile(filePath, `[${ts}] ${line}\n`, "utf8");
  } catch (e) {
    console.error("copy-trades log append failed:", e);
  }
}
