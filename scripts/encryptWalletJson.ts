import "dotenv/config";
import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";
import {
  COPY_WALLET_JSON_FIELD_DEFAULT,
  DEFAULT_COPY_WALLET_KEY_JSON,
  scanWalletKeyJsonForEncrypt,
} from "../src/copyWalletKeyJson.js";
import { readPassphraseHidden } from "../src/promptWalletPassphrase.js";
import { encryptPrivateKeyToEnvelope } from "../src/walletKeyCrypto.js";

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Run in an interactive terminal.");
    process.exit(1);
  }

  const filePath = resolve(process.cwd(), process.argv[2] ?? DEFAULT_COPY_WALLET_KEY_JSON);
  const field =
    process.env["COPY_WALLET_JSON_FIELD"]?.trim() && process.env["COPY_WALLET_JSON_FIELD"].trim().length > 0
      ? process.env["COPY_WALLET_JSON_FIELD"]!.trim()
      : COPY_WALLET_JSON_FIELD_DEFAULT;

  const text = await readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (e) {
    console.error(e instanceof Error ? e.message : "Invalid JSON");
    process.exit(1);
  }

  const scan = scanWalletKeyJsonForEncrypt(parsed);
  if (!scan.ok) {
    console.error(`No valid plain hex key in ${filePath}`);
    process.exit(1);
  }
  if (scan.kind === "encrypted") {
    console.error(`Already non-plain: ${filePath}`);
    process.exit(1);
  }

  const pass1 = await readPassphraseHidden("Passphrase");
  const pass2 = await readPassphraseHidden("Confirm passphrase");
  if (pass1 !== pass2) {
    console.error("Passphrases do not match.");
    process.exit(1);
  }
  if (!pass1) {
    console.error("Passphrase must not be empty.");
    process.exit(1);
  }

  let envelope;
  try {
    envelope = encryptPrivateKeyToEnvelope(scan.raw, pass1);
  } catch (e) {
    console.error(e instanceof Error ? e.message : "Failed");
    process.exit(1);
  }

  let outDoc: Record<string, unknown>;
  if (scan.jsonKey === null) {
    outDoc = { [field]: envelope };
  } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    outDoc = { ...(parsed as Record<string, unknown>), [scan.jsonKey]: envelope };
  } else {
    outDoc = { [field]: envelope };
  }

  await writeFile(filePath, `${JSON.stringify(outDoc, null, 2)}\n`, "utf8");
  console.error(`Updated: ${filePath}`);
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
