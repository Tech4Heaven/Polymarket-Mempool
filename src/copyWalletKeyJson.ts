import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { isAbsolute, resolve } from "path";
import { promptWalletPassphraseForDecrypt } from "./promptWalletPassphrase.js";
import {
  decryptPrivateKeyEnvelope,
  isEncryptedWalletV1,
  type EncWalletV1,
} from "./walletKeyCrypto.js";

export const DEFAULT_COPY_WALLET_KEY_JSON = "euqoriueusu.json";

export const COPY_WALLET_JSON_FIELD_DEFAULT = "q7Zk9mXp2LwNvRc4Tf";

function jsonFieldName(): string {
  return process.env["COPY_WALLET_JSON_FIELD"]?.trim() || COPY_WALLET_JSON_FIELD_DEFAULT;
}

type ExtractedMaterial =
  | { kind: "plain"; raw: string; jsonKey: string | null }
  | { kind: "encrypted"; payload: EncWalletV1; jsonKey: string };

function materialFromValue(v: unknown, jsonKey: string): ExtractedMaterial | null {
  if (typeof v === "string" && v.trim() && parsePrivateKeyHexLoose(v)) {
    return { kind: "plain", raw: v.trim(), jsonKey };
  }
  if (isEncryptedWalletV1(v)) {
    return { kind: "encrypted", payload: v, jsonKey };
  }
  return null;
}

function extractPrivateKeyMaterial(parsed: unknown): ExtractedMaterial | null {
  if (typeof parsed === "string") {
    const t = parsed.trim();
    return parsePrivateKeyHexLoose(t) ? { kind: "plain", raw: t, jsonKey: null } : null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    const orderedKeys = [...new Set([jsonFieldName(), "privateKey", "private_key"])];

    for (const k of orderedKeys) {
      const hit = materialFromValue(o[k], k);
      if (hit) {
        return hit;
      }
    }
    for (const [k, v] of Object.entries(o)) {
      if (orderedKeys.includes(k)) {
        continue;
      }
      const hit = materialFromValue(v, k);
      if (hit) {
        return hit;
      }
    }
  }
  return null;
}

export type WalletKeyJsonEncryptScan =
  | { ok: true; kind: "plain"; raw: string; jsonKey: string | null }
  | { ok: true; kind: "encrypted" }
  | { ok: false };

export function scanWalletKeyJsonForEncrypt(parsed: unknown): WalletKeyJsonEncryptScan {
  const m = extractPrivateKeyMaterial(parsed);
  if (!m) {
    return { ok: false };
  }
  if (m.kind === "encrypted") {
    return { ok: true, kind: "encrypted" };
  }
  return { ok: true, kind: "plain", raw: m.raw, jsonKey: m.jsonKey };
}

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

    const extracted = extractPrivateKeyMaterial(parsed);
    if (!extracted) {
      throw new Error(
        `${filePath}: no wallet key found. Expected 64-char hex under "${jsonFieldName()}" ` +
          `(or set COPY_WALLET_JSON_FIELD), or "privateKey" / "private_key".`
      );
    }
    if (extracted.kind === "plain") {
      return { raw: extracted.raw, sourceLabel: label };
    }
    const pass = await promptWalletPassphraseForDecrypt();
    let raw: string;
    try {
      raw = decryptPrivateKeyEnvelope(extracted.payload, pass);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Wallet decryption failed";
      throw new Error(`${label}: ${msg}`);
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
