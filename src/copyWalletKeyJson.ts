import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { isAbsolute, resolve } from "path";

/** Default filename when `COPY_WALLET_KEY_JSON` is unset (project root). */
export const DEFAULT_COPY_WALLET_KEY_JSON = "euqoriueusu.json";

function extractPrivateKeyString(parsed: unknown): string | null {
  if (typeof parsed === "string") {
    const t = parsed.trim();
    return t || null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    for (const k of ["privateKey", "private_key", "COPY_WALLET_PRIVATE_KEY"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) {
        return v.trim();
      }
    }
  }
  return null;
}

/**
 * Resolves raw private key material for the copy wallet.
 * Priority: `COPY_WALLET_PRIVATE_KEY` env → `COPY_WALLET_KEY_JSON` file → `euqoriueusu.json` in cwd.
 */
export async function resolveCopyWalletPrivateKeyRaw(cwd: string): Promise<string> {
  const envPk = process.env["COPY_WALLET_PRIVATE_KEY"]?.trim();
  if (envPk) {
    return envPk;
  }

  const envPath = process.env["COPY_WALLET_KEY_JSON"]?.trim();
  const filePath = envPath
    ? isAbsolute(envPath)
      ? envPath
      : resolve(cwd, envPath)
    : resolve(cwd, DEFAULT_COPY_WALLET_KEY_JSON);

  if (!existsSync(filePath)) {
    throw new Error(
      "Copy wallet key: set COPY_WALLET_PRIVATE_KEY, or COPY_WALLET_KEY_JSON to a JSON file path, " +
        `or create ${DEFAULT_COPY_WALLET_KEY_JSON} in the project directory with { "privateKey": "0x..." }.`
    );
  }

  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (e) {
    throw new Error(
      `Failed to read copy wallet key file ${filePath}: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (e) {
    throw new Error(
      `Invalid JSON in ${filePath}: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const raw = extractPrivateKeyString(parsed);
  if (!raw) {
    throw new Error(
      `${filePath}: expected a JSON string, or an object with "privateKey" / "private_key" / "COPY_WALLET_PRIVATE_KEY"`
    );
  }
  return raw;
}
