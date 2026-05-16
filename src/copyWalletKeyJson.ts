import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { isAbsolute, resolve } from "path";

/** Default filename when `COPY_WALLET_KEY_JSON` is unset (project root). */
export const DEFAULT_COPY_WALLET_KEY_JSON = "euqoriueusu.json";

/**
 * Property name for the hex key inside the JSON file (not a semantic name like `privateKey`).
 * Override with env `COPY_WALLET_JSON_FIELD` if you rename the field in your file.
 */
export const COPY_WALLET_JSON_FIELD_DEFAULT = "q7Zk9mXp2LwNvRc4Tf";

function jsonFieldName(): string {
  return process.env["COPY_WALLET_JSON_FIELD"]?.trim() || COPY_WALLET_JSON_FIELD_DEFAULT;
}

function extractPrivateKeyString(parsed: unknown): string | null {
  if (typeof parsed === "string") {
    const t = parsed.trim();
    return parsePrivateKeyHexLoose(t) ? t : null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    const orderedKeys = [...new Set([jsonFieldName(), "privateKey", "private_key"])];
    for (const k of orderedKeys) {
      const v = o[k];
      if (typeof v === "string" && v.trim() && parsePrivateKeyHexLoose(v)) {
        return v.trim();
      }
    }
    for (const [k, v] of Object.entries(o)) {
      if (orderedKeys.includes(k)) {
        continue;
      }
      if (typeof v === "string" && v.trim() && parsePrivateKeyHexLoose(v)) {
        return v.trim();
      }
    }
  }
  return null;
}

/** Returns normalized key if `raw` is valid after cleanup; otherwise null. */
export function parsePrivateKeyHexLoose(raw: string): `0x${string}` | null {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/\s+/g, "");
  if (s.startsWith("0x") || s.startsWith("0X")) {
    s = s.slice(2);
  }
  const lower = s.toLowerCase();
  if (lower.length !== 64 || !/^[0-9a-f]{64}$/.test(lower)) {
    return null;
  }
  return `0x${lower}` as `0x${string}`;
}

/**
 * Normalizes and validates a 32-byte EVM private key (MetaMask-style).
 * Strips whitespace/newlines often pasted inside JSON strings.
 */
export function requirePrivateKeyHex(raw: string, sourceLabel: string): `0x${string}` {
  const pk = parsePrivateKeyHexLoose(raw);
  if (pk) {
    return pk;
  }
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/\s+/g, "");
  if (s.startsWith("0x") || s.startsWith("0X")) {
    s = s.slice(2);
  }
  const lower = s.toLowerCase();
  if (lower.length !== 64) {
    throw new Error(
      `${sourceLabel}: private key must be 32 bytes (64 hex digits, optional 0x). ` +
        `After removing spaces and 0x prefix, found ${lower.length} hex characters (expected 64).`
    );
  }
  if (!/^[0-9a-f]{64}$/.test(lower)) {
    throw new Error(
      `${sourceLabel}: private key must be hexadecimal (0-9, a-f) only — check for typos or wrong characters`
    );
  }
  return `0x${lower}` as `0x${string}`;
}

export type ResolvedWalletKey = { raw: string; sourceLabel: string };

/**
 * Resolves raw private key material for the copy wallet.
 *
 * Priority (so a leftover placeholder in `.env` does not override your JSON file):
 * 1. `COPY_WALLET_KEY_JSON` when set (path to JSON file)
 * 2. Else `euqoriueusu.json` in cwd when that file exists
 * 3. Else `COPY_WALLET_PRIVATE_KEY` in `.env`
 */
export async function resolveCopyWalletPrivateKeyRaw(cwd: string): Promise<ResolvedWalletKey> {
  const envPath = process.env["COPY_WALLET_KEY_JSON"]?.trim();
  const defaultAbs = resolve(cwd, DEFAULT_COPY_WALLET_KEY_JSON);

  const tryReadJsonFile = async (filePath: string, label: string): Promise<ResolvedWalletKey> => {
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
        `${filePath}: no valid 32-byte hex private key found. ` +
          `Use property "${jsonFieldName()}" (or set COPY_WALLET_JSON_FIELD), or "privateKey", or a JSON string. ` +
          `The hex must be 64 characters (spaces and newlines inside the string are OK).`
      );
    }
    return { raw, sourceLabel: label };
  };

  if (envPath) {
    const filePath = isAbsolute(envPath) ? envPath : resolve(cwd, envPath);
    if (!existsSync(filePath)) {
      throw new Error(`COPY_WALLET_KEY_JSON file not found: ${filePath}`);
    }
    return tryReadJsonFile(filePath, `key file ${filePath}`);
  }

  if (existsSync(defaultAbs)) {
    return tryReadJsonFile(defaultAbs, `key file ${defaultAbs}`);
  }

  const envPk = process.env["COPY_WALLET_PRIVATE_KEY"]?.trim();
  if (envPk) {
    return { raw: envPk, sourceLabel: "COPY_WALLET_PRIVATE_KEY" };
  }

  throw new Error(
    "Copy wallet key: add a credentials JSON file (see COPY_WALLET_KEY_JSON), or set COPY_WALLET_PRIVATE_KEY in .env"
  );
}
