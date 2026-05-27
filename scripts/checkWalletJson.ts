import { readFile } from "fs/promises";
import { resolve } from "path";
import {
  DEFAULT_COPY_WALLET_KEY_JSON,
  parsePrivateKeyHexLoose,
  scanWalletKeyJsonForEncrypt,
} from "../src/copyWalletKeyJson.js";

/**
 * Diagnoses a copy-wallet key JSON WITHOUT printing the secret. Reports, per top-level field:
 * value type, cleaned hex length, whether it's hex-only, and whether it parses as a valid key —
 * then the same verdict the encrypt-wallet script uses. Safe to share output.
 *
 * Usage: npx tsx scripts/checkWalletJson.ts [path]   (defaults to euqoriueusu.json)
 */
async function main(): Promise<void> {
  const filePath = resolve(process.cwd(), process.argv[2] ?? DEFAULT_COPY_WALLET_KEY_JSON);

  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (e) {
    console.error(`Cannot read ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (e) {
    console.error(`Invalid JSON in ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // Describe a value's key-candidacy without revealing it.
  const describe = (v: unknown): string => {
    if (typeof v !== "string") {
      return `type=${Array.isArray(v) ? "array" : typeof v} (not a string → cannot be a plain key)`;
    }
    const cleaned = v
      .trim()
      .replace(/^['"]|['"]$/g, "")
      .replace(/\s+/g, "")
      .replace(/^0[xX]/, "");
    const isHex = /^[0-9a-fA-F]*$/.test(cleaned);
    const validKey = parsePrivateKeyHexLoose(v) !== null;
    return `string · cleanedLength=${cleaned.length} (need 64) · hexOnly=${isHex} · validKey=${validKey}`;
  };

  console.log(`Checking: ${filePath}`);
  console.log("---");
  if (typeof parsed === "string") {
    console.log(`root (bare string): ${describe(parsed)}`);
  } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) {
      console.log("(empty object — no fields)");
    }
    for (const [k, v] of entries) {
      console.log(`field "${k}": ${describe(v)}`);
    }
  } else {
    console.log(`root is ${Array.isArray(parsed) ? "array" : typeof parsed} (expected an object or a bare string)`);
  }
  console.log("---");

  const scan = scanWalletKeyJsonForEncrypt(parsed);
  if (!scan.ok) {
    console.log("RESULT: ❌ no valid plain hex key found (encrypt-wallet will reject this)");
    console.log("Fix: ensure one field's value is exactly 64 hex chars (0-9, a-f), optional 0x prefix.");
  } else if (scan.kind === "encrypted") {
    console.log("RESULT: 🔒 already encrypted — no need to run encrypt-wallet again");
  } else {
    console.log("RESULT: ✓ valid plain hex key found — ready for encrypt-wallet");
  }
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
